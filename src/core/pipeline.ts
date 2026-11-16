/**
 * The planning pipeline (spec "Planning pipeline") — the single test seam:
 * calendar snapshot + tasks + preferences + signals + now  →  event changes,
 * questions, reasons.
 *
 *   0. Answers      question-answered / question-timeout first (Yes/No/Maybe/timeout)
 *      Signals      learning from drags/resizes, ended blocks, done tasks
 *   1. Understand   llm.understand for new/changed tasks; learned overrides
 *   2. Find gaps    gaps.ts
 *   3. Place        llm.place  → 4. Check (max 2 retries) → greedy fallback
 *   5. Diff+Decide  diff.ts + decide.ts (+ questions.ts)
 *   6. Explain      llm.explain, template fallback; every change carries a reason
 *
 * Interpretation decisions (beyond those in the step modules):
 * - Subtasks are the atomic steps; a parent with open subtasks is planned only
 *   through them (its own blocks are removed). A parent whose subtasks are all
 *   done is planned like a normal task. Subtasks inherit the parent's due
 *   (min of both if a subtask has its own).
 * - Need = max(total - worked, minChunk) once some work was done (worked = past
 *   blocks), minus pinned future blocks. To keep the plan stable, a need that
 *   differs from the currently planned movable minutes by < 15 min is snapped
 *   to the current amount (so a small learned scale change does not ripple
 *   through every block).
 * - Pinned this run (never re-placed, subtracted from gaps): lock-window blocks
 *   (unless a busy event overlaps them), blocks the user just moved, blocks
 *   just placed by an answer, blocks of the open question's task(s)
 *   ("frozen"), and blocks of tasks with a rejected proposal ("No = keep").
 *   A rejection is cleared when the user edits the task (tasks-changed) or a
 *   kept block ends with the task still open. The dropped marker
 *   (taskDurationMin = 0) is also cleared by tasks-changed.
 * - While a question is open its slot, replaced blocks and proposal targets
 *   are reserved, so neither Yes nor No can collide with newly placed blocks.
 * - Missed-due / dropped tasks keep their current blocks while asking; the rest
 *   of the plan is re-placed around them (phase 2), and their options are
 *   computed in the space that is left.
 * - Done tasks: future blocks (not yet started — also inside the lock window)
 *   are deleted with "Done — task checked off"; blocks of tasks that no longer
 *   exist are deleted too.
 * - Stability: if no signal other than 'periodic' arrived and the current plan
 *   passes Check, nothing changes and llm.place is not called.
 * - block-deleted-by-user: the task is re-planned (cause "you removed a block")
 *   and avoids the deleted slot in that run — deleting means "not there".
 * - "Lateness already accepted" (blocks after the due are kept without a new
 *   question) never applies in a run where the task or its parent changed:
 *   a due date pulled earlier must be re-checked.
 * - LLM failures (exceptions) never break planning: understand falls back to a
 *   neutral estimate (not cached), place to greedy, explain to templates.
 * - Questions refreshed under an existing queued id are returned in
 *   `updatedQuestions` (upsert), brand-new ones in `questions`.
 */
import { checkPlacements, type CheckContext } from './check.js';
import { decide, detectBigChange } from './decide.js';
import { classifyBlocks, diffBlocks, changeTaskId } from './diff.js';
import { busyFixedRanges, findGaps } from './gaps.js';
import { assessPlacements, greedyPlace, type GreedyResult } from './greedyPlacer.js';
import { learnFromEndedBlock, learnFromUserMove, remainingNeedMin, scaledDurationMin } from './learning.js';
import type { CurrentBlock, PlacementOption, PlanItem, TaskBlock } from './planModel.js';
import type { ExplainRequest, LlmPort, Placement, PlaceRequest } from './ports.js';
import {
  buildDroppedQuestion,
  buildMissedDueQuestion,
  buildUnclearPriorityQuestion,
  handleAnswer,
  isAskableSlot,
  nextWorkingSlot,
} from './questions.js';
import {
  addMinutes,
  durationMin,
  formatLocalDay,
  maxDate,
  overlaps,
  roundMinutes,
  sortRanges,
  subtractRanges,
} from './time.js';
import type {
  CalendarEvent,
  EventChange,
  LearnedPreferences,
  PlanInput,
  PlanOutput,
  Preferences,
  Question,
  Signal,
  Task,
  TaskEstimate,
  TimeRange,
} from './types.js';

type CachedEstimate = TaskEstimate & { estimatedAt: string };

export const NEED_TOLERANCE_MIN = 15;
export const MAX_PLACE_RETRIES = 2;
export const UNCLEAR_CONFIDENCE = 0.5;
const MAX_OPTIONS = 4;

const DEFAULT_ESTIMATE: Omit<TaskEstimate, 'taskId'> = {
  durationMin: 60,
  priority: 3,
  urgency: 2,
  confidence: 1,
  minChunkMin: 30,
  deepWork: false,
  rationale: 'default (no estimate available)',
};

// ---------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------

interface Run {
  input: PlanInput;
  now: Date;
  tz: string;
  prefs: Preferences;
  learned: LearnedPreferences;
  learnedChanged: boolean;
  /** Persistent estimate cache (output). */
  estimates: Record<string, CachedEstimate>;
  /** Estimates used in this run (cache + uncached fallbacks). */
  runEstimates: Map<string, TaskEstimate>;
  log: string[];
  /** Changes applied regardless of the decide step (answers, learning, done tasks). */
  alwaysApply: EventChange[];
  updatedQuestions: Question[];
  openQuestion?: Question;
  followUp?: Question;
  pinnedEvents: Map<string, string>;
  virtualPinned: TaskBlock[];
  removedEventIds: Set<string>;
  movedEvents: Map<string, TimeRange>;
  taskCauses: Map<string, string>;
  tasks: Map<string, Task>;
}

