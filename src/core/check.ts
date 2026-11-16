/**
 * Step 4 — Check (pure code). Validates a set of placements and returns
 * human-readable errors (fed back to the LLM, max 2 retries, then greedy).
 *
 * Interpretation decisions:
 * - "Inside working hours/gaps": every placement must lie inside ONE free gap
 *   (gaps already exclude busy fixed events + buffer, sleep, the lock window,
 *   pinned blocks and non-working time).
 * - "Before due (or flagged)": ending after the due is only allowed for tasks
 *   in `allowLate` (the deterministic placer could not fit them before the due
 *   either, or lateness was already accepted).
 * - "Durations sum to the needed duration": exact (±1 min), except tasks in
 *   `allowShort` (they do not fit in the horizon) may get less or nothing.
 * - Subtask order is enforced among placements and against pinned blocks of
 *   earlier subtasks; pinned blocks of later subtasks are the user's choice and
 *   are not treated as a violation.
 * - Minimum chunk length is a placement preference, not a validity rule.
 */
import { durationMin, formatLocal, overlaps, sortRanges, workingWindows } from './time.js';
import { lockEnd } from './gaps.js';
import type { PlanItem, TaskBlock } from './planModel.js';
import type { Placement } from './ports.js';
import type { Preferences, TimeRange } from './types.js';

export interface CheckContext {
  now: Date;
  prefs: Preferences;
  items: readonly PlanItem[];
  /** Free gaps the placements must lie in. */
  gaps: readonly TimeRange[];
  /** Busy fixed events (raw, without buffer). */
  busy: readonly TimeRange[];
  /** Blocks that stay where they are this run. */
  pinned?: readonly TaskBlock[];
  /** Tasks that may end after their due. */
  allowLate?: ReadonlySet<string>;
  /** Tasks that may receive less than their need (or nothing). */
  allowShort?: ReadonlySet<string>;
}

export function checkPlacements(placements: readonly Placement[], ctx: CheckContext): string[] {
  const items = new Map(ctx.items.map((i) => [i.taskId, i]));
  const errors: string[] = [];
  const fmt = (r: TimeRange): string => describe(r, ctx.prefs.timezone);

  for (const p of placements) {
    const item = items.get(p.taskId);
    if (!item) {
      errors.push(`Unknown task id "${p.taskId}" — only place the given tasks.`);
      continue;
    }
    errors.push(...checkSingle(p, item, ctx, fmt));
  }
  errors.push(...checkOverlaps(placements, ctx, items, fmt));
  errors.push(...checkOrder(placements, ctx, items, fmt));
  errors.push(...checkSums(placements, ctx));
  return errors;
}

function checkSingle(
  p: Placement,
  item: PlanItem,
  ctx: CheckContext,
  fmt: (r: TimeRange) => string,
): string[] {
  const errors: string[] = [];
  const label = `'${item.title}' ${fmt(p)}`;
  if (p.end.getTime() <= p.start.getTime()) return [`${label}: end must be after start.`];
  const lock = lockEnd(ctx.now);
  if (p.start.getTime() < lock.getTime()) {
    errors.push(`${label} starts inside the locked next hour (nothing may start before ${formatLocal(lock, ctx.prefs.timezone, 'HH:mm')}).`);
  }
  const fixed = ctx.busy.find((b) => overlaps(b, p));
  if (fixed) errors.push(`${label} overlaps a fixed event (${fmt(fixed)}).`);
  if (!ctx.gaps.some((g) => g.start.getTime() <= p.start.getTime() && p.end.getTime() <= g.end.getTime())) {
    const inWork = workingWindows(p, ctx.prefs).reduce((s, w) => s + durationMin(w), 0) >= durationMin(p);
    errors.push(inWork ? `${label} is not inside a free gap.` : `${label} is outside working hours.`);
  }
  if (item.due && p.end.getTime() > item.due.getTime() && !item.lateOk && !ctx.allowLate?.has(item.taskId)) {
    errors.push(`${label} ends after its due (${formatLocal(item.due, ctx.prefs.timezone)}) although it fits before.`);
  }
  if (item.avoid.some((a) => overlaps(a, p))) errors.push(`${label} uses a slot the user removed.`);
  return errors;
}

function checkOverlaps(
  placements: readonly Placement[],
  ctx: CheckContext,
  items: Map<string, PlanItem>,
  fmt: (r: TimeRange) => string,
): string[] {
  const errors: string[] = [];
  const title = (id: string): string => items.get(id)?.title ?? id;
  const sorted = sortRanges(placements);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.start.getTime() >= a.end.getTime()) break;
      errors.push(`'${title(a.taskId)}' ${fmt(a)} overlaps '${title(b.taskId)}' ${fmt(b)}.`);
    }
    for (const pin of ctx.pinned ?? []) {
      if (overlaps(pin, a)) errors.push(`'${title(a.taskId)}' ${fmt(a)} overlaps a block that must stay (${fmt(pin)}).`);
    }
  }
  return errors;
}

function checkOrder(
  placements: readonly Placement[],
  ctx: CheckContext,
  items: Map<string, PlanItem>,
  fmt: (r: TimeRange) => string,
): string[] {
  const errors: string[] = [];
  const all = [...placements.map((p) => ({ ...p, pinned: false })), ...(ctx.pinned ?? []).map((p) => ({ ...p, pinned: true }))];
  for (const later of placements) {
    const li = items.get(later.taskId);
    if (!li?.orderGroup) continue;
    for (const earlier of all) {
      const ei = items.get(earlier.taskId);
      if (!ei || ei.orderGroup !== li.orderGroup) continue;
      if ((ei.orderIndex ?? 0) >= (li.orderIndex ?? 0)) continue;
      if (earlier.end.getTime() > later.start.getTime()) {
        errors.push(`Subtask '${li.title}' ${fmt(later)} must come after '${ei.title}' ${fmt(earlier)}.`);
      }
    }
  }
  return errors;
}

function checkSums(placements: readonly Placement[], ctx: CheckContext): string[] {
  const errors: string[] = [];
  for (const item of ctx.items) {
    const got = placements.filter((p) => p.taskId === item.taskId).reduce((s, p) => s + durationMin(p), 0);
    if (Math.abs(got - item.needMin) <= 1) continue;
    if (got < item.needMin && ctx.allowShort?.has(item.taskId)) continue;
    errors.push(`'${item.title}' needs ${item.needMin} min in total but got ${Math.round(got)} min.`);
  }
  return errors;
}

function describe(r: TimeRange, tz: string): string {
  return `${formatLocal(r.start, tz)}–${formatLocal(r.end, tz, 'HH:mm')}`;
}
