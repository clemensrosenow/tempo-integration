/**
 * Change detection: derive planning Signals from the previous snapshot and
 * the fresh calendar + task state.
 *
 * Interpretation decisions:
 * - Question-kind Tempo events (invitations) are ignored entirely: they are
 *   neither fixed events nor blocks and are not part of the snapshot.
 * - fixed-event-changed: a non-Tempo event was added, removed, moved,
 *   resized, cancelled, or its transparency (Free/Busy) or own RSVP changed.
 *   Title-only edits are not relevant for planning. Events that already
 *   ended are ignored (horizon sliding is not a change).
 * - block-moved-by-user: live start/end of a (not yet ended) Tempo block
 *   differ from tempo.plannedStart/End. Repeats until the engine writes the
 *   learning 'move' (which refreshes plannedStart/End).
 * - block-deleted-by-user: a Tempo block of the previous snapshot that has
 *   not ended yet is missing (or cancelled) now. The engine MUST refresh the
 *   snapshot (takeSnapshot) after its own writes so its deletions are not
 *   mistaken for the user's.
 * - block-ended-open: a block ended after the previous snapshot was taken,
 *   its task is still needsAction, and it was not handled before. No such
 *   signals on the very first run (prev missing).
 * - tasks-changed: new open task, or title / due / status / `updated` of an
 *   open task changed, or a task disappeared (deleted). task-completed when
 *   a task switched to completed.
 */
import type { EventFingerprint, TempoState } from './ports.js';
import type { CalendarEvent, Signal, Task } from './types.js';

export type Snapshot = NonNullable<TempoState['lastSnapshot']>;

export interface DetectSignalsInput {
  prev?: Snapshot;
  events: readonly CalendarEvent[];
  tasks: readonly Task[];
  now: Date;
  handledEndedBlocks: readonly string[];
}

export interface DetectSignalsResult {
  signals: Signal[];
  snapshot: Snapshot;
  handledEndedBlocks: string[];
}

function isQuestionEvent(e: CalendarEvent): boolean {
  return e.tempo?.kind === 'question';
}

function isBlockEvent(e: CalendarEvent): boolean {
  return e.tempo?.kind === 'block';
}

export function fingerprint(e: CalendarEvent): EventFingerprint {
  return {
    id: e.id,
    calendarId: e.calendarId,
    start: e.start.toISOString(),
    end: e.end.toISOString(),
    status: e.status,
    transparency: e.transparency,
    ...(e.selfResponse !== undefined ? { selfResponse: e.selfResponse } : {}),
    updated: e.updated.toISOString(),
    ...(e.tempo ? { tempoTaskId: e.tempo.taskId } : {}),
  };
}

/** Snapshot of the current state; call again after the engine wrote its changes. */
export function takeSnapshot(events: readonly CalendarEvent[], tasks: readonly Task[], now: Date): Snapshot {
  return {
    takenAt: now.toISOString(),
    events: events.filter((e) => !isQuestionEvent(e)).map(fingerprint),
    tasks: tasks.map((t) => ({
      id: t.id,
      status: t.status,
      updated: t.updated.toISOString(),
      ...(t.due ? { due: t.due.toISOString() } : {}),
      title: t.title,
    })),
  };
}

export function detectSignals(input: DetectSignalsInput): DetectSignalsResult {
  const { prev, events, tasks, now } = input;
  const signals: Signal[] = [];
  const handled = new Set(input.handledEndedBlocks);

  if (!prev) signals.push({ type: 'initial' });
  else {
    signals.push(...taskSignals(prev, tasks));
    signals.push(...fixedEventSignals(prev, events, now));
    signals.push(...deletedBlockSignals(prev, events, now));
    signals.push(...endedOpenSignals(prev, events, tasks, now, handled));
  }
  signals.push(...movedBlockSignals(events, now));

  const present = new Set(events.map((e) => e.id));
  return {
    signals,
    snapshot: takeSnapshot(events, tasks, now),
    handledEndedBlocks: [...handled].filter((id) => present.has(id)).sort(),
  };
}