function createRun(input: PlanInput): Run {
  const learned = structuredClone(input.prefs.learned);
  return {
    input,
    now: input.now,
    tz: input.prefs.timezone,
    prefs: { ...input.prefs, learned },
    learned,
    learnedChanged: false,
    estimates: { ...input.estimates },
    runEstimates: new Map(),
    log: [],
    alwaysApply: [],
    updatedQuestions: [],
    ...(input.openQuestion ? { openQuestion: input.openQuestion } : {}),
    pinnedEvents: new Map(),
    virtualPinned: [],
    removedEventIds: new Set(),
    movedEvents: new Map(),
    taskCauses: new Map(),
    tasks: new Map(input.tasks.map((t) => [t.id, t])),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runPlanningPipeline(input: PlanInput, llm: LlmPort): Promise<PlanOutput> {
  const run = createRun(input);
  run.log.push(`run at ${run.now.toISOString()} with signals: ${input.signals.map((s) => s.type).join(', ') || '(none)'}`);

  processAnswers(run);
  processTaskSignals(run);
  removeDoneBlocks(run);
  processUserMoves(run);
  await understand(run, llm);

  const frozen = frozenTaskIds(run);
  const events = effectiveEvents(run);
  const busy = busyFixedRanges(events);
  const pinnedTasks = pinnedTaskMap(run, frozen);
  const current = classifyBlocks({
    now: run.now,
    blocks: events.filter((e) => e.tempo?.kind === 'block'),
    busy,
    pinnedEvents: run.pinnedEvents,
    pinnedTasks,
  });
  for (const b of current) b.title = run.tasks.get(b.taskId)?.title ?? b.title;
  const items = buildItems(run, current, pinnedTasks);
  const pinned = pinnedBlocks(run, current);
  const gaps = findGaps({
    now: run.now,
    events,
    prefs: run.prefs,
    horizonDays: input.horizonDays,
    frozenTaskIds: frozen,
    // The open question's proposal may cover blocks of later work (they make
    // room only on Yes). Those blocks stay valid; only the rest is reserved.
    reserved: [...pinned, ...subtractRanges(questionReservations(run), current.filter((b) => b.status === 'movable'))],
  });
  const movable = current.filter((b) => b.status === 'movable');
  const horizonEnd = addMinutes(run.now, input.horizonDays * 24 * 60);
  run.log.push(
    `items: ${items.filter((i) => i.needMin > 0).map((i) => `${i.taskId}=${i.needMin}min`).join(', ') || '(none)'}; ` +
      `gaps: ${gaps.length}; movable blocks: ${movable.length}; pinned: ${pinned.length}`,
  );

  const oracle = greedyPlace({ now: run.now, prefs: run.prefs, items, gaps, existing: movable, pinned, horizonEnd });
  const checkCtx: CheckContext = {
    now: run.now,
    prefs: run.prefs,
    items,
    gaps,
    busy,
    pinned,
    allowLate: new Set([...oracle.late, ...items.filter((i) => i.lateOk).map((i) => i.taskId)]),
    allowShort: new Set(Object.keys(oracle.unplacedMin)),
  };

  if (isStable(run, movable, checkCtx)) {
    run.log.push('stable: only periodic signal and the current plan is valid → no changes');
    return output(run, [], { questions: [], superseded: [] });
  }

  const placed = await place(run, llm, { items, gaps, movable, checkCtx, oracle });
  const outcome = placed.source === 'llm' ? assessPlacements(items, placed.placements, horizonEnd) : oracle;

  // Tasks that need a question keep their current blocks; re-plan the rest around them.
  const itemById = new Map(items.map((i) => [i.taskId, i]));
  const droppedIds = outcome.dropped;
  const missedIds = outcome.late.filter((id) => !itemById.get(id)?.lateOk && !droppedIds.includes(id));
  const heldIds = new Set([...missedIds, ...droppedIds]);
  let target = placed.placements;
  let finalCurrent = current;
  const heldBlocks = movable.filter((b) => heldIds.has(b.taskId));
  if (heldIds.size > 0) {
    run.log.push(`held for questions: ${[...heldIds].join(', ')}`);
    finalCurrent = current.map((b) =>
      heldIds.has(b.taskId) && b.status === 'movable' ? { ...b, status: 'pinned', pinReason: 'question pending' } : b,
    );
    const phase2 = greedyPlace({
      now: run.now,
      prefs: run.prefs,
      items: items.map((i) => (heldIds.has(i.taskId) ? { ...i, needMin: 0 } : i)),
      gaps: subtractRanges(gaps, heldBlocks),
      existing: target.filter((p) => !heldIds.has(p.taskId)),
      pinned: [...pinned, ...heldBlocks],
      horizonEnd,
    });
    target = phase2.placements;
  }

  const taskQuestions: Question[] = [
    ...missedIds.flatMap((id) => missedDueQuestion(run, itemById.get(id)!, { gaps, target, heldBlocks, pinned, items, horizonEnd, movable })),
    ...droppedIds.map((id) =>
      buildDroppedQuestion({
        now: run.now,
        prefs: run.prefs,
        item: itemById.get(id)!,
        replaced: heldBlocks.filter((b) => b.taskId === id),
        horizonDays: input.horizonDays,
        needMin: itemById.get(id)!.needMin,
      }),
    ),
    ...unclearPriorityQuestions(run, items, target, finalCurrent, heldIds, pinnedTasks),
  ];

  let diff = diffBlocks({ now: run.now, current: finalCurrent, target: mergeAdjacent(target), tasks: taskMeta(run, current) });
  // Stability (E8): if the re-plan moves existing blocks, first try to fit the
  // new demand around the current plan. Only if that leaves a task late or
  // unplanned are the moves (and possibly a big-change question) worth it.
  if (diff.changes.some((c) => c.op === 'move')) {
    const stillMovable = finalCurrent.filter((b) => b.status === 'movable');
    const conservative = greedyPlace({
      now: run.now,
      prefs: run.prefs,
      items: items.map((i) => (heldIds.has(i.taskId) ? { ...i, needMin: 0 } : i)),
      gaps: subtractRanges(gaps, heldBlocks),
      existing: stillMovable,
      pinned: [...pinned, ...heldBlocks],
      horizonEnd,
      keepExistingFirst: true,
    });
    const noWorse =
      conservative.late.every((id) => heldIds.has(id) || outcome.late.includes(id)) &&
      conservative.dropped.every((id) => heldIds.has(id) || outcome.dropped.includes(id));
    if (noWorse) {
      const alt = diffBlocks({ now: run.now, current: finalCurrent, target: mergeAdjacent(conservative.placements), tasks: taskMeta(run, current) });
      const movesOf = (cs: readonly EventChange[]) => cs.filter((c) => c.op === 'move').length;
      if (movesOf(alt.changes) < movesOf(diff.changes)) {
        run.log.push(
          detectBigChange(diff.changes)
            ? 'big change avoided: the new demand fits around the current plan'
            : 'kept existing blocks: the new demand fits around them',
        );
        target = conservative.placements;
        diff = alt;
      }
    }
  }
  run.log.push(...diff.log);
  const decision = decide({
    now: run.now,
    prefs: run.prefs,
    planned: diff.changes,
    current: finalCurrent,
    taskQuestions,
    cause: globalCause(run.input.signals),
    acceptedRanges: run.virtualPinned,
    editedTaskIds: new Set(run.input.tasks.filter((t) => changedThisRun(run, t)).map((t) => t.id)),
    rescueEventIds: new Set(
      diff.changes.flatMap((c) => {
        if (c.op !== 'move') return [];
        const due = itemById.get(c.taskId)?.due;
        return due && c.from.end.getTime() > due.getTime() && c.to.end.getTime() <= due.getTime() ? [c.eventId] : [];
      }),
    ),
    ...(run.openQuestion ? { openQuestion: run.openQuestion } : {}),
    ...(run.followUp ? { followUp: run.followUp } : {}),
    queuedQuestions: input.queuedQuestions,
  });
  run.log.push(...decision.log);

  await explain(run, llm, events, current, decision.apply, decision.questions);
  return output(run, decision.apply, decision);
}

function output(
  run: Run,
  planned: EventChange[],
  decision: { questions: Question[]; superseded: Question[] },
): PlanOutput {
  const queuedIds = new Set(run.input.queuedQuestions.map((q) => q.id));
  const apply = [...run.alwaysApply, ...planned];
  run.log.push(`apply: ${apply.map((c) => `${c.op}:${changeTaskId(c)}`).join(', ') || '(none)'}`);
  return {
    apply,
    questions: decision.questions.filter((q) => !queuedIds.has(q.id)),
    updatedQuestions: [
      ...run.updatedQuestions,
      ...decision.superseded,
      // Refreshed, not yet sent questions stay queued (the engine opens the oldest queued one).
      ...decision.questions.filter((q) => queuedIds.has(q.id)).map((q) => ({ ...q, status: 'queued' as const })),
    ],
    estimates: run.estimates,
    ...(run.learnedChanged ? { learned: run.learned } : {}),
    log: run.log,
  };
}

// ---------------------------------------------------------------------------
// Step 0: answers & signals
// ---------------------------------------------------------------------------

function processAnswers(run: Run): void {
  for (const s of run.input.signals) {
    if (s.type !== 'question-answered' && s.type !== 'question-timeout') continue;
    const q = [run.openQuestion, ...run.input.queuedQuestions].find((x) => x?.id === s.questionId);
    if (!q) {
      run.log.push(`answer for unknown question ${s.questionId} ignored`);
      continue;
    }
    const answer = s.type === 'question-timeout' ? 'timeout' : s.answer;
    const res = handleAnswer(q, answer, { now: run.now, learned: run.learned, estimates: run.estimates, tz: run.tz });
    if (answer === 'yes' && q.kind === 'missed-due') {
      const t = run.tasks.get(q.taskId);
      const due = t ? effectiveDue(run, t) : undefined;
      if (due) {
        run.learned.acceptedLate = { ...(run.learned.acceptedLate ?? {}), [q.taskId]: due.toISOString() };
        run.learnedChanged = true;
      }
    }
    run.log.push(...res.log);
    run.updatedQuestions.push(res.updated);
    run.learnedChanged ||= res.learnedChanged;
    for (const c of res.changes) {
      run.alwaysApply.push(c);
      if (c.op === 'create') run.virtualPinned.push({ taskId: c.block.taskId, start: c.block.start, end: c.block.end });
      if (c.op === 'move') {
        run.pinnedEvents.set(c.eventId, 'placed by answer');
        run.movedEvents.set(c.eventId, c.to);
      }
      if (c.op === 'delete') run.removedEventIds.add(c.eventId);
    }
    if (q.id === run.openQuestion?.id) delete run.openQuestion;
    if (res.followUp) run.followUp = res.followUp;
  }
}

function processTaskSignals(run: Run): void {
  for (const s of run.input.signals) {
    if (s.type === 'tasks-changed') {
      for (const id of s.taskIds) {
        if (run.learned.rejectedProposals[id] !== undefined) {
          delete run.learned.rejectedProposals[id];
          run.learnedChanged = true;
        }
        if (run.learned.taskDurationMin[id] === 0) {
          delete run.learned.taskDurationMin[id];
          run.learnedChanged = true;
        }
        const hadBlocks = run.input.events.some(
          (e) => e.tempo?.kind === 'block' && e.tempo.taskId === id && e.status !== 'cancelled',
        );
        run.taskCauses.set(id, hadBlocks ? 'task details changed' : newTaskCause(run, id));
      }
    }
    if (s.type === 'block-ended-open') {
      learnFromEndedBlock(run.learned);
      if (run.learned.rejectedProposals[s.taskId] !== undefined) delete run.learned.rejectedProposals[s.taskId];
      run.learnedChanged = true;
      run.taskCauses.set(s.taskId, 'last block ended, task still open');
    }
    if (s.type === 'block-deleted-by-user') run.taskCauses.set(s.taskId, 'you removed a block');
  }
}

function deletedRanges(run: Run, taskId: string): TimeRange[] {
  return run.input.signals.flatMap((s) => (s.type === 'block-deleted-by-user' && s.taskId === taskId && s.range ? [s.range] : []));
}

function changedThisRun(run: Run, t: Task): boolean {
  return run.input.signals.some(
    (s) => s.type === 'tasks-changed' && (s.taskIds.includes(t.id) || (t.parentId !== undefined && s.taskIds.includes(t.parentId))),
  );
}

function newTaskCause(run: Run, taskId: string): string {
  const due = run.tasks.get(taskId)?.due;
  return due ? `new task, due ${formatLocalDay(addMinutes(due, -1), run.tz)}` : 'new task';
}

function isDone(run: Run, taskId: string): boolean {
  const task = run.tasks.get(taskId);
  if (!task || task.status === 'completed') return true;
  const parent = task.parentId ? run.tasks.get(task.parentId) : undefined;
  return parent?.status === 'completed';
}

function removeDoneBlocks(run: Run): void {
  for (const e of run.input.events) {
    if (e.tempo?.kind !== 'block' || e.status === 'cancelled') continue;
    if (!isDone(run, e.tempo.taskId) || e.start.getTime() < run.now.getTime()) continue;
    if (run.removedEventIds.has(e.id)) continue;
    const exists = run.tasks.has(e.tempo.taskId);
    run.alwaysApply.push({
      op: 'delete',
      eventId: e.id,
      taskId: e.tempo.taskId,
      reason: exists ? 'Done — task checked off' : 'Removed — the task no longer exists',
    });
    run.removedEventIds.add(e.id);
  }
}

function processUserMoves(run: Run): void {
  for (const s of run.input.signals) {
    if (s.type !== 'block-moved-by-user' || run.removedEventIds.has(s.eventId)) continue;
    const ev = run.input.events.find((e) => e.id === s.eventId);
    if (!ev) continue;
    const est = run.estimates[s.taskId];
    const blockSum = run.input.events
      .filter((e) => e.tempo?.kind === 'block' && e.tempo.taskId === s.taskId && e.status !== 'cancelled')
      .reduce((sum, e) => sum + durationMin(e), 0);
    const currentTotal = est
      ? scaledDurationMin(est.durationMin, s.taskId, run.learned)
      : (run.learned.taskDurationMin[s.taskId] ?? blockSum);
    const res = learnFromUserMove({
      signal: s,
      title: run.tasks.get(s.taskId)?.title ?? ev.title,
      tz: run.tz,
      learned: run.learned,
      currentTotalMin: currentTotal,
      ...(est ? { rawEstimateMin: est.durationMin } : {}),
    });
    run.alwaysApply.push(res.change);
    run.pinnedEvents.set(s.eventId, 'moved by user');
    run.learnedChanged = true;
    run.log.push(`learned from user move of ${s.eventId}: ${res.lines.join(' | ') || '(no change)'}`);
  }
}

// ---------------------------------------------------------------------------
// Step 1: understand
// ---------------------------------------------------------------------------

function openSubtasks(run: Run, parentId: string): Task[] {
  return run.input.tasks
    .filter((t) => t.parentId === parentId && t.status === 'needsAction')
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
}

/** Open tasks Tempo plans directly: subtasks, and tasks without open subtasks. */
/**
 * A task whose due date passed more than LAPSED_AFTER_DAYS ago is treated as
 * lapsed: an old, forgotten to-do rather than work for this week. It is not
 * planned and raises no "missed due date" question; giving it a new due date
 * (or removing the date) brings it back.
 */
export const LAPSED_AFTER_DAYS = 7;

export function isLapsed(due: Date | undefined, now: Date): boolean {
  return due !== undefined && now.getTime() - due.getTime() > LAPSED_AFTER_DAYS * 86_400_000;
}

function plannableTasks(run: Run): Task[] {
  return run.input.tasks.filter((t) => {
    if (isDone(run, t.id)) return false;
    if (isLapsed(effectiveDue(run, t), run.now)) return false;
    if (t.parentId) return true;
    return openSubtasks(run, t.id).length === 0;
  });
}

function effectiveDue(run: Run, t: Task): Date | undefined {
  const parentDue = t.parentId ? run.tasks.get(t.parentId)?.due : undefined;
  if (t.due && parentDue) return t.due.getTime() <= parentDue.getTime() ? t.due : parentDue;
  return t.due ?? parentDue;
}

async function understand(run: Run, llm: LlmPort): Promise<void> {
  const tasks = plannableTasks(run);
  const stale = tasks.filter((t) => {
    const est = run.estimates[t.id];
    return !est || t.updated.getTime() > Date.parse(est.estimatedAt);
  });
  let answers: TaskEstimate[] = [];
  if (stale.length > 0) {
    try {
      answers = await llm.understand({
        tasks: stale.map((t) => {
          const due = effectiveDue(run, t);
          return {
            id: t.id,
            title: t.title,
            ...(t.notes !== undefined ? { notes: t.notes } : {}),
            ...(due ? { due } : {}),
            ...(t.parentId !== undefined ? { parentId: t.parentId } : {}),
          };
        }),
        now: run.now,
        timezone: run.tz,
        learnedNotes: run.learned.notes.slice(-10),
      });
      run.log.push(`understand (${llm.name}): ${stale.map((t) => t.id).join(', ')}`);
    } catch (err) {
      run.log.push(`understand failed (${errorText(err)}) → neutral estimates for this run`);
    }
  }
  for (const t of stale) {
    const ans = answers.find((a) => a.taskId === t.id);
    if (ans) run.estimates[t.id] = { ...sanitizeEstimate(ans, t.id), estimatedAt: run.now.toISOString() };
  }
  for (const t of tasks) {
    const cached = run.estimates[t.id];
    run.runEstimates.set(t.id, cached ? sanitizeEstimate(cached, t.id) : { ...DEFAULT_ESTIMATE, taskId: t.id });
  }
}

function clamp(x: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(x)) return fallback;
  return Math.min(hi, Math.max(lo, x));
}

function sanitizeEstimate(e: TaskEstimate, taskId: string): TaskEstimate {
  const durationMin = roundMinutes(clamp(e.durationMin, 5, 24 * 60, DEFAULT_ESTIMATE.durationMin));
  const minChunkMin = Math.min(durationMin, roundMinutes(clamp(e.minChunkMin, 5, 8 * 60, DEFAULT_ESTIMATE.minChunkMin)));
  return {
    taskId,
    durationMin,
    minChunkMin,
    priority: Math.round(clamp(e.priority, 1, 5, 3)),
    urgency: Math.round(clamp(e.urgency, 1, 5, 2)),
    confidence: clamp(e.confidence, 0, 1, 1),
    deepWork: e.deepWork === true,
    ...(e.rationale !== undefined ? { rationale: e.rationale } : {}),
  };
}

// ---------------------------------------------------------------------------
// Items, pins, reservations
// ---------------------------------------------------------------------------

/** Tasks of the effective open question (incl. a Maybe follow-up) are frozen. */
function frozenTaskIds(run: Run): Set<string> {
  const q = run.followUp ?? run.openQuestion;
  const ids = new Set<string>();
  if (!q) return ids;
  ids.add(q.taskId);
  if (q.kind === 'big-change') for (const c of q.proposal) ids.add(changeTaskId(c));
  return ids;
}

function questionReservations(run: Run): TimeRange[] {
  const q = run.followUp ?? run.openQuestion;
  if (!q) return [];
  const out: TimeRange[] = [q.slot, ...q.replacedBlocks];
  for (const c of q.proposal) {
    if (c.op === 'move') out.push(c.to);
    if (c.op === 'create') out.push(c.block);
  }
  return out.map((r) => ({ start: r.start, end: r.end }));
}

function effectiveEvents(run: Run): CalendarEvent[] {
  return run.input.events
    .filter((e) => !run.removedEventIds.has(e.id))
    .map((e) => {
      const moved = run.movedEvents.get(e.id);
      return moved ? { ...e, start: moved.start, end: moved.end } : e;
    });
}

function pinnedTaskMap(run: Run, frozen: ReadonlySet<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const id of frozen) map.set(id, 'open question');
  for (const [id, count] of Object.entries(run.learned.rejectedProposals)) {
    if (count > 0 && !map.has(id)) map.set(id, 'kept after No');
  }
  for (const t of run.input.tasks) if (isDone(run, t.id) && !map.has(t.id)) map.set(t.id, 'done');
  return map;
}

