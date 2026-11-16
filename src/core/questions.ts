/**
 * Questions (E9/E10, D10-D12): building invitations and handling answers.
 *
 * Interpretation decisions:
 * - Slot rule: a question's slot must start at least 2 h from now, so the
 *   user always gets >= 1 h until `answerBy` (= slot.start - 1 h). Options
 *   that violate this are skipped and the next-best option is used.
 * - Proposals never refer to replaced event ids: while a question is open the
 *   engine has deleted the replaced blocks, so everything the proposal puts
 *   back is expressed as 'create'.
 * - missed-due: slot = the block of the proposal that ends last (the late
 *   one); replaced = all movable current blocks of the task; alternatives =
 *   up to 3 next-best placements (each avoids the previous invitation slot).
 * - dropped-task: Yes = drop. Nothing to apply (the replaced blocks are already
 *   gone); Tempo stores `learned.taskDurationMin[taskId] = 0`, meaning "no
 *   remaining work", until the task is edited. Slot = its first current block,
 *   else 15 min at the next working-hours start >= 2 h ahead.
 * - unclear-priority: never replaces blocks (the task stays planned); the
 *   invitation sits on the task's first block. Yes = priority 5 ("top
 *   priority"), No = keep the estimate and stop asking (confidence := 1).
 * - big-change: slot = new position of the most affected block; that block is
 *   the replaced one; proposal = the whole re-plan. Maybe has no alternatives
 *   (behaves like No).
 * - No / timeout ("keep as is + learn"): restore replaced blocks and count a
 *   rejection for the task (for big-change: every task whose existing blocks
 *   the proposal would move). A rejected task keeps its current blocks pinned
 *   and is not asked about again until the user edits the task or one of its
 *   kept blocks ends with the task still open (see pipeline.ts).
 * - Yes is user-initiated: its blocks may land in the lock window, but proposal
 *   blocks whose start already passed are skipped (the pipeline re-plans that
 *   work). No/timeout restores the replaced blocks exactly, even past ones.
 * - Maybe: status 'maybe' and a NEW queued question for the next alternative
 *   (same kind/task, same replaced blocks — the engine should treat "already
 *   deleted" as success); if none is left it behaves like No.
 */
import { addMinutes, alignRanges, durationMin, formatLocal, formatLocalDay, localDayDiff, roundUpToSlot, sortRanges, workingWindows } from './time.js';
import type { CurrentBlock, PlacementOption, PlanItem } from './planModel.js';
import {
  QUESTION_PREFIX,
  RSVP_HELP,
  type BlockDraft,
  type EventChange,
  type LearnedPreferences,
  type Preferences,
  type Question,
  type QuestionKind,
  type TaskEstimate,
  type TimeRange,
} from './types.js';

/** Minimum lead time between now and a question's slot. */
export const QUESTION_MIN_LEAD_MIN = 120;
/** No answer this long before the slot means "No" (D12). */
export const ANSWER_LEAD_MIN = 60;
export const TOP_PRIORITY = 5;
const DROPPED_SLOT_MIN = 15;

export function questionId(kind: QuestionKind, taskId: string, now: Date): string {
  return `q-${kind}-${taskId}-${now.getTime()}`;
}

export function isAskableSlot(slot: TimeRange, now: Date): boolean {
  return slot.start.getTime() >= addMinutes(now, QUESTION_MIN_LEAD_MIN).getTime();
}

export function answerByFor(slot: TimeRange): Date {
  return addMinutes(slot.start, -ANSWER_LEAD_MIN);
}

export function describeRange(r: TimeRange, tz: string): string {
  return `${formatLocal(r.start, tz)}–${formatLocal(r.end, tz, 'HH:mm')}`;
}

function describeDuration(min: number): string {
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  return Number.isInteger(h) ? `${h} h` : `${h.toFixed(1)} h`;
}

export function blockToDraft(b: CurrentBlock): BlockDraft {
  return {
    taskId: b.taskId,
    taskListId: b.taskListId,
    title: b.title,
    start: b.start,
    end: b.end,
    ...(b.part !== undefined ? { part: b.part } : {}),
  };
}

function withHelp(reason: string): string {
  return `${reason}\n\n${RSVP_HELP}`;
}

interface QuestionParts {
  kind: QuestionKind;
  item: Pick<PlanItem, 'taskId' | 'taskListId'>;
  titleBody: string;
  reason: string;
  slot: TimeRange;
  proposal: EventChange[];
  alternatives?: Question['alternatives'];
  replaced?: readonly CurrentBlock[];
  proposedPriority?: number;
  now: Date;
}

