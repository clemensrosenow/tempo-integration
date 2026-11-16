/**
 * TempoEngine — orchestrates one planning "tick":
 *
 *   fetch (Google) → detect signals → poll invitation RSVPs / timeouts
 *   → debounce → planning pipeline → apply changes to the Tempo calendar
 *   → open at most one question (invitation) → persist state.
 *
 * The engine owns all side effects; the planning pipeline is pure.
 * Engine-level decisions (documented here because the spec leaves them open):
 *  - Debounce (E8): if user-originated changes were made less than
 *    `debounceMs` ago, the tick is deferred without updating the snapshot, so
 *    the next tick sees the whole burst as one change. A burst older than
 *    `maxDeferMs` is planned anyway.
 *  - Without a connected organizer account no invitation can be sent. Such
 *    questions expire immediately, which equals "No" (keep plan) — the safe
 *    default of D12 ("doing nothing never causes unwanted change").
 *  - Answered invitations are deleted from the organizer calendar without
 *    e-mail; expired ones stay and get a note in their description (D12).
 */
import type { CalendarPort, InvitePort, LlmPort, StateStore, TasksPort, TempoState } from '../core/ports.js';
import type {
  BlockDraft,
  CalendarEvent,
  EventChange,
  PlanInput,
  PlanOutput,
  Question,
  ResponseStatus,
  Signal,
  Task,
} from '../core/types.js';
import { DEBOUNCE_MS } from '../core/types.js';
import { runPlanningPipeline } from '../core/pipeline.js';
import { detectSignals } from '../core/signals.js';
import { handleAnswer } from '../core/questions.js';
import { planningPrefsKey } from '../settings/settings.js';

export interface EngineConfig {
  horizonDays: number;
  debounceMs?: number;
  /** Plan anyway if a burst keeps going longer than this. */
  maxDeferMs?: number;
  /** Re-plan without any signal at most this often (keeps the plan fresh as time passes). */
  periodicReplanMs?: number;
  /** How far back non-Tempo events are read (for "block ended while task open"). */
  lookbackHours?: number;
  /** How far back Tempo blocks are read, so minutes already worked on long tasks are counted. */
  tempoLookbackDays?: number;
}

export interface EngineDeps {
  calendar: CalendarPort;
  tasks: TasksPort;
  /** Organizer account; optional — without it questions cannot be asked. */
  invites?: InvitePort;
  llm: LlmPort;
  store: StateStore;
  config: EngineConfig;
  clock?: () => Date;
  log?: (line: string) => void;
  /** Injectable for tests. */
  pipeline?: (input: PlanInput, llm: LlmPort) => Promise<PlanOutput>;
}

export type TickOutcome = 'planned' | 'deferred' | 'idle';

export interface TickReport {
  outcome: TickOutcome;
  now: Date;
  signals: Signal[];
  applied: EventChange[];
  failed: Array<{ change: EventChange; error: string }>;
  questionsOpened: Question[];
  questionsClosed: Question[];
  log: string[];
}

const USER_SIGNAL_TYPES = new Set<Signal['type']>([
  'tasks-changed',
  'task-completed',
  'fixed-event-changed',
  'block-moved-by-user',
  'block-deleted-by-user',
]);

/** Tempo's own writes during one tick, used to build the post-write snapshot. */
interface OwnWrites {
  upserted: Map<string, CalendarEvent>;
  deleted: Set<string>;
}

export class TempoEngine {
  private readonly clock: () => Date;
  private readonly logFn: (line: string) => void;
  private readonly pipeline: (input: PlanInput, llm: LlmPort) => Promise<PlanOutput>;
  private running: Promise<TickReport> | null = null;

  constructor(private readonly deps: EngineDeps) {
    this.clock = deps.clock ?? (() => new Date());
    this.logFn = deps.log ?? (() => {});
    this.pipeline = deps.pipeline ?? runPlanningPipeline;
  }