function pinnedBlocks(run: Run, current: readonly CurrentBlock[]): TaskBlock[] {
  return [
    ...current
      .filter((b) => b.status === 'pinned')
      .map((b) => ({ taskId: b.taskId, start: b.start, end: b.end, eventId: b.eventId })),
    ...run.virtualPinned,
  ];
}

function minutesAfter(r: TimeRange, now: Date): number {
  return Math.max(0, durationMin({ start: maxDate(r.start, now), end: r.end }));
}

function buildItems(run: Run, current: readonly CurrentBlock[], pinnedTasks: ReadonlyMap<string, string>): PlanItem[] {
  const items: PlanItem[] = [];
  const plannable = plannableTasks(run);
  const plannableIds = new Set(plannable.map((t) => t.id));
  for (const b of current) {
    if (b.status === 'movable' && !plannableIds.has(b.taskId) && run.tasks.has(b.taskId) && !isDone(run, b.taskId)) {
      run.taskCauses.set(b.taskId, 'now planned via its subtasks');
    }
  }
  for (const t of plannable) {
    const est = run.runEstimates.get(t.id) ?? { ...DEFAULT_ESTIMATE, taskId: t.id };
    const blocks = current.filter((b) => b.taskId === t.id);
    const virtual = run.virtualPinned.filter((b) => b.taskId === t.id);
    const worked = blocks.filter((b) => b.status === 'past').reduce((s, b) => s + durationMin(b), 0);
    const pinnedMin = [...blocks.filter((b) => b.status === 'pinned'), ...virtual].reduce(
      (s, b) => s + minutesAfter(b, run.now),
      0,
    );
    const movableMin = blocks.filter((b) => b.status === 'movable').reduce((s, b) => s + durationMin(b), 0);
    const total = scaledDurationMin(est.durationMin, t.id, run.learned);
    const remaining = remainingNeedMin(total, worked, est.minChunkMin);
    let need = pinnedTasks.has(t.id) ? 0 : Math.max(0, remaining - pinnedMin);
    if (need > 0) need = roundMinutes(need);
    if (need > 0 && movableMin > 0 && Math.abs(need - movableMin) < NEED_TOLERANCE_MIN) need = movableMin;

    const due = effectiveDue(run, t);
    const futureBlocks = [...blocks.filter((b) => b.status !== 'past'), ...virtual];
    const subtasks = t.parentId ? openSubtasks(run, t.parentId) : [];
    items.push({
      taskId: t.id,
      taskListId: t.listId,
      title: t.title,
      needMin: need,
      minChunkMin: est.minChunkMin,
      priority: run.learned.taskPriority[t.id] ?? est.priority,
      urgency: est.urgency,
      deepWork: est.deepWork,
      ...(due ? { due } : {}),
      ...(t.parentId ? { orderGroup: t.parentId, orderIndex: subtasks.findIndex((s) => s.id === t.id) } : {}),
      // Only lateness the user explicitly accepted (Yes to a late proposal, same due) is kept without asking.
      lateOk:
        due !== undefined &&
        !changedThisRun(run, t) &&
        run.learned.acceptedLate?.[t.id] === due.toISOString() &&
        futureBlocks.some((b) => b.end.getTime() > due.getTime()),
      avoid: deletedRanges(run, t.id),
    });
  }
  return items;
}