function makeQuestion(p: QuestionParts): Question {
  return {
    id: questionId(p.kind, p.item.taskId, p.now),
    kind: p.kind,
    title: `${QUESTION_PREFIX}${p.titleBody}`,
    description: withHelp(p.reason),
    slot: p.slot,
    taskId: p.item.taskId,
    taskListId: p.item.taskListId,
    proposal: p.proposal,
    alternatives: p.alternatives ?? [],
    replacedBlocks: (p.replaced ?? []).map(blockToDraft),
    replacedEventIds: (p.replaced ?? []).map((b) => b.eventId),
    ...(p.proposedPriority !== undefined ? { proposedPriority: p.proposedPriority } : {}),
    createdAt: p.now,
    answerBy: answerByFor(p.slot),
    status: 'queued',
  };
}

// ---------------------------------------------------------------------------
// missed-due
// ---------------------------------------------------------------------------

export interface MissedDueArgs {
  now: Date;
  prefs: Preferences;
  item: PlanItem;
  /** Candidate placements, best first. */
  options: readonly PlacementOption[];
  /** Movable current blocks of the task (hidden while the question is open). */
  replaced: readonly CurrentBlock[];
}

function optionSlot(o: PlacementOption): TimeRange | undefined {
  return sortRanges(o.blocks).sort((a, b) => a.end.getTime() - b.end.getTime()).at(-1);
}

/** "today 17:05", "tomorrow 09:00" or "Thu 19 Nov 15:50". */
export function relativeWhen(d: Date, now: Date, tz: string): string {
  const days = localDayDiff(now, d, tz);
  if (days === 0) return `today ${formatLocal(d, tz, 'HH:mm')}`;
  if (days === 1) return `tomorrow ${formatLocal(d, tz, 'HH:mm')}`;
  return formatLocal(d, tz);
}

/** "1 day late", "3 h late" or "only 60 of 120 min before due". */
export function lateText(item: PlanItem, o: PlacementOption, tz: string): string {
  const slot = optionSlot(o);
  const due = item.due;
  if (!due || !slot) return 'late';
  if (slot.end.getTime() > due.getTime()) {
    const days = localDayDiff(addMinutes(due, -1), addMinutes(slot.end, -1), tz);
    if (days >= 1) return `${days} day${days === 1 ? '' : 's'} late`;
    return `${Math.max(1, Math.ceil(durationMin({ start: due, end: slot.end }) / 60))} h late`;
  }
  const placed = o.blocks.reduce((s, b) => s + durationMin(b), 0);
  return `only ${describeDuration(placed)} of ${describeDuration(placed + o.unplacedMin)} before due`;
}

function createsFor(item: PlanItem, title: string, blocks: readonly TimeRange[]): EventChange[] {
  const sorted = sortRanges(blocks);
  return sorted.map((b, i) => ({
    op: 'create' as const,
    block: {
      taskId: item.taskId,
      taskListId: item.taskListId,
      title,
      start: b.start,
      end: b.end,
      ...(sorted.length > 1 ? { part: i } : {}),
    },
  }));
}

export function buildMissedDueQuestion(a: MissedDueArgs): Question | undefined {
  const tz = a.prefs.timezone;
  const askable = a.options.filter((o) => {
    const slot = optionSlot(o);
    return slot !== undefined && isAskableSlot(slot, a.now);
  });
  const [primary, ...rest] = askable;
  const slot = primary ? optionSlot(primary) : undefined;
  if (!primary || !slot) return undefined;
  const title = a.item.title;
  const dueText = a.item.due ? formatLocalDay(addMinutes(a.item.due, -1), tz) : 'its due date';
  // Already overdue: there is no "before the due" any more, only "when now".
  const overdue = a.item.due !== undefined && a.item.due.getTime() <= a.now.getTime();
  return makeQuestion({
    kind: 'missed-due',
    item: a.item,
    now: a.now,
    titleBody: overdue
      ? `${title} is overdue. Do it ${relativeWhen(slot.start, a.now, tz)}?`
      : `${title} ${lateText(a.item, primary, tz)}?`,
    reason: overdue
      ? `'${title}' was due ${dueText} and isn't checked off. Proposed: ${describeRange(slot, tz)}.`
      : `'${title}' doesn't fit before its due (${dueText}). Proposed: ${describeRange(slot, tz)}.`,
    slot,
    proposal: createsFor(a.item, title, primary.blocks),
    alternatives: rest.slice(0, 3).map((o) => {
      const altSlot = optionSlot(o)!;
      return { slot: altSlot, proposal: createsFor(a.item, title, o.blocks), summary: `${title} ${lateText(a.item, o, tz)}` };
    }),
    replaced: a.replaced,
  });
}

// ---------------------------------------------------------------------------
// dropped-task
// ---------------------------------------------------------------------------

export interface DroppedArgs {
  now: Date;
  prefs: Preferences;
  item: PlanItem;
  replaced: readonly CurrentBlock[];
  horizonDays: number;
  /** Total minutes of the task that could not be placed. */
  needMin: number;
}

