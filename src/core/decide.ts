/**
 * Step 5b — Decide: auto-apply vs. invitation (E9, D8, D9, D11, D17).
 *
 * Interpretation decisions:
 * - Auto-apply every re-plan of Tempo blocks (also to another day) unless a
 *   rule fires. Non-Tempo events are never part of a change (diff only sees
 *   Tempo blocks).
 * - Per-task questions (missed-due, dropped-task, unclear-priority) are built
 *   by the pipeline; for missed-due / dropped the task's blocks are already
 *   held at their current place (the rest is re-planned around them).
 * - big-change: more than BIG_CHANGE_MAX_BLOCKS moves, or any single move of
 *   more than BIG_CHANGE_MAX_DAYS x 24 h. Then the WHOLE re-plan is held
 *   (nothing of it is applied) and proposed in one question (Yes = apply,
 *   No = keep current blocks). The most affected block (largest shift, with a
 *   slot >= 2 h ahead) carries the invitation. If no move is askable the
 *   re-plan is held silently this run (doing nothing is always safe).
 * - One open question at a time: if a question is open (or a Maybe follow-up
 *   is about to be opened) all new questions are 'queued'; otherwise the most
 *   severe new one is 'open' and the rest 'queued'.
 *   Severity: missed-due > dropped-task > big-change > unclear-priority.
 * - De-duplication per (kind, taskId): nothing is asked about the task of the
 *   open question; a previously queued question that is detected again keeps
 *   its id (content refreshed); queued questions no longer detected are
 *   'superseded'.
 */
import { buildBigChangeQuestion, isAskableSlot, type MoveChange } from './questions.js';
import type { CurrentBlock } from './planModel.js';
import {
  BIG_CHANGE_MAX_BLOCKS,
  BIG_CHANGE_MAX_DAYS,
  type EventChange,
  type Preferences,
  type Question,
  type QuestionKind,
} from './types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BigChange {
  movedCount: number;
  maxShiftDays: number;
  /** Moves sorted by shift, largest first. */
  movesBySeverity: MoveChange[];
}

function shiftMs(m: MoveChange): number {
  return Math.abs(m.to.start.getTime() - m.from.start.getTime());
}

export function detectBigChange(changes: readonly EventChange[]): BigChange | undefined {
  const moves = changes.filter((c): c is MoveChange => c.op === 'move');
  if (moves.length === 0) return undefined;
  const sorted = [...moves].sort((a, b) => shiftMs(b) - shiftMs(a) || a.to.start.getTime() - b.to.start.getTime());
  const maxShiftDays = shiftMs(sorted[0]!) / DAY_MS;
  if (moves.length <= BIG_CHANGE_MAX_BLOCKS && maxShiftDays <= BIG_CHANGE_MAX_DAYS) return undefined;
  return { movedCount: moves.length, maxShiftDays, movesBySeverity: sorted };
}

const SEVERITY: Record<QuestionKind, number> = {
  'missed-due': 0,
  'dropped-task': 1,
  'big-change': 2,
  'unclear-priority': 3,
};

export interface DecideInput {
  now: Date;
  prefs: Preferences;
  /** Re-plan changes that would be applied automatically. */
  planned: EventChange[];
  /** Current blocks (to find the block behind a big-change move). */
  current: readonly CurrentBlock[];
  /** Per-task question candidates (missed-due, dropped-task, unclear-priority). */
  taskQuestions: readonly Question[];
  /** Machine cause of this re-plan (for the big-change text). */
  cause: string;
  /**
   * Ranges the user just accepted by answering Yes. Moves of blocks out of
   * these ranges are part of that decision, not a new big change.
   */
  acceptedRanges?: readonly { start: Date; end: Date }[];
  /** Question that stays open after this run (not answered now). */
  openQuestion?: Question;
  /** Maybe follow-up that the engine opens next. */
  followUp?: Question;
  queuedQuestions: readonly Question[];
}

export interface DecideOutput {
  apply: EventChange[];
  /** New or refreshed questions (status 'open' or 'queued'). */
  questions: Question[];
  /** Previously queued questions that are no longer relevant (status 'superseded'). */
  superseded: Question[];
  log: string[];
}

export function decide(input: DecideInput): DecideOutput {
  const log: string[] = [];
  const candidates: Question[] = [...input.taskQuestions];
  let apply = input.planned;

  const accepted = input.acceptedRanges ?? [];
  const big = detectBigChange(
    input.planned.filter(
      (c) => !(c.op === 'move' && accepted.some((r) => r.start.getTime() < c.from.end.getTime() && c.from.start.getTime() < r.end.getTime())),
    ),
  );
  if (big) {
    apply = [];
    const q = bigChangeQuestion(input, big);
    log.push(
      `decide: big change (${big.movedCount} moves, max shift ${big.maxShiftDays.toFixed(1)} d) → held` +
        (q ? `, asking via ${q.taskId}` : ', no askable slot — holding silently'),
    );
    if (q) candidates.push(q);
  }

  const { questions, superseded } = arrangeQuestions(candidates, input);
  for (const q of questions) log.push(`decide: question ${q.kind} for ${q.taskId} → ${q.status}`);
  return { apply, questions, superseded, log };
}

function bigChangeQuestion(input: DecideInput, big: BigChange): Question | undefined {
  for (const move of big.movesBySeverity) {
    if (!isAskableSlot(move.to, input.now)) continue;
    const block = input.current.find((b) => b.eventId === move.eventId);
    if (!block) continue;
    return buildBigChangeQuestion({
      now: input.now,
      prefs: input.prefs,
      changes: input.planned,
      mostAffected: move,
      mostAffectedBlock: block,
      movedCount: big.movedCount,
      cause: input.cause,
    });
  }
  return undefined;
}

function arrangeQuestions(
  candidates: readonly Question[],
  input: DecideInput,
): { questions: Question[]; superseded: Question[] } {
  const blocking = input.followUp ?? input.openQuestion;
  const seen = new Set<string>();
  const fresh: Question[] = [];
  const ordered = [...candidates].sort((a, b) => SEVERITY[a.kind] - SEVERITY[b.kind]);
  for (const q of ordered) {
    const key = `${q.kind}|${q.taskId}`;
    if (seen.has(key)) continue;
    if (blocking && q.taskId === blocking.taskId) continue;
    seen.add(key);
    const previous = input.queuedQuestions.find((old) => old.kind === q.kind && old.taskId === q.taskId);
    fresh.push(previous ? { ...q, id: previous.id, createdAt: previous.createdAt } : q);
  }

  const questions: Question[] = [];
  if (input.followUp) questions.push({ ...input.followUp, status: 'queued' });
  fresh.forEach((q, i) => questions.push({ ...q, status: !blocking && i === 0 ? 'open' : 'queued' }));

  const keptIds = new Set(fresh.map((q) => q.id));
  const superseded = input.queuedQuestions
    .filter((old) => old.status === 'queued' && !keptIds.has(old.id))
    .map((old) => ({ ...old, status: 'superseded' as const }));
  return { questions, superseded };
}
