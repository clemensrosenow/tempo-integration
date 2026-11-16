/**
 * Step 2 — Find gaps (pure code).
 *
 * Free time = working hours on working days, inside
 * [now + LOCK_WINDOW_MIN, now + horizonDays], minus
 *   - busy fixed events (isBusyFixedEvent) widened by prefs.bufferMin,
 *   - sleep,
 *   - Tempo blocks that will not be re-placed this run:
 *       * locked blocks (already running or starting inside the lock window),
 *         EXCEPT locked blocks that now overlap a busy fixed event (meeting
 *         overrun) — those are released and moved out (see diff.ts),
 *       * blocks and question events of frozen tasks (task of the open question),
 *   - `reserved` ranges supplied by the caller (pinned blocks, the open
 *     question's slot / replaced blocks / proposal targets).
 *
 * Interpretation: all other Tempo blocks are NOT subtracted — they are exactly
 * what the planner re-places (minimal change keeps them when still valid).
 * Free / declined / cancelled / all-day events count as available time (E7).
 * Gaps are aligned to the 5-minute grid; pieces shorter than 5 minutes vanish.
 */
import {
  addMinutes,
  alignRanges,
  expandRange,
  intersectRanges,
  overlaps,
  roundUpToSlot,
  sleepWindows,
  subtractRanges,
  workingWindows,
} from './time.js';
import {
  isBusyFixedEvent,
  isTempoBlock,
  LOCK_WINDOW_MIN,
  type CalendarEvent,
  type Preferences,
  type TimeRange,
} from './types.js';

export interface FindGapsInput {
  now: Date;
  events: readonly CalendarEvent[];
  prefs: Preferences;
  horizonDays: number;
  /** Tasks whose blocks are frozen (task of the open question). */
  frozenTaskIds?: Iterable<string>;
  /** Additional ranges that must stay free of new placements. */
  reserved?: readonly TimeRange[];
}

/** End of the lock window: nothing is ever created or moved before this instant. */
export function lockEnd(now: Date): Date {
  return addMinutes(now, LOCK_WINDOW_MIN);
}

/** [now + lock window (rounded up to 5 min), now + horizon). */
export function planningWindow(now: Date, horizonDays: number): TimeRange {
  return { start: roundUpToSlot(lockEnd(now)), end: addMinutes(now, horizonDays * 24 * 60) };
}

/** Busy fixed events as raw ranges (no buffer). */
export function busyFixedRanges(events: readonly CalendarEvent[]): TimeRange[] {
  return events.filter(isBusyFixedEvent).map((e) => ({ start: e.start, end: e.end }));
}

/** True if a Tempo block is locked: it is running or starts inside the lock window. */
export function isLockedBlock(e: TimeRange, now: Date): boolean {
  return e.end.getTime() > now.getTime() && e.start.getTime() < lockEnd(now).getTime();
}

/** A locked block that now overlaps a busy fixed event is released (moved out of the conflict). */
export function isReleasedLockedBlock(e: TimeRange, now: Date, busy: readonly TimeRange[]): boolean {
  return isLockedBlock(e, now) && busy.some((b) => overlaps(b, e));
}

export function findGaps(input: FindGapsInput): TimeRange[] {
  const { now, events, prefs, horizonDays } = input;
  const window = planningWindow(now, horizonDays);
  if (window.end.getTime() <= window.start.getTime()) return [];

  const frozen = new Set(input.frozenTaskIds ?? []);
  const busy = busyFixedRanges(events);
  const cuts: TimeRange[] = [
    ...busy.map((b) => expandRange(b, prefs.bufferMin)),
    ...sleepWindows(window, prefs),
    ...(input.reserved ?? []),
  ];

  for (const e of events) {
    if (!e.tempo || e.status === 'cancelled') continue;
    const range = { start: e.start, end: e.end };
    if (frozen.has(e.tempo.taskId)) {
      cuts.push(range);
      continue;
    }
    if (isTempoBlock(e) && isLockedBlock(range, now) && !isReleasedLockedBlock(range, now, busy)) {
      cuts.push(range);
    }
  }

  const working = intersectRanges(workingWindows(window, prefs), [window]);
  return alignRanges(subtractRanges(working, cuts));
}