  /** Run one tick. Concurrent calls share the in-flight tick (webhook + poller safe). */
  tick(opts: { force?: boolean } = {}): Promise<TickReport> {
    if (!this.running) {
      this.running = this.doTick(opts).finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async doTick(opts: { force?: boolean }): Promise<TickReport> {
    const { calendar, tasks: tasksPort, store, config } = this.deps;
    const now = this.clock();
    const log: string[] = [];
    const say = (line: string) => {
      log.push(line);
      this.logFn(line);
    };
    const report: TickReport = {
      outcome: 'idle',
      now,
      signals: [],
      applied: [],
      failed: [],
      questionsOpened: [],
      questionsClosed: [],
      log,
    };

    const state = await store.load();
    const { prefs, tempoCalendarId, userEmail } = state;
    if (!prefs || !tempoCalendarId || !userEmail) {
      throw new Error('Tempo is not set up yet. Run `tempo setup` first.');
    }

    // 1. Fetch -------------------------------------------------------------
    const events = await this.fetchEvents(state, now);
    const tasks = await tasksPort.listTasks({ completedSinceDays: 7 });

    // 2. Signals from calendar/tasks diff ------------------------------------
    const detected = detectSignals({
      prev: state.lastSnapshot,
      events,
      tasks,
      now,
      handledEndedBlocks: state.handledEndedBlocks,
    });
    const signals: Signal[] = [...detected.signals];

    // 3. Question answers / timeouts ------------------------------------------
    signals.push(...(await this.questionSignals(state, now, say)));
    report.signals = signals;

    // 4. Debounce (E8) ----------------------------------------------------------
    const userSignals = signals.filter((s) => USER_SIGNAL_TYPES.has(s.type));
    if (userSignals.length > 0 && !opts.force) {
      const lastEdit = latestUserEdit(events, tasks, state.lastSnapshot);
      const debounceMs = config.debounceMs ?? DEBOUNCE_MS;
      const maxDeferMs = config.maxDeferMs ?? 10 * 60_000;
      const pendingSince = state.pendingSince ? new Date(state.pendingSince) : now;
      const quietFor = lastEdit ? now.getTime() - lastEdit.getTime() : Infinity;
      const pendingFor = now.getTime() - pendingSince.getTime();
      if (quietFor < debounceMs && pendingFor < maxDeferMs) {
        state.pendingSince = pendingSince.toISOString();
        await store.save(state);
        say(`debounce: ${userSignals.length} change(s), waiting for ${Math.round((debounceMs - quietFor) / 1000)}s of quiet`);
        report.outcome = 'deferred';
        return report;
      }
    }

    // 5. Decide whether to plan at all ----------------------------------------
    // Settings edited (working hours, busy calendars …): re-plan everything now.
    const prefsKey = planningPrefsKey(prefs);
    if (state.prefsKey !== undefined && state.prefsKey !== prefsKey) {
      say('settings changed: re-planning');
      signals.push({ type: 'settings-changed' });
    }
    state.prefsKey = prefsKey;
    const periodicMs = config.periodicReplanMs ?? 15 * 60_000;
    const lastPlanAt = state.lastPlanAt ? new Date(state.lastPlanAt).getTime() : 0;
    if (signals.length === 0) {
      if (!opts.force && now.getTime() - lastPlanAt < periodicMs) {
        report.outcome = 'idle';
        state.lastSnapshot = detected.snapshot;
        state.handledEndedBlocks = detected.handledEndedBlocks;
        delete state.pendingSince;
        await store.save(state);
        return report;
      }
      signals.push({ type: 'periodic' });
    }

    // 6. Plan -------------------------------------------------------------------
    const input: PlanInput = {
      now,
      events,
      tasks,
      prefs,
      signals,
      estimates: state.estimates,
      openQuestion: state.questions.find((q) => q.status === 'open'),
      queuedQuestions: state.questions.filter((q) => q.status === 'queued'),
      horizonDays: config.horizonDays,
    };
    const output = await this.pipeline(input, this.deps.llm);
    for (const line of output.log) say(`pipeline: ${line}`);

    // 7. Apply changes to the Tempo calendar ----------------------------------
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    const eventsById = new Map(events.map((e) => [e.id, e]));
    const writes: OwnWrites = { upserted: new Map(), deleted: new Set() };
    for (const change of output.apply) {
      try {
        await this.applyChange(tempoCalendarId, change, tasksById, eventsById, writes);
        report.applied.push(change);
      } catch (err) {
        const error = errorMessage(err);
        report.failed.push({ change, error });
        say(`apply ${change.op} failed: ${error}`);
      }
    }

    // 7b. Keep block titles in sync with renamed Google Tasks.
    for (const ev of events) {
      if (ev.tempo?.kind !== 'block' || ev.end <= now || writes.deleted.has(ev.id)) continue;
      const task = tasksById.get(ev.tempo.taskId);
      const current = writes.upserted.get(ev.id) ?? ev;
      if (!task || task.status !== 'needsAction' || current.title === task.title) continue;
      try {
        writes.upserted.set(ev.id, await calendar.updateBlock(tempoCalendarId, ev.id, { title: task.title }));
      } catch (err) {
        if (!isNotFound(err)) say(`could not rename block ${ev.id}: ${errorMessage(err)}`);
      }
    }

    // 8. Questions: persist updates, close answered ones, open the next one ---
    state.estimates = { ...state.estimates, ...output.estimates };
    if (output.learned) prefs.learned = output.learned;
    report.questionsClosed = await this.closeQuestions(state, output.updatedQuestions, now, say);
    // The pipeline marks the most severe new question 'open' ("send now"); the
    // engine sends it only after a successful invitation, so it is queued first.
    // A Maybe follow-up ("other time") must be asked next (E10), before any older queued question.
    const maybeTasks = new Set(output.updatedQuestions.filter((q) => q.status === 'maybe').map((q) => q.taskId));
    const preferred = new Set(
      output.questions.filter((q) => q.status === 'open' || maybeTasks.has(q.taskId)).map((q) => q.id),
    );
    for (const q of output.questions) {
      if (!state.questions.some((existing) => existing.id === q.id)) {
        state.questions.push({ ...q, status: q.status === 'open' ? 'queued' : q.status });
      }
    }
    const opened = await this.openNextQuestion(state, tempoCalendarId, userEmail, now, say, preferred, writes);
    if (opened) report.questionsOpened.push(opened);

    // 9. Snapshot = what we read + exactly our own writes. Not a re-fetch: user edits
    //    made while this tick ran must still show up as changes on the next tick.
    //    `takenAt` = detection instant, so blocks ending during the tick are not missed.
    const finalEvents = [
      ...events.filter((e) => !writes.deleted.has(e.id) && !writes.upserted.has(e.id)),
      ...writes.upserted.values(),
    ];
    const finalSnapshot = detectSignals({
      prev: undefined,
      events: finalEvents,
      tasks,
      now,
      handledEndedBlocks: detected.handledEndedBlocks,
    });
    state.lastSnapshot = finalSnapshot.snapshot;
    state.handledEndedBlocks = pruneHandled(detected.handledEndedBlocks, finalEvents);
    state.lastPlanAt = now.toISOString();
    delete state.pendingSince;
    state.questions = pruneQuestions(state.questions, now);
    await store.save(state);

    report.outcome = 'planned';
    say(
      `tick done: ${signals.map((s) => s.type).join(', ')} → ${report.applied.length} change(s)` +
        (report.failed.length ? `, ${report.failed.length} failed` : '') +
        (opened ? `, asked "${opened.title}"` : ''),
    );
    return report;
  }

  // -------------------------------------------------------------------------

  private async fetchEvents(state: TempoState, now: Date): Promise<CalendarEvent[]> {
    const prefs = state.prefs!;
    const tempoId = state.tempoCalendarId!;
    const end = new Date(now.getTime() + this.deps.config.horizonDays * 86_400_000);
    const lookbackMs = (this.deps.config.lookbackHours ?? 24) * 3_600_000;
    const tempoLookbackMs = (this.deps.config.tempoLookbackDays ?? 30) * 86_400_000;
    const others = unique(prefs.selectedCalendarIds).filter((id) => id !== tempoId);
    const [fixed, blocks] = await Promise.all([
      others.length
        ? this.deps.calendar.listEvents(others, { start: new Date(now.getTime() - lookbackMs), end })
        : Promise.resolve([]),
      // Long lookback for Tempo blocks: past blocks = minutes already worked on a task.
      this.deps.calendar.listEvents([tempoId], { start: new Date(now.getTime() - tempoLookbackMs), end }),
    ]);
    return [...fixed, ...blocks];
  }

  private async questionSignals(state: TempoState, now: Date, say: (l: string) => void): Promise<Signal[]> {
    const open = state.questions.find((q) => q.status === 'open');
    if (!open) return [];
    let response: ResponseStatus = 'needsAction';
    if (this.deps.invites && open.inviteEventId) {
      try {
        response = await this.deps.invites.getResponse(open.inviteEventId, state.userEmail!);
      } catch (err) {
        say(`could not read RSVP for "${open.title}": ${errorMessage(err)}`);
      }
    }
    const answer = rsvpToAnswer(response);
    if (answer) {
      say(`question "${open.title}" answered: ${answer}`);
      return [{ type: 'question-answered', questionId: open.id, answer }];
    }
    if (now.getTime() >= new Date(open.answerBy).getTime()) {
      say(`question "${open.title}" timed out → No`);
      return [{ type: 'question-timeout', questionId: open.id }];
    }
    return [];
  }

  private async applyChange(
    tempoCalendarId: string,
    change: EventChange,
    tasksById: Map<string, Task>,
    eventsById: Map<string, CalendarEvent>,
    writes: OwnWrites,
  ): Promise<void> {
    const { calendar } = this.deps;
    switch (change.op) {
      case 'create': {
        const ev = await calendar.createBlock(tempoCalendarId, change.block);
        writes.upserted.set(ev.id, ev);
        return;
      }
      case 'delete':
        try {
          await calendar.deleteBlock(tempoCalendarId, change.eventId);
        } catch (err) {
          if (!isNotFound(err)) throw err;
        }
        writes.deleted.add(change.eventId);
        writes.upserted.delete(change.eventId);
        return;
      case 'move':
        try {
          const ev = await calendar.updateBlock(tempoCalendarId, change.eventId, {
            start: change.to.start,
            end: change.to.end,
            reason: change.reason,
            learned: change.learned,
          });
          writes.upserted.set(ev.id, ev);
        } catch (err) {
          if (!isNotFound(err)) throw err;
          // The block vanished (e.g. replaced by a question or deleted meanwhile): recreate it.
          const task = tasksById.get(change.taskId);
          const old = eventsById.get(change.eventId);
          const block: BlockDraft = {
            taskId: change.taskId,
            taskListId: task?.listId ?? old?.tempo?.taskListId ?? '',
            title: task?.title ?? old?.title ?? 'Tempo block',
            start: change.to.start,
            end: change.to.end,
            reason: change.reason,
            learned: change.learned,
          };
          const ev = await calendar.createBlock(tempoCalendarId, block);
          writes.deleted.add(change.eventId);
          writes.upserted.set(ev.id, ev);
        }
        return;
    }
  }

  private async closeQuestions(
    state: TempoState,
    updated: Question[],
    now: Date,
    say: (l: string) => void,
  ): Promise<Question[]> {
    const closed: Question[] = [];
    for (const q of updated) {
      const idx = state.questions.findIndex((existing) => existing.id === q.id);
      const prev = idx >= 0 ? state.questions[idx] : undefined;
      const merged: Question = { ...prev, ...q, inviteEventId: q.inviteEventId ?? prev?.inviteEventId };
      if (idx >= 0) state.questions[idx] = merged;
      else state.questions.push(merged);
      if (merged.status === 'open' || merged.status === 'queued') continue;
      closed.push(merged);
      if (!this.deps.invites || !merged.inviteEventId) continue;
      try {
        if (merged.status === 'expired') {
          await this.deps.invites.annotate(
            merged.inviteEventId,
            `${merged.description}\n\nNo answer by ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC — Tempo kept your plan.`,
          );
        } else {
          await this.deps.invites.cancel(merged.inviteEventId);
        }
      } catch (err) {
        say(`could not close invitation "${merged.title}": ${errorMessage(err)}`);
      }
    }
    return closed;
  }

  private async openNextQuestion(
    state: TempoState,
    tempoCalendarId: string,
    userEmail: string,
    now: Date,
    say: (l: string) => void,
    preferred: Set<string>,
    writes: OwnWrites,
  ): Promise<Question | undefined> {
    // A question that can never be asked counts as "No" (D12) — with its learning
    // effects, so the pipeline does not hold the same proposal back forever.
    const expireUnasked = (q: Question, why: string) => {
      const res = handleAnswer(q, 'timeout', {
        now,
        learned: state.prefs!.learned,
        estimates: state.estimates,
        tz: state.prefs!.timezone,
      });
      Object.assign(q, res.updated, { status: 'expired' });
      say(why);
    };
    if (state.questions.some((q) => q.status === 'open')) return undefined;
    const queue = state.questions
      .filter((q) => q.status === 'queued')
      .sort(
        (a, b) =>
          Number(preferred.has(b.id)) - Number(preferred.has(a.id)) ||
          new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      );
    for (const q of queue) {
      if (new Date(q.answerBy).getTime() <= now.getTime()) {
        expireUnasked(q, `queued question "${q.title}" expired before it could be asked`);
        continue;
      }
      if (!this.deps.invites) {
        expireUnasked(
          q,
          `no organizer account connected — cannot ask "${q.title}", keeping the plan (run \`tempo login --organizer\`)`,
        );
        continue;
      }
      // The invitation replaces the affected block(s) while open (D11).
      for (const eventId of q.replacedEventIds ?? []) {
        try {
          await this.deps.calendar.deleteBlock(tempoCalendarId, eventId);
          writes.deleted.add(eventId);
        } catch (err) {
          if (isNotFound(err)) writes.deleted.add(eventId);
          else say(`could not hide block ${eventId}: ${errorMessage(err)}`);
        }
      }
      try {
        q.inviteEventId = await this.deps.invites.sendQuestion(q, userEmail);
        q.status = 'open';
        say(`asked: "${q.title}" (answer by ${new Date(q.answerBy).toISOString()})`);
        return q;
      } catch (err) {
        for (const block of q.replacedBlocks ?? []) {
          const ev = await this.deps.calendar.createBlock(tempoCalendarId, block).catch(() => undefined);
          if (ev) writes.upserted.set(ev.id, ev);
        }
        expireUnasked(q, `sending invitation failed: ${errorMessage(err)} — blocks restored, plan kept`);
      }
    }
    return undefined;
  }
}

// ---------------------------------------------------------------------------

export function rsvpToAnswer(r: ResponseStatus): 'yes' | 'no' | 'maybe' | undefined {
  switch (r) {
    case 'accepted':
      return 'yes';
    case 'declined':
      return 'no';
    case 'tentative':
      return 'maybe';
    default:
      return undefined;
  }
}

/**
 * Most recent `updated` stamp among events/tasks that differ from the last
 * snapshot. Tempo's own writes are part of the snapshot (same `updated`), so
 * they never count as user edits — no clock comparison between us and Google.
 */
function latestUserEdit(events: CalendarEvent[], tasks: Task[], prev: TempoState['lastSnapshot']): Date | undefined {
  const seenEvents = new Set((prev?.events ?? []).map((e) => `${e.id}|${new Date(e.updated).getTime()}`));
  const seenTasks = new Set((prev?.tasks ?? []).map((t) => `${t.id}|${new Date(t.updated).getTime()}`));
  let latest = 0;
  for (const e of events) {
    if (!seenEvents.has(`${e.id}|${e.updated.getTime()}`)) latest = Math.max(latest, e.updated.getTime());
  }
  for (const t of tasks) {
    if (!seenTasks.has(`${t.id}|${t.updated.getTime()}`)) latest = Math.max(latest, t.updated.getTime());
  }
  return latest > 0 ? new Date(latest) : undefined;
}

function pruneHandled(handled: string[], events: CalendarEvent[]): string[] {
  const ids = new Set(events.map((e) => e.id));
  return handled.filter((id) => ids.has(id));
}

/** Keep open/queued questions and closed ones from the last 14 days (history for learning/debug). */
function pruneQuestions(questions: Question[], now: Date): Question[] {
  const cutoff = now.getTime() - 14 * 86_400_000;
  return questions.filter(
    (q) => q.status === 'open' || q.status === 'queued' || new Date(q.createdAt).getTime() >= cutoff,
  );
}

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: unknown; status?: unknown; response?: { status?: unknown } } | null;
  const code = e?.code ?? e?.status ?? e?.response?.status;
  return code === 404 || code === 410 || code === '404' || code === '410';
}