function taskSignals(prev: Snapshot, tasks: readonly Task[]): Signal[] {
  const out: Signal[] = [];
  const prevById = new Map(prev.tasks.map((t) => [t.id, t]));
  const changed: string[] = [];
  for (const t of tasks) {
    const p = prevById.get(t.id);
    if (!p) {
      if (t.status === 'needsAction') changed.push(t.id);
      continue;
    }
    if (t.status === 'completed') {
      if (p.status !== 'completed') out.push({ type: 'task-completed', taskId: t.id });
      continue;
    }
    const due = t.due?.toISOString();
    if (p.status !== t.status || p.title !== t.title || p.due !== due || p.updated !== t.updated.toISOString()) {
      changed.push(t.id);
    }
  }
  const present = new Set(tasks.map((t) => t.id));
  for (const p of prev.tasks) if (!present.has(p.id) && p.status !== 'completed') changed.push(p.id);
  if (changed.length > 0) out.unshift({ type: 'tasks-changed', taskIds: [...new Set(changed)].sort() });
  return out;
}

function fixedEventSignals(prev: Snapshot, events: readonly CalendarEvent[], now: Date): Signal[] {
  const out: Signal[] = [];
  const prevFixed = new Map(prev.events.filter((f) => !f.tempoTaskId).map((f) => [f.id, f]));
  const nowMs = now.getTime();
  const seen = new Set<string>();
  for (const e of events) {
    if (e.tempo) continue;
    seen.add(e.id);
    const p = prevFixed.get(e.id);
    const f = fingerprint(e);
    if (!p) {
      if (e.end.getTime() > nowMs) out.push({ type: 'fixed-event-changed', eventId: e.id });
      continue;
    }
    const relevantChange =
      p.start !== f.start ||
      p.end !== f.end ||
      p.status !== f.status ||
      p.transparency !== f.transparency ||
      p.selfResponse !== f.selfResponse;
    const stillRelevant = Math.max(Date.parse(p.end), e.end.getTime()) > nowMs;
    if (relevantChange && stillRelevant) out.push({ type: 'fixed-event-changed', eventId: e.id });
  }
  for (const p of prevFixed.values()) {
    if (!seen.has(p.id) && Date.parse(p.end) > nowMs) out.push({ type: 'fixed-event-changed', eventId: p.id });
  }
  return out;
}

function deletedBlockSignals(prev: Snapshot, events: readonly CalendarEvent[], now: Date): Signal[] {
  const live = new Map(events.filter(isBlockEvent).map((e) => [e.id, e]));
  const out: Signal[] = [];
  for (const p of prev.events) {
    if (!p.tempoTaskId || Date.parse(p.end) <= now.getTime()) continue;
    const e = live.get(p.id);
    if (!e || e.status === 'cancelled') out.push({ type: 'block-deleted-by-user', eventId: p.id, taskId: p.tempoTaskId });
  }
  return out;
}

function endedOpenSignals(
  prev: Snapshot,
  events: readonly CalendarEvent[],
  tasks: readonly Task[],
  now: Date,
  handled: Set<string>,
): Signal[] {
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const since = Date.parse(prev.takenAt);
  const out: Signal[] = [];
  for (const e of events) {
    if (!isBlockEvent(e) || e.status === 'cancelled' || handled.has(e.id)) continue;
    const end = e.end.getTime();
    if (end > now.getTime() || end <= since) continue;
    const task = taskById.get(e.tempo!.taskId);
    if (task?.status !== 'needsAction') continue;
    handled.add(e.id);
    out.push({ type: 'block-ended-open', eventId: e.id, taskId: task.id });
  }
  return out;
}

function movedBlockSignals(events: readonly CalendarEvent[], now: Date): Signal[] {
  const out: Signal[] = [];
  for (const e of events) {
    if (!isBlockEvent(e) || e.status === 'cancelled' || e.end.getTime() <= now.getTime()) continue;
    const meta = e.tempo!;
    const plannedStart = Date.parse(meta.plannedStart);
    const plannedEnd = Date.parse(meta.plannedEnd);
    if (Number.isNaN(plannedStart) || Number.isNaN(plannedEnd)) continue;
    if (plannedStart === e.start.getTime() && plannedEnd === e.end.getTime()) continue;
    out.push({
      type: 'block-moved-by-user',
      eventId: e.id,
      taskId: meta.taskId,
      from: { start: new Date(plannedStart), end: new Date(plannedEnd) },
      to: { start: e.start, end: e.end },
    });
  }
  return out;
}
