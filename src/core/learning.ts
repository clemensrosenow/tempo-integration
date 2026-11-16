/**
 * E12 — Learning by doing (D13, D14): drags and resizes become preferences.
 *
 * Interpretation decisions:
 * - Resize = the block's duration changed. The task's total duration becomes
 *   (current total + delta) and is stored in `taskDurationMin[taskId]`; the
 *   global `durationScale` moves towards (new total / raw LLM estimate) with
 *   an EMA (alpha 0.3, clamped 0.5..3).
 * - Drag = start AND end changed (the block was moved). The local hour of the
 *   new start gets `hourAffinity += 1`; all other hours decay by 10 %.
 *   Moving only one edge is a resize, not a drag; moving both edges with a
 *   new length is both.
 * - The block stays exactly where the user put it: a 'move' to the same
 *   times carries the "Tempo learned: …" line(s), which refreshes the
 *   description and plannedStart/End (so the signal is not seen again).
 * - Block ended while its task is still open: durationScale is nudged up by
 *   0.05; the remaining need becomes max(total - worked, minChunk).
 * - Dragging again simply overrides (story 41): the newest drag/resize wins
 *   for the duration and adds affinity for the new hour.
 */
import { durationMin, localHour, roundMinutes } from './time.js';
import type { EventChange, LearnedPreferences, Signal } from './types.js';

export const DURATION_EMA_ALPHA = 0.3;
export const DURATION_SCALE_MIN = 0.5;
export const DURATION_SCALE_MAX = 3;
export const AFFINITY_DECAY = 0.9;
export const ENDED_OPEN_NUDGE = 0.05;

export type BlockMovedSignal = Extract<Signal, { type: 'block-moved-by-user' }>;

function clampScale(x: number): number {
  return Math.min(DURATION_SCALE_MAX, Math.max(DURATION_SCALE_MIN, x));
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

/** Duration of a task after learned overrides (per-task resize wins over the global scale). */
export function scaledDurationMin(rawMin: number, taskId: string, learned: LearnedPreferences): number {
  const override = learned.taskDurationMin[taskId];
  if (override !== undefined) return override;
  return roundMinutes(rawMin * learned.durationScale);
}

/**
 * Remaining work: total minus minutes already worked in past blocks, but at
 * least one chunk while the task is still open. A total of 0 means "dropped".
 */
export function remainingNeedMin(totalMin: number, workedMin: number, minChunkMin: number): number {
  if (totalMin <= 0) return 0;
  if (workedMin <= 0) return totalMin;
  return Math.max(roundMinutes(totalMin - workedMin), minChunkMin);
}

export interface UserMoveInput {
  signal: BlockMovedSignal;
  title: string;
  tz: string;
  /** Mutated in place. */
  learned: LearnedPreferences;
  /** The task's total duration Tempo currently plans with. */
  currentTotalMin: number;
  /** Raw (unscaled) LLM estimate, if known. */
  rawEstimateMin?: number;
}

export interface UserMoveResult {
  change: EventChange;
  lines: string[];
  resized: boolean;
  dragged: boolean;
}

export function learnFromUserMove(input: UserMoveInput): UserMoveResult {
  const { signal, learned, tz } = input;
  const oldLen = durationMin(signal.from);
  const newLen = durationMin(signal.to);
  const startMoved = signal.from.start.getTime() !== signal.to.start.getTime();
  const endMoved = signal.from.end.getTime() !== signal.to.end.getTime();
  const resized = Math.abs(newLen - oldLen) >= 1;
  const dragged = startMoved && endMoved;
  const lines: string[] = [];

  if (resized) {
    const total = Math.max(5, Math.round(input.currentTotalMin + (newLen - oldLen)));
    learned.taskDurationMin[signal.taskId] = total;
    if (input.rawEstimateMin && input.rawEstimateMin > 0) {
      const ratio = total / input.rawEstimateMin;
      learned.durationScale = round2(clampScale((1 - DURATION_EMA_ALPHA) * learned.durationScale + DURATION_EMA_ALPHA * ratio));
    }
    lines.push(`Tempo learned: '${input.title}' takes ~${total} min`);
  }
  if (dragged) {
    const hour = localHour(signal.to.start, tz);
    for (const key of Object.keys(learned.hourAffinity)) {
      const h = Number(key);
      if (h !== hour) learned.hourAffinity[h] = round2((learned.hourAffinity[h] ?? 0) * AFFINITY_DECAY);
    }
    learned.hourAffinity[hour] = round2((learned.hourAffinity[hour] ?? 0) + 1);
    lines.push(`Tempo learned: you prefer this kind of work around ${String(hour).padStart(2, '0')}:00`);
  }
  learned.notes.push(...lines);

  return {
    change: {
      op: 'move',
      eventId: signal.eventId,
      taskId: signal.taskId,
      from: { start: signal.to.start, end: signal.to.end },
      to: { start: signal.to.start, end: signal.to.end },
      reason: 'Kept where you put it.',
      learned: lines,
    },
    lines,
    resized,
    dragged,
  };
}

/** A block ended but its task is still open: estimates tend to be too short. */
export function learnFromEndedBlock(learned: LearnedPreferences): void {
  learned.durationScale = round2(clampScale(learned.durationScale + ENDED_OPEN_NUDGE));
}