function taskMeta(run: Run, current: readonly CurrentBlock[]): Map<string, { title: string; listId: string }> {
  const map = new Map<string, { title: string; listId: string }>();
  for (const b of current) map.set(b.taskId, { title: b.title, listId: b.taskListId });
  for (const t of run.input.tasks) map.set(t.id, { title: t.title, listId: t.listId });
  return map;
}

// ---------------------------------------------------------------------------
// Steps 3+4: place & check
// ---------------------------------------------------------------------------

function isStable(run: Run, movable: readonly CurrentBlock[], ctx: CheckContext): boolean {
  const relevant = run.input.signals.filter((s) => s.type !== 'periodic');
  if (relevant.length > 0 || run.followUp || run.alwaysApply.length > 0) return false;
  const errors = checkPlacements(
    movable.map((b) => ({ taskId: b.taskId, start: b.start, end: b.end })),
    ctx,
  );
  if (errors.length > 0) run.log.push(`periodic check found problems: ${errors.slice(0, 3).join(' / ')}`);
  return errors.length === 0;
}

interface PlaceArgs {
  items: PlanItem[];
  gaps: TimeRange[];
  movable: readonly CurrentBlock[];
  checkCtx: CheckContext;
  oracle: GreedyResult;
}

async function place(run: Run, llm: LlmPort, a: PlaceArgs): Promise<{ placements: Placement[]; source: 'llm' | 'greedy' }> {
  const toPlace = a.items.filter((i) => i.needMin > 0);
  if (toPlace.length === 0) return { placements: a.oracle.placements, source: 'greedy' };
  const req: PlaceRequest = {
    now: run.now,
    timezone: run.tz,
    tasks: toPlace.map((i) => ({
      taskId: i.taskId,
      title: i.title,
      durationMin: i.needMin,
      minChunkMin: i.minChunkMin,
      priority: i.priority,
      urgency: i.urgency,
      deepWork: i.deepWork,
      ...(i.due ? { due: i.due } : {}),
      ...(i.orderGroup !== undefined ? { orderGroup: i.orderGroup, orderIndex: i.orderIndex ?? 0 } : {}),
    })),
    gaps: a.gaps,
    currentBlocks: a.movable.map((b) => ({ taskId: b.taskId, start: b.start, end: b.end })),
    focusTime: { start: run.prefs.focusTime.start, end: run.prefs.focusTime.end },
    learnedNotes: run.learned.notes.slice(-10),
  };
  let previousErrors: string[] | undefined;
  for (let attempt = 0; attempt <= MAX_PLACE_RETRIES; attempt++) {
    let res: Placement[] | null;
    try {
      res = await llm.place(previousErrors ? { ...req, previousErrors } : req);
    } catch (err) {
      run.log.push(`place (${llm.name}) failed: ${errorText(err)} → greedy`);
      break;
    }
    if (res === null) {
      run.log.push(`place (${llm.name}) returned null → greedy`);
      break;
    }
    const placements = res.map((p) => ({ taskId: p.taskId, start: new Date(p.start), end: new Date(p.end) }));
    const errors = checkPlacements(placements, a.checkCtx);
    if (errors.length === 0) {
      run.log.push(`place (${llm.name}) accepted on attempt ${attempt + 1}`);
      return { placements, source: 'llm' };
    }
    run.log.push(`check rejected attempt ${attempt + 1}: ${errors.slice(0, 5).join(' / ')}`);
    previousErrors = errors;
  }
  if (previousErrors) run.log.push('place: retries exhausted → greedy');
  return { placements: a.oracle.placements, source: 'greedy' };
}

