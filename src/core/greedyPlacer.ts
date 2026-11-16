/**
 * Deterministic greedy placer — used when `llm.place` returns null or keeps
 * failing the Check step, and as the feasibility oracle for checking LLM output.
 *
 * Interpretation decisions:
 * - Order: (deadline feasibility, urgency desc, priority desc, due asc).
 *   Feasibility classes: 0 = due inside the horizon and enough free time before
 *   it, 1 = no due (or due beyond the horizon), 2 = due cannot be met anyway.
 *   Subtasks of one parent form a group that is sorted by its best member and
 *   placed strictly in `position` order.
 * - Urgent work (urgency >= 4 or due today) is placed first, before any
 *   existing block of other tasks is reserved, so it lands today whenever
 *   today has a gap (E5). Its own existing blocks are kept only if they are
 *   today (or if today has no room at all).
 * - Minimal change: for all other tasks, existing blocks are reserved first if
 *   still valid (inside the free gaps, before due unless lateness is already
 *   accepted, subtask order ok); new demand only fills the remaining space.
 * - New chunks: earliest local day first; on the same day deep-work tasks
 *   prefer focus time, then learned `hourAffinity` breaks ties, then earliest
 *   start. Chunks are >= minChunkMin (except when the whole remaining need is
 *   smaller); there is no maximum block length.
 * - Pass 1 places before the due; whatever does not fit is placed late
 *   (pass 2). Late => "missed-due"; nothing placed at all => "dropped".
 */
import {
  clipRanges,
  containsRange,
  durationMin,
  focusWindows,
  localDayDiff,
  localHour,
  maxDate,
  mergeRanges,
  minDate,
  overlapMin,
  overlaps,
  roundDownToSlot,
  sortRanges,
  startOfNextLocalDay,
  subtractRanges,
  toLocal,
  totalMin,
  addMinutes,
} from './time.js';
import type { PlanItem, TaskBlock } from './planModel.js';
import type { Placement } from './ports.js';
import type { Preferences, TimeRange } from './types.js';

export interface GreedyInput {
  now: Date;
  prefs: Preferences;
  items: readonly PlanItem[];
  /** Free gaps (findGaps output, minus anything pinned). */
  gaps: readonly TimeRange[];
  /** Current movable blocks — kept when still valid (minimal change). */
  existing?: readonly TaskBlock[];
  /** Blocks that stay where they are (used for subtask order constraints). */
  pinned?: readonly TaskBlock[];
  /** End of the planning horizon (defaults to the end of the last gap). */
  horizonEnd?: Date;
}

export interface GreedyResult {
  placements: Placement[];
  /** Tasks whose plan ends after their due or that cannot finish before a due inside the horizon. */
  late: string[];
  /** Tasks with need > 0 of which nothing could be placed within the horizon. */
  dropped: string[];
  /** Minutes that could not be placed, per task (only tasks with a remainder). */
  unplacedMin: Record<string, number>;
}

const FAR_PAST = new Date(0);
const FAR_FUTURE = new Date(8.64e15);

interface ItemState {
  item: PlanItem;
  blocks: TimeRange[];
  remaining: number;
}

/** Mutable set of free ranges. */
class FreeSpace {
  ranges: TimeRange[];
  constructor(ranges: readonly TimeRange[]) {
    this.ranges = mergeRanges(ranges);
  }
  take(r: TimeRange): void {
    this.ranges = subtractRanges(this.ranges, [r]);
  }
  give(r: TimeRange): void {
    this.ranges = mergeRanges([...this.ranges, r]);
  }
  fits(r: TimeRange): boolean {
    return this.ranges.some((f) => containsRange(f, r));
  }
}

export function isUrgent(item: PlanItem, now: Date, tz: string): boolean {
  if (item.urgency >= 4) return true;
  return item.due !== undefined && item.due.getTime() <= startOfNextLocalDay(now, tz).getTime();
}

export function greedyPlace(input: GreedyInput): GreedyResult {
  return new GreedyPlacer(input).run();
}

class GreedyPlacer {
  private readonly tz: string;
  private readonly free: FreeSpace;
  private readonly states = new Map<string, ItemState>();
  private readonly existingByTask = new Map<string, TimeRange[]>();
  private readonly horizonEnd: Date;

