/**
 * Step 5a — Diff: turn the target placement + current Tempo blocks into
 * minimal EventChange[] (reuse existing event ids via 'move' instead of
 * delete + create).
 *
 * Lock-window rule (E8) and its one exception — DECISION:
 * - Past blocks (end <= now) are never touched.
 * - Blocks that are running or start within the next hour (lock window) are
 *   pinned: never moved, resized or deleted by re-planning.
 * - EXCEPTION: a locked block that now overlaps a busy fixed event (e.g. a
 *   meeting ran over into it) is "released" and may be moved OUT of the
 *   conflict. Leaving it in place would show two things at once, which is the
 *   very situation repair exists for.
 * - Nothing is ever moved INTO or created inside the lock window: gaps start at
 *   now + 1h, and diffBlocks drops (and logs) any change whose target starts
 *   before that, as a last line of defence.
 * - Deleting future blocks of a checked-off task is done by the pipeline even
 *   inside the lock window (the work is done; showing it would be wrong).
 */
import { lockEnd, isLockedBlock, isReleasedLockedBlock } from './gaps.js';
import { sameRange, sortRanges } from './time.js';
import type { CurrentBlock } from './planModel.js';
import type { Placement } from './ports.js';
import type { CalendarEvent, EventChange, TimeRange } from './types.js';

export interface ClassifyInput {
  now: Date;
  /** Tempo block events (kind 'block'). */
  blocks: readonly CalendarEvent[];
  /** Busy fixed events (raw ranges). */
  busy: readonly TimeRange[];
  /** Event ids pinned this run, with reason (user just moved it, answer just placed it). */
  pinnedEvents?: ReadonlyMap<string, string>;
  /** Task ids whose blocks are all pinned, with reason (frozen by open question, kept after "No"). */
  pinnedTasks?: ReadonlyMap<string, string>;
}

export function classifyBlocks(input: ClassifyInput): CurrentBlock[] {
  const { now } = input;
  return input.blocks
    .filter((e) => e.tempo?.kind === 'block' && e.status !== 'cancelled')
    .map((e): CurrentBlock => {
      const meta = e.tempo!;
      const base = {
        eventId: e.id,
        taskId: meta.taskId,
        taskListId: meta.taskListId,
        title: e.title,
        start: e.start,
        end: e.end,
        ...(meta.part !== undefined ? { part: meta.part } : {}),
      };
      if (e.end.getTime() <= now.getTime()) return { ...base, status: 'past' };
      const eventPin = input.pinnedEvents?.get(e.id);
      if (eventPin) return { ...base, status: 'pinned', pinReason: eventPin };
      const taskPin = input.pinnedTasks?.get(meta.taskId);
      if (taskPin) return { ...base, status: 'pinned', pinReason: taskPin };
      if (isLockedBlock(e, now) && !isReleasedLockedBlock(e, now, input.busy)) {
        return { ...base, status: 'pinned', pinReason: 'lock window' };
      }
      return { ...base, status: 'movable' };
    });
}

export interface DiffInput {
  now: Date;
  /** Current blocks; only 'movable' ones are diffed. */
  current: readonly CurrentBlock[];
  /** Target placements for movable demand. */
  target: readonly Placement[];
  /** Task titles / list ids for new blocks. */
  tasks: ReadonlyMap<string, { title: string; listId: string }>;
}

export interface DiffResult {
  changes: EventChange[];
  log: string[];
}

export function diffBlocks(input: DiffInput): DiffResult {
  const lock = lockEnd(input.now);
  const changes: EventChange[] = [];
  const log: string[] = [];
  const movable = input.current.filter((b) => b.status === 'movable');
  const taskIds = [...new Set([...movable.map((b) => b.taskId), ...input.target.map((p) => p.taskId)])].sort();

  for (const taskId of taskIds) {
    const cur = sortRanges(movable.filter((b) => b.taskId === taskId));
    const tgt = sortRanges(input.target.filter((p) => p.taskId === taskId));
    const unmatchedCur = cur.filter((c) => !tgt.some((t) => sameRange(t, c)));
    const unmatchedTgt = tgt.filter((t) => !cur.some((c) => sameRange(t, c)));
    const finalRanges = sortRanges([
      ...input.current.filter((b) => b.taskId === taskId && b.status === 'pinned'),
      ...tgt,
    ]);
    const n = Math.min(unmatchedCur.length, unmatchedTgt.length);
    for (let i = 0; i < unmatchedTgt.length; i++) {
      const to = unmatchedTgt[i]!;
      if (to.start.getTime() < lock.getTime()) {
        log.push(`diff: refused to place ${taskId} inside the lock window (${to.start.toISOString()})`);
        continue;
      }
      const from = i < n ? unmatchedCur[i] : undefined;
      if (from) {
        changes.push({
          op: 'move',
          eventId: from.eventId,
          taskId,
          from: { start: from.start, end: from.end },
          to: { start: to.start, end: to.end },
        });
      } else {
        const meta = input.tasks.get(taskId);
        const part = finalRanges.findIndex((r) => sameRange(r, to));
        changes.push({
          op: 'create',
          block: {
            taskId,
            taskListId: meta?.listId ?? cur[0]?.taskListId ?? '',
            title: meta?.title ?? cur[0]?.title ?? taskId,
            start: to.start,
            end: to.end,
            ...(finalRanges.length > 1 && part >= 0 ? { part } : {}),
          },
        });
      }
    }
    for (const extra of unmatchedCur.slice(n)) {
      changes.push({ op: 'delete', eventId: extra.eventId, taskId });
    }
  }
  return { changes, log };
}

/** The range a change ends up at (move/create), if any. */
export function changeTarget(c: EventChange): TimeRange | undefined {
  if (c.op === 'move') return c.to;
  if (c.op === 'create') return { start: c.block.start, end: c.block.end };
  return undefined;
}

export function changeTaskId(c: EventChange): string {
  return c.op === 'create' ? c.block.taskId : c.taskId;
}