// ---------------------------------------------------------------------------
// Question candidates
// ---------------------------------------------------------------------------

interface OptionArgs {
  gaps: TimeRange[];
  target: Placement[];
  heldBlocks: CurrentBlock[];
  pinned: TaskBlock[];
  items: PlanItem[];
  horizonEnd: Date;
  /** Movable blocks as they are in the calendar now. */
  movable: CurrentBlock[];
}

function missedDueQuestion(run: Run, item: PlanItem, a: OptionArgs): Question[] {
  const own = a.heldBlocks.filter((b) => b.taskId === item.taskId);
  const otherHeld = a.heldBlocks.filter((b) => b.taskId !== item.taskId);
  // Work that is due later (or has no due) and isn't urgent may make room: on
  // Yes it is re-placed around the accepted blocks. Without this the only
  // options would be "far too late" whenever the week is already planned.
  const itemById = new Map(a.items.map((i) => [i.taskId, i]));
  const yields = (p: Placement): boolean => {
    const other = itemById.get(p.taskId);
    if (!other || !item.due || other.urgency >= 4) return false;
    if (other.orderGroup !== undefined && other.orderGroup === item.orderGroup) return false;
    return !other.due || other.due.getTime() > item.due.getTime();
  };
  const free = subtractRanges(a.gaps, [...a.target.filter((p) => !yields(p)), ...otherHeld]);
  const peers = a.items
    .filter((i) => i.taskId !== item.taskId && i.orderGroup !== undefined && i.orderGroup === item.orderGroup)
    .map((i) => ({ ...i, needMin: 0 }));
  const peerBlocks = a.target.filter((p) => peers.some((i) => i.taskId === p.taskId));
  const options: PlacementOption[] = [];
  const avoid = [...item.avoid];
  for (let k = 0; k < MAX_OPTIONS; k++) {
    const res = greedyPlace({
      now: run.now,
      prefs: run.prefs,
      items: [{ ...item, lateOk: false, avoid: [...avoid] }, ...peers],
      gaps: free,
      pinned: [...a.pinned, ...peerBlocks],
      horizonEnd: a.horizonEnd,
    });
    const blocks = res.placements.filter((p) => p.taskId === item.taskId).map((p) => ({ start: p.start, end: p.end }));
    if (blocks.length === 0) break;
    options.push({ blocks, unplacedMin: res.unplacedMin[item.taskId] ?? 0 });
    const last = [...blocks].sort((x, y) => x.end.getTime() - y.end.getTime()).at(-1)!;
    avoid.push(last);
  }
  const firstBlocks = options[0]?.blocks ?? [];
  const displaced = [
    ...new Set(
      [...a.movable, ...a.target]
        .filter((p) => yields(p) && firstBlocks.some((b) => overlaps(b, p)))
        .map((p) => run.tasks.get(p.taskId)?.title ?? p.taskId),
    ),
  ];
  const q = buildMissedDueQuestion({ now: run.now, prefs: run.prefs, item, options, replaced: own, displaced });
  if (!q) run.log.push(`missed-due for ${item.taskId}: no option at least 2 h ahead → keeping its blocks, not asking yet`);
  return q ? [q] : [];
}