  constructor(private readonly input: GreedyInput) {
    this.tz = input.prefs.timezone;
    this.free = new FreeSpace(input.gaps);
    const lastGap = this.free.ranges[this.free.ranges.length - 1];
    this.horizonEnd = input.horizonEnd ?? lastGap?.end ?? input.now;
    for (const item of input.items) {
      this.states.set(item.taskId, { item, blocks: [], remaining: Math.max(0, item.needMin) });
    }
    for (const b of input.existing ?? []) {
      const list = this.existingByTask.get(b.taskId) ?? [];
      list.push({ start: b.start, end: b.end });
      this.existingByTask.set(b.taskId, list);
    }
  }

  run(): GreedyResult {
    const groups = this.orderedGroups();
    const urgent = groups.filter((g) => g.some((s) => isUrgent(s.item, this.input.now, this.tz)));
    const normal = groups.filter((g) => !urgent.includes(g));

    for (const group of urgent) {
      for (const state of group) {
        this.reserveExisting(state, this.hasRoomToday(state));
        this.placeRemaining(state, group);
      }
    }
    for (const group of normal) for (const state of group) this.reserveExisting(state, false);
    for (const group of normal) for (const state of group) this.placeRemaining(state, group);

    return this.result();
  }

  // -- ordering --------------------------------------------------------------

  private orderedGroups(): ItemState[][] {
    const byGroup = new Map<string, ItemState[]>();
    for (const state of this.states.values()) {
      const key = state.item.orderGroup ?? `task:${state.item.taskId}`;
      const list = byGroup.get(key) ?? [];
      list.push(state);
      byGroup.set(key, list);
    }
    const groups = [...byGroup.values()].map((g) =>
      g.sort((a, b) => (a.item.orderIndex ?? 0) - (b.item.orderIndex ?? 0) || cmp(a.item.taskId, b.item.taskId)),
    );
    const groupKey = (g: ItemState[]): Array<number | string> =>
      g.map((s) => this.sortKey(s.item)).sort(compareKeys)[0] ?? [];
    return groups.sort((a, b) => compareKeys(groupKey(a), groupKey(b)));
  }

  private sortKey(item: PlanItem): Array<number | string> {
    return [this.feasibilityClass(item), -item.urgency, -item.priority, item.due?.getTime() ?? Infinity, item.taskId];
  }

  private feasibilityClass(item: PlanItem): number {
    if (!item.due || item.due.getTime() > this.horizonEnd.getTime()) return 1;
    const before = totalMin(clipRanges(this.input.gaps, { start: FAR_PAST, end: item.due }));
    return before >= item.needMin ? 0 : 2;
  }

  // -- order constraints (subtasks) --------------------------------------------

  private groupMembers(item: PlanItem): ItemState[] {
    if (!item.orderGroup) return [];
    return [...this.states.values()].filter((s) => s.item.orderGroup === item.orderGroup);
  }

  private lowerBound(item: PlanItem): Date {
    let lb = FAR_PAST;
    if (!item.orderGroup) return lb;
    const idx = item.orderIndex ?? 0;
    for (const s of this.groupMembers(item)) {
      if ((s.item.orderIndex ?? 0) >= idx) continue;
      for (const b of s.blocks) lb = maxDate(lb, b.end);
    }
    for (const p of this.input.pinned ?? []) {
      const s = this.states.get(p.taskId);
      const pIdx = s?.item.orderGroup === item.orderGroup ? (s.item.orderIndex ?? 0) : undefined;
      if (pIdx !== undefined && pIdx < idx) lb = maxDate(lb, p.end);
    }
    return lb;
  }

  private upperBound(item: PlanItem): Date | undefined {
    if (!item.orderGroup) return undefined;
    const idx = item.orderIndex ?? 0;
    let ub: Date | undefined;
    for (const s of this.groupMembers(item)) {
      if ((s.item.orderIndex ?? 0) <= idx) continue;
      for (const b of s.blocks) ub = ub ? minDate(ub, b.start) : b.start;
    }
    return ub;
  }

  // -- reserving existing blocks (minimal change) ------------------------------

