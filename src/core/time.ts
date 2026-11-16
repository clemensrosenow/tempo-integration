/**
 * Pure time helpers for the planning core (luxon).
 *
 * - All ranges are half-open [start, end) of absolute instants (JS Date).
 * - Every wall-clock rule (working hours, focus time, sleep, "today") is
 *   evaluated in `prefs.timezone`, so DST switches are handled by luxon.
 * - Daily windows whose end is not after their start wrap midnight
 *   (e.g. sleep 23:00-07:00 belongs to the evening it starts on).
 * - Rounding is done on 5-minute boundaries of the epoch. These coincide with
 *   local 5-minute boundaries for every real-world UTC offset (all offsets
 *   are multiples of 15 minutes).
 */
import { DateTime } from 'luxon';
import type { DailyWindow, IsoWeekday, Preferences, TimeRange } from './types.js';

export const MINUTE_MS = 60_000;
export const SLOT_MIN = 5;
const SLOT_MS = SLOT_MIN * MINUTE_MS;

// ---------------------------------------------------------------------------
// Instants & single ranges
// ---------------------------------------------------------------------------

export function addMinutes(d: Date, min: number): Date {
  return new Date(d.getTime() + min * MINUTE_MS);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MINUTE_MS;
}

export function durationMin(r: TimeRange): number {
  return minutesBetween(r.start, r.end);
}

export function totalMin(rs: readonly TimeRange[]): number {
  return rs.reduce((sum, r) => sum + Math.max(0, durationMin(r)), 0);
}

export function isEmptyRange(r: TimeRange): boolean {
  return r.end.getTime() <= r.start.getTime();
}

export function overlaps(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime();
}

export function overlapMin(a: TimeRange, b: TimeRange): number {
  const start = Math.max(a.start.getTime(), b.start.getTime());
  const end = Math.min(a.end.getTime(), b.end.getTime());
  return Math.max(0, (end - start) / MINUTE_MS);
}

export function containsRange(outer: TimeRange, inner: TimeRange): boolean {
  return outer.start.getTime() <= inner.start.getTime() && inner.end.getTime() <= outer.end.getTime();
}