function unclearPriorityQuestions(
  run: Run,
  items: readonly PlanItem[],
  target: readonly Placement[],
  current: readonly CurrentBlock[],
  heldIds: ReadonlySet<string>,
  pinnedTasks: ReadonlyMap<string, string>,
): Question[] {
  const out: Question[] = [];
  for (const item of items) {
    if (heldIds.has(item.taskId) || pinnedTasks.has(item.taskId)) continue;
    const est = run.runEstimates.get(item.taskId);
    if (!est || est.confidence >= UNCLEAR_CONFIDENCE || run.learned.taskPriority[item.taskId] !== undefined) continue;
    const blocks = sortRanges([
      ...target.filter((p) => p.taskId === item.taskId),
      ...current.filter((b) => b.taskId === item.taskId && b.status === 'pinned'),
    ]);
    // At the task's first block if that is >= 2 h ahead, else at the next working-hours start.
    const slot = blocks.find((b) => isAskableSlot(b, run.now)) ?? nextWorkingSlot(run.now, run.prefs, run.input.horizonDays);
    out.push(
      buildUnclearPriorityQuestion({
        now: run.now,
        prefs: run.prefs,
        item,
        slot: { start: slot.start, end: slot.end },
        currentPriority: est.priority,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 6: explain
// ---------------------------------------------------------------------------

function globalCause(signals: readonly Signal[]): string {
  const has = (t: Signal['type']): boolean => signals.some((s) => s.type === t);
  if (has('initial')) return 'first plan';
  if (has('settings-changed')) return 'your settings changed';
  if (has('fixed-event-changed')) return 'your calendar changed';
  if (has('block-moved-by-user')) return 'you moved a block';
  if (has('block-ended-open')) return 'a block ended with its task still open';
  if (has('tasks-changed')) return 'your tasks changed';
  if (has('question-answered') || has('question-timeout')) return 'you answered a question';
  return 're-planned';
}

function changeCause(
  run: Run,
  c: EventChange,
  events: readonly CalendarEvent[],
  current: readonly CurrentBlock[],
  apply: readonly EventChange[],
): string {
  const taskId = changeTaskId(c);
  const from = c.op === 'move' ? c.from : c.op === 'delete' ? current.find((b) => b.eventId === c.eventId) : undefined;
  if (from) {
    const fixed = events.find(
      (e) => !e.tempo && e.status !== 'cancelled' && e.transparency === 'opaque' && e.selfResponse !== 'declined' && !e.allDay && overlaps(e, from),
    );
    if (fixed) return `'${fixed.title}' now overlaps the old slot`;
  }
  const own = run.taskCauses.get(taskId);
  if (own) return own;
  const global = globalCause(run.input.signals);
  if (c.op === 'create') return global;
  if (c.op === 'move') {
    if (c.to.start.getTime() < c.from.start.getTime()) {
      const due = run.tasks.get(taskId)?.due;
      const dueText = due ? `, well before it's due (${formatLocalDay(addMinutes(due, -1), run.tz)})` : '';
      return `there is free time sooner${dueText}`;
    }
    const taker = apply.find((o) => o !== c && changeTaskId(o) !== taskId && newRange(o) !== undefined && overlaps(newRange(o)!, c.from));
    if (taker) return `'${changeTitle(run, taker)}' needed the old slot (${global})`;
  }
  return global;
}

/** Back-to-back placements of the same task become one block (one 2 h block, not two 1 h blocks). */
export function mergeAdjacent(placements: readonly Placement[]): Placement[] {
  const out: Placement[] = [];
  for (const p of [...placements].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.start.getTime() - b.start.getTime())) {
    const last = out.at(-1);
    if (last && last.taskId === p.taskId && last.end.getTime() === p.start.getTime()) {
      out[out.length - 1] = { ...last, end: p.end };
    } else out.push({ ...p });
  }
  return out;
}

function newRange(c: EventChange): TimeRange | undefined {
  return c.op === 'create' ? c.block : c.op === 'move' ? c.to : undefined;
}

function changeTitle(run: Run, c: EventChange): string {
  if (c.op === 'create') return c.block.title;
  const id = changeTaskId(c);
  return run.tasks.get(id)?.title ?? 'another task';
}

function templateReason(c: EventChange, cause: string): string {
  const verb = c.op === 'create' ? 'Planned' : c.op === 'move' ? 'Moved' : 'Removed';
  return `${verb}: ${cause}.`;
}

function setReason(c: EventChange, reason: string): void {
  if (c.op === 'create') c.block.reason = reason;
  else c.reason = reason;
}

function hasReason(c: EventChange): boolean {
  return c.op === 'create' ? !!c.block.reason : !!c.reason;
}

async function explain(
  run: Run,
  llm: LlmPort,
  events: readonly CalendarEvent[],
  current: readonly CurrentBlock[],
  apply: readonly EventChange[],
  questions: readonly Question[],
): Promise<void> {
  const changes = [...apply, ...questions.flatMap((q) => [...q.proposal, ...q.alternatives.flatMap((a) => a.proposal)])].filter(
    (c) => !hasReason(c),
  );
  if (changes.length === 0) return;
  const causes = new Map(changes.map((c) => [c, changeCause(run, c, events, current, apply)]));
  const req: ExplainRequest = {
    now: run.now,
    timezone: run.tz,
    // Keyed per change, not per task: one task can have a move and a delete in the same run.
    changes: changes.map((c, i) => {
      const taskId = changeTaskId(c);
      const kind = c.op === 'create' ? 'created' : c.op === 'move' ? 'moved' : 'dropped';
      const from = c.op === 'move' ? c.from : undefined;
      const to = c.op === 'move' ? c.to : c.op === 'create' ? { start: c.block.start, end: c.block.end } : undefined;
      return {
        taskId: explainKey(taskId, i),
        title: run.tasks.get(taskId)?.title ?? (c.op === 'create' ? c.block.title : taskId),
        kind,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        cause: causes.get(c)!,
      };
    }),
  };
  let reasons: Record<string, string> = {};
  try {
    reasons = await llm.explain(req);
  } catch (err) {
    run.log.push(`explain failed (${errorText(err)}) → template reasons`);
  }
  const perTask = new Map<string, number>();
  for (const c of changes) perTask.set(changeTaskId(c), (perTask.get(changeTaskId(c)) ?? 0) + 1);
  for (const [i, c] of changes.entries()) {
    const id = changeTaskId(c);
    // Providers answer per key; a plain task id is accepted when it is unambiguous.
    const fromLlm = (reasons[explainKey(id, i)] ?? (perTask.get(id) === 1 ? reasons[id] : undefined))?.trim();
    setReason(c, fromLlm ? fromLlm : templateReason(c, causes.get(c)!));
  }
}

function explainKey(taskId: string, index: number): string {
  return `${taskId}#${index}`;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