  private hasRoomToday(state: ItemState): boolean {
    const today = { start: this.input.now, end: startOfNextLocalDay(this.input.now, this.tz) };
    const lb = this.lowerBound(state.item);
    const minLen = Math.min(state.remaining, state.item.minChunkMin);
    const room = subtractRanges(clipRanges(this.free.ranges, today), state.item.avoid).filter(
      (r) => r.end.getTime() > lb.getTime(),
    );
    return room.some((r) => durationMin({ start: maxDate(r.start, lb), end: r.end }) >= minLen);
  }

  private reserveExisting(state: ItemState, todayOnly: boolean): void {
    const { item } = state;
    const lb = this.lowerBound(item);
    for (const r of sortRanges(this.existingByTask.get(item.taskId) ?? [])) {
      if (state.remaining <= 0) break;
      if (todayOnly && localDayDiff(this.input.now, r.start, this.tz) !== 0) continue;
      if (!this.isValidExisting(item, r, lb)) continue;
      const len = Math.min(durationMin(r), state.remaining);
      const kept = { start: r.start, end: addMinutes(r.start, len) };
      this.commit(state, kept);
    }
  }

  private isValidExisting(item: PlanItem, r: TimeRange, lb: Date): boolean {
    if (!this.free.fits(r)) return false;
    if (item.avoid.some((a) => overlaps(a, r))) return false;
    if (r.start.getTime() < lb.getTime()) return false;
    if (item.due && !item.lateOk && r.end.getTime() > item.due.getTime()) return false;
    return true;
  }

  // -- placing new chunks --------------------------------------------------------

  private placeRemaining(state: ItemState, group: ItemState[]): void {
    if (state.remaining <= 0) return;
    const ub = this.upperBound(state.item);
    const placed = this.fillWithDuePreference(state, ub);
    if (state.remaining > 0 && ub) {
      // Subtask order would force lateness: release the later subtasks' kept
      // blocks (they are placed again after this one) and retry without bound.
      for (const r of placed) this.undo(state, r);
      this.releaseLaterMembers(state.item, group);
      this.fillWithDuePreference(state, undefined);
    }
  }

  private releaseLaterMembers(item: PlanItem, group: ItemState[]): void {
    const idx = item.orderIndex ?? 0;
    for (const s of group) {
      if ((s.item.orderIndex ?? 0) <= idx) continue;
      for (const b of [...s.blocks]) this.undo(s, b);
    }
  }

  private fillWithDuePreference(state: ItemState, ub: Date | undefined): TimeRange[] {
    const due = state.item.due;
    const placed: TimeRange[] = [];
    if (due) placed.push(...this.fill(state, ub ? minDate(due, ub) : due));
    if (state.remaining > 0) placed.push(...this.fill(state, ub));
    return placed;
  }

  private fill(state: ItemState, end: Date | undefined): TimeRange[] {
    const placed: TimeRange[] = [];
    for (;;) {
      if (state.remaining <= 0) break;
      const chunk = this.bestChunk(state, end);
      if (!chunk) break;
      this.commit(state, chunk);
      placed.push(chunk);
    }
    return placed;
  }

  private bestChunk(state: ItemState, end: Date | undefined): TimeRange | undefined {
    const { item } = state;
    const window = { start: this.lowerBound(item), end: end ?? FAR_FUTURE };
    if (window.end.getTime() <= window.start.getTime()) return undefined;
    const ranges = subtractRanges(clipRanges(this.free.ranges, window), item.avoid);
    let best: { chunk: TimeRange; score: number[] } | undefined;
    for (const r of ranges) {
      for (const start of this.candidateStarts(item, r)) {
        const len = chunkLength(state.remaining, durationMin({ start, end: r.end }), item.minChunkMin);
        if (len === undefined) continue;
        const chunk = { start, end: addMinutes(start, len) };
        const score = this.score(item, chunk);
        if (!best || compareKeys(score, best.score) < 0) best = { chunk, score };
      }
    }
    return best?.chunk;
  }