export function sameRange(a: TimeRange, b: TimeRange): boolean {
  return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

export function expandRange(r: TimeRange, min: number): TimeRange {
  return { start: addMinutes(r.start, -min), end: addMinutes(r.end, min) };
}

export function maxDate(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b;
}

export function minDate(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

// ---------------------------------------------------------------------------
// Rounding (5-minute grid)
// ---------------------------------------------------------------------------

export function roundUpToSlot(d: Date): Date {
  return new Date(Math.ceil(d.getTime() / SLOT_MS) * SLOT_MS);
}

export function roundDownToSlot(d: Date): Date {
  return new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS);
}

/** Round a number of minutes to the nearest multiple of 5 (at least 5). */
export function roundMinutes(min: number): number {
  return Math.max(SLOT_MIN, Math.round(min / SLOT_MIN) * SLOT_MIN);
}

/** Shrink ranges onto the 5-minute grid and drop the ones shorter than `minMin`. */
export function alignRanges(rs: readonly TimeRange[], minMin = SLOT_MIN): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of rs) {
    const aligned = { start: roundUpToSlot(r.start), end: roundDownToSlot(r.end) };
    if (durationMin(aligned) >= minMin) out.push(aligned);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Range-set operations (inputs need not be sorted; outputs are sorted & merged)
// ---------------------------------------------------------------------------

export function sortRanges<T extends TimeRange>(rs: readonly T[]): T[] {
  return [...rs].sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
}

/** Merge overlapping or touching ranges. */
export function mergeRanges(rs: readonly TimeRange[]): TimeRange[] {
  const out: TimeRange[] = [];
  for (const r of sortRanges(rs)) {
    if (isEmptyRange(r)) continue;
    const last = out[out.length - 1];
    if (last && r.start.getTime() <= last.end.getTime()) {
      if (r.end.getTime() > last.end.getTime()) last.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

/** base minus cuts. */
export function subtractRanges(base: readonly TimeRange[], cuts: readonly TimeRange[]): TimeRange[] {
  const mergedCuts = mergeRanges(cuts);
  const out: TimeRange[] = [];
  for (const b of mergeRanges(base)) {
    let cursor = b.start.getTime();
    const end = b.end.getTime();
    for (const c of mergedCuts) {
      const cs = c.start.getTime();
      const ce = c.end.getTime();
      if (ce <= cursor || cs >= end) continue;
      if (cs > cursor) out.push({ start: new Date(cursor), end: new Date(cs) });
      cursor = Math.max(cursor, ce);
      if (cursor >= end) break;
    }
    if (cursor < end) out.push({ start: new Date(cursor), end: new Date(end) });
  }
  return out;
}

export function intersectRanges(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
  const ma = mergeRanges(a);
  const mb = mergeRanges(b);
  const out: TimeRange[] = [];
  let i = 0;
  let j = 0;
  while (i < ma.length && j < mb.length) {
    const x = ma[i]!;
    const y = mb[j]!;
    const start = Math.max(x.start.getTime(), y.start.getTime());
    const end = Math.min(x.end.getTime(), y.end.getTime());
    if (start < end) out.push({ start: new Date(start), end: new Date(end) });
    if (x.end.getTime() < y.end.getTime()) i++;
    else j++;
  }
  return out;
}

export function clipRanges(rs: readonly TimeRange[], window: TimeRange): TimeRange[] {
  return intersectRanges(rs, [window]);
}

// ---------------------------------------------------------------------------
// Local wall-clock windows
// ---------------------------------------------------------------------------

export function parseLocalTime(s: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid local time "${s}" (expected HH:mm)`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    throw new Error(`Invalid local time "${s}"`);
  }
  return { hour, minute };
}

function atLocalTime(day: DateTime, t: string): DateTime {
  const { hour, minute } = parseLocalTime(t);
  if (hour === 24) return day.plus({ days: 1 }).startOf('day');
  return day.set({ hour, minute, second: 0, millisecond: 0 });
}

/** The window `w` on the local calendar day `day` (wraps into the next day if needed). */
export function dailyWindowOn(day: DateTime, w: DailyWindow): TimeRange {
  const start = atLocalTime(day, w.start);
  let end = atLocalTime(day, w.end);
  if (end.toMillis() <= start.toMillis()) end = atLocalTime(day.plus({ days: 1 }), w.end);
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/**
 * All occurrences of the daily window `w` (optionally only on `days`) that
 * intersect `span`, clipped to `span`, merged.
 */
export function localWindows(
  span: TimeRange,
  tz: string,
  w: DailyWindow,
  days?: readonly IsoWeekday[],
): TimeRange[] {
  if (isEmptyRange(span)) return [];
  const out: TimeRange[] = [];
  let day = DateTime.fromJSDate(span.start, { zone: tz }).startOf('day').minus({ days: 1 });
  const lastDay = DateTime.fromJSDate(span.end, { zone: tz }).startOf('day');
  while (day.toMillis() <= lastDay.toMillis()) {
    if (!days || days.includes(day.weekday as IsoWeekday)) out.push(dailyWindowOn(day, w));
    day = day.plus({ days: 1 });
  }
  return clipRanges(out, span);
}

export function workingWindows(span: TimeRange, prefs: Preferences): TimeRange[] {
  const wh = prefs.workingHours;
  const perDay = wh.perDay;
  if (!perDay || Object.keys(perDay).length === 0) return localWindows(span, prefs.timezone, wh, wh.days);
  // One window per working day, each with its own hours.
  return sortRanges(
    wh.days.flatMap((d) => localWindows(span, prefs.timezone, perDay[d] ?? wh, [d])),
  );
}

export function focusWindows(span: TimeRange, prefs: Preferences): TimeRange[] {
  return localWindows(span, prefs.timezone, prefs.focusTime);
}

export function sleepWindows(span: TimeRange, prefs: Preferences): TimeRange[] {
  return localWindows(span, prefs.timezone, prefs.sleep);
}

// ---------------------------------------------------------------------------
// Local calendar helpers
// ---------------------------------------------------------------------------

export function toLocal(d: Date, tz: string): DateTime {
  return DateTime.fromJSDate(d, { zone: tz });
}

export function startOfLocalDay(d: Date, tz: string): Date {
  return toLocal(d, tz).startOf('day').toJSDate();
}

export function startOfNextLocalDay(d: Date, tz: string): Date {
  return toLocal(d, tz).startOf('day').plus({ days: 1 }).toJSDate();
}

/** Whole local calendar days from the day of `a` to the day of `b` (b later => positive). */
export function localDayDiff(a: Date, b: Date, tz: string): number {
  const da = toLocal(a, tz).startOf('day');
  const db = toLocal(b, tz).startOf('day');
  return Math.round(db.diff(da, 'days').days);
}

export function localHour(d: Date, tz: string): number {
  return toLocal(d, tz).hour;
}

/** e.g. "Fri 20 Nov 14:00" — used in question titles/descriptions and reasons. */
export function formatLocal(d: Date, tz: string, pattern = 'ccc d LLL HH:mm'): string {
  return toLocal(d, tz).setLocale('en-GB').toFormat(pattern);
}

export function formatLocalDay(d: Date, tz: string): string {
  return formatLocal(d, tz, 'ccc d LLL');
}