/** First working-hours start at least 2 h ahead (15 min long). */
export function nextWorkingSlot(now: Date, prefs: Preferences, horizonDays: number): TimeRange {
  const from = roundUpToSlot(addMinutes(now, QUESTION_MIN_LEAD_MIN));
  const span = { start: from, end: addMinutes(from, (horizonDays + 7) * 24 * 60) };
  const first = alignRanges(workingWindows(span, prefs), DROPPED_SLOT_MIN)[0];
  const start = first?.start ?? from;
  return { start, end: addMinutes(start, DROPPED_SLOT_MIN) };
}

export function buildDroppedQuestion(a: DroppedArgs): Question {
  const firstReplaced = sortRanges(a.replaced)[0];
  const slot =
    firstReplaced && isAskableSlot(firstReplaced, a.now)
      ? { start: firstReplaced.start, end: firstReplaced.end }
      : nextWorkingSlot(a.now, a.prefs, a.horizonDays);
  const title = a.item.title;
  const dueText = a.item.due ? ` before its due (${formatLocalDay(addMinutes(a.item.due, -1), a.prefs.timezone)})` : '';
  return makeQuestion({
    kind: 'dropped-task',
    item: a.item,
    now: a.now,
    titleBody: `Drop '${title}'?`,
    reason: `No free time for '${title}' (${describeDuration(a.needMin)}) in the next ${a.horizonDays} days${dueText}.`,
    slot,
    proposal: [],
    replaced: a.replaced,
  });
}

// ---------------------------------------------------------------------------
// unclear-priority
// ---------------------------------------------------------------------------

export interface UnclearPriorityArgs {
  now: Date;
  prefs: Preferences;
  item: PlanItem;
  slot: TimeRange;
  currentPriority: number;
}

export function buildUnclearPriorityQuestion(a: UnclearPriorityArgs): Question {
  const title = a.item.title;
  return makeQuestion({
    kind: 'unclear-priority',
    item: a.item,
    now: a.now,
    titleBody: `Is '${title}' a top priority?`,
    reason: `Tempo isn't sure how important '${title}' is (guessed ${a.currentPriority}/5). Yes plans it first.`,
    slot: a.slot,
    proposal: [],
    proposedPriority: TOP_PRIORITY,
  });
}

// ---------------------------------------------------------------------------
// big-change
// ---------------------------------------------------------------------------

export type MoveChange = Extract<EventChange, { op: 'move' }>;

export interface BigChangeArgs {
  now: Date;
  prefs: Preferences;
  /** The whole held re-plan. */
  changes: readonly EventChange[];
  mostAffected: MoveChange;
  /** Current block of `mostAffected` (it is hidden while the question is open). */
  mostAffectedBlock: CurrentBlock;
  movedCount: number;
  cause: string;
}