  private candidateStarts(item: PlanItem, r: TimeRange): Date[] {
    const starts = new Map<number, Date>([[r.start.getTime(), r.start]]);
    if (item.deepWork) {
      for (const f of focusWindows(r, this.input.prefs)) starts.set(f.start.getTime(), f.start);
    }
    const hours = Object.entries(this.input.prefs.learned.hourAffinity)
      .filter(([, v]) => v > 0)
      .map(([h]) => Number(h));
    if (hours.length > 0) {
      let day = toLocal(r.start, this.tz).startOf('day');
      const last = toLocal(r.end, this.tz).startOf('day');
      while (day.toMillis() <= last.toMillis()) {
        for (const h of hours) {
          const t = roundDownToSlot(day.set({ hour: h, minute: 0 }).toJSDate());
          if (t.getTime() >= r.start.getTime() && t.getTime() < r.end.getTime()) starts.set(t.getTime(), t);
        }
        day = day.plus({ days: 1 });
      }
    }
    return [...starts.values()];
  }

  private score(item: PlanItem, chunk: TimeRange): number[] {
    const day = localDayDiff(this.input.now, chunk.start, this.tz);
    let focusMiss = 0;
    if (item.deepWork) {
      const inFocus = focusWindows(chunk, this.input.prefs).reduce((s, f) => s + overlapMin(f, chunk), 0);
      focusMiss = 1 - inFocus / durationMin(chunk);
    }
    const affinity = this.input.prefs.learned.hourAffinity[localHour(chunk.start, this.tz)] ?? 0;
    return [day, focusMiss, -affinity, chunk.start.getTime()];
  }

  // -- bookkeeping -----------------------------------------------------------------

  private commit(state: ItemState, r: TimeRange): void {
    this.free.take(r);
    state.blocks.push(r);
    state.remaining -= durationMin(r);
  }

  private undo(state: ItemState, r: TimeRange): void {
    const idx = state.blocks.indexOf(r);
    if (idx < 0) return;
    state.blocks.splice(idx, 1);
    state.remaining += durationMin(r);
    this.free.give(r);
  }

  private result(): GreedyResult {
    const placements: Placement[] = [];
    for (const { item, blocks } of this.states.values()) {
      for (const b of blocks) placements.push({ taskId: item.taskId, start: b.start, end: b.end });
    }
    return assessPlacements(this.input.items, placements, this.horizonEnd);
  }
}

/**
 * Classify a complete placement (greedy or LLM): late tasks (end after due, or
 * cannot finish before a due inside the horizon), dropped tasks (nothing
 * placed) and unplaced minutes.
 */
export function assessPlacements(
  items: readonly PlanItem[],
  placements: readonly Placement[],
  horizonEnd: Date,
): GreedyResult {
  const late: string[] = [];
  const dropped: string[] = [];
  const unplacedMin: Record<string, number> = {};
  for (const item of items) {
    const blocks = placements.filter((p) => p.taskId === item.taskId);
    const placed = blocks.reduce((s, b) => s + durationMin(b), 0);
    const remaining = Math.max(0, item.needMin - placed);
    if (remaining > 0) unplacedMin[item.taskId] = remaining;
    if (item.needMin > 0 && blocks.length === 0) {
      dropped.push(item.taskId);
      continue;
    }
    const due = item.due;
    if (!due) continue;
    const endsLate = blocks.some((b) => b.end.getTime() > due.getTime());
    const cannotFinish = remaining > 0 && due.getTime() <= horizonEnd.getTime();
    if (endsLate || cannotFinish) late.push(item.taskId);
  }
  const sorted = [...placements].sort((a, b) => a.start.getTime() - b.start.getTime() || cmp(a.taskId, b.taskId));
  return { placements: sorted, late, dropped, unplacedMin };
}

/**
 * Length of the next chunk given the remaining need and the available minutes
 * from the candidate start, or undefined if no valid chunk fits.
 * Never leaves a remainder shorter than minChunk.
 */
export function chunkLength(remaining: number, available: number, minChunk: number): number | undefined {
  const avail = Math.floor(available / 5) * 5;
  if (avail >= remaining) return remaining;
  if (avail < minChunk) return undefined;
  let len = avail;
  if (remaining - len < minChunk) len = remaining - minChunk;
  return len >= minChunk ? len : undefined;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareKeys(a: ReadonlyArray<number | string>, b: ReadonlyArray<number | string>): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return cmp(String(x), String(y));
  }
  return 0;
}