export function buildBigChangeQuestion(a: BigChangeArgs): Question {
  const tz = a.prefs.timezone;
  const b = a.mostAffectedBlock;
  const shiftDays = localDayDiff(a.mostAffected.from.start, a.mostAffected.to.start, tz);
  const shiftText = shiftDays === 0 ? 'within the day' : `by ${Math.abs(shiftDays)} day${Math.abs(shiftDays) === 1 ? '' : 's'}`;
  const proposal = a.changes.map((c): EventChange =>
    c === a.mostAffected
      ? {
          op: 'create',
          block: { ...blockToDraft(b), start: a.mostAffected.to.start, end: a.mostAffected.to.end },
        }
      : c,
  );
  const titleBody =
    a.movedCount > 1 ? `Move ${a.movedCount} blocks?` : `Move '${b.title}' to ${formatLocalDay(a.mostAffected.to.start, tz)}?`;
  return makeQuestion({
    kind: 'big-change',
    item: { taskId: b.taskId, taskListId: b.taskListId },
    now: a.now,
    titleBody,
    reason: `Re-planning (${a.cause}) moves ${a.movedCount} block${a.movedCount === 1 ? '' : 's'}; '${b.title}' ${shiftText} to ${describeRange(a.mostAffected.to, tz)}.`,
    slot: a.mostAffected.to,
    proposal,
    replaced: [b],
  });
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

export type Answer = 'yes' | 'no' | 'maybe' | 'timeout';

export interface AnswerContext {
  now: Date;
  /** Mutated in place. */
  learned: LearnedPreferences;
  /** Mutated in place. */
  estimates: Record<string, TaskEstimate & { estimatedAt: string }>;
  tz: string;
}

export interface AnswerResult {
  updated: Question;
  /** Calendar changes caused by the answer (apply right away). */
  changes: EventChange[];
  /** Maybe: the next option, status 'queued' (the engine opens it next). */
  followUp?: Question;
  learnedChanged: boolean;
  estimatesChanged: boolean;
  log: string[];
}

export function handleAnswer(q: Question, answer: Answer, ctx: AnswerContext): AnswerResult {
  if (answer === 'yes') return answerYes(q, ctx);
  if (answer === 'maybe') return answerMaybe(q, ctx);
  return keepPlan(q, answer === 'timeout' ? 'expired' : 'no', ctx);
}

function answerYes(q: Question, ctx: AnswerContext): AnswerResult {
  const log = [`question ${q.id} (${q.kind}, ${q.taskId}): yes`];
  let learnedChanged = false;
  if (q.kind === 'unclear-priority') {
    ctx.learned.taskPriority[q.taskId] = q.proposedPriority ?? TOP_PRIORITY;
    learnedChanged = true;
  }
  if (q.kind === 'dropped-task') {
    ctx.learned.taskDurationMin[q.taskId] = 0;
    ctx.learned.notes.push(`You dropped a task Tempo could not fit: ${q.title.slice(QUESTION_PREFIX.length)}`);
    learnedChanged = true;
  }
  return {
    updated: { ...q, status: 'yes' },
    changes: notStarted(q.proposal, ctx.now).map((c) => withDefaultReason(c, 'You said Yes to Tempo’s proposal.')),
    learnedChanged,
    estimatesChanged: false,
    log,
  };
}

function answerMaybe(q: Question, ctx: AnswerContext): AnswerResult {
  const idx = q.alternatives.findIndex((alt) => isAskableSlot(alt.slot, ctx.now));
  const next = idx >= 0 ? q.alternatives[idx] : undefined;
  if (!next) {
    const res = keepPlan(q, 'maybe', ctx);
    return { ...res, log: [...res.log, `question ${q.id}: maybe without alternatives → like No`] };
  }
  const followUp: Question = {
    ...q,
    id: `${q.id}-alt${q.alternatives.length - idx}`,
    title: `${QUESTION_PREFIX}${next.summary}?`,
    description: withHelp(`Other time: ${describeRange(next.slot, ctx.tz)}.`),
    slot: next.slot,
    proposal: next.proposal,
    alternatives: q.alternatives.slice(idx + 1),
    // Keep the original creation time so a createdAt-ordered queue opens it next.
    createdAt: q.createdAt,
    answerBy: answerByFor(next.slot),
    status: 'queued',
  };
  delete followUp.inviteEventId;
  return {
    updated: { ...q, status: 'maybe' },
    changes: [],
    followUp,
    learnedChanged: false,
    estimatesChanged: false,
    log: [`question ${q.id}: maybe → next option ${followUp.id}`],
  };
}

function keepPlan(q: Question, status: 'no' | 'expired' | 'maybe', ctx: AnswerContext): AnswerResult {
  const reason = status === 'expired' ? 'No answer — kept your plan.' : 'Kept as is — you said No.';
  // Restored exactly as they were, also if their time has passed: "keep as is"
  // means the calendar looks as if Tempo had never asked (D12).
  const changes: EventChange[] = q.replacedBlocks.map((b) => ({ op: 'create', block: { ...b, reason } }));
  let learnedChanged = false;
  let estimatesChanged = false;
  if (q.kind === 'unclear-priority') {
    const est = ctx.estimates[q.taskId];
    if (est) {
      ctx.estimates[q.taskId] = { ...est, confidence: 1 };
      estimatesChanged = true;
    }
  } else {
    for (const taskId of rejectedTasks(q)) {
      ctx.learned.rejectedProposals[taskId] = (ctx.learned.rejectedProposals[taskId] ?? 0) + 1;
    }
    learnedChanged = true;
  }
  return {
    updated: { ...q, status },
    changes,
    learnedChanged,
    estimatesChanged,
    log: [`question ${q.id} (${q.kind}, ${q.taskId}): ${status} → keep plan`],
  };
}

/** Tasks whose current plan the user chose to keep. */
function rejectedTasks(q: Question): string[] {
  const ids = new Set<string>([q.taskId]);
  if (q.kind === 'big-change') {
    for (const c of q.proposal) if (c.op !== 'create') ids.add(c.taskId);
  }
  return [...ids];
}

/** Proposal changes whose block has not started yet. */
function notStarted(changes: readonly EventChange[], now: Date): EventChange[] {
  return changes.filter((c) => {
    const start = c.op === 'create' ? c.block.start : c.op === 'move' ? c.to.start : undefined;
    return !start || start.getTime() >= now.getTime();
  });
}

function withDefaultReason(c: EventChange, reason: string): EventChange {
  if (c.op === 'create') return c.block.reason ? c : { ...c, block: { ...c.block, reason } };
  return c.reason ? c : { ...c, reason };
}
