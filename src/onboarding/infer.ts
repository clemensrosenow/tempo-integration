/**
 * One-step start (E1 / D18): pre-fill working days and hours, focus time,
 * sleep and the calendar selection from the last 4 weeks of calendar history.
 * Thin history (< 10 events) falls back to defaults (user story 4).
 *
 * Pure function: no I/O. `evidence` explains every value in plain language.
 */
import { DateTime } from 'luxon';
import {
  type CalendarEvent,
  type CalendarInfo,
  type DailyWindow,
  emptyLearned,
  type IsoWeekday,
  type Preferences,
} from '../core/types.js';

export interface InferInput {
  events: CalendarEvent[];
  calendars: CalendarInfo[];
  timezone: string;
  now: Date;
}

export interface InferResult {
  prefs: Preferences;
  evidence: string[];
}

export const DEFAULT_WORKING_DAYS: IsoWeekday[] = [1, 2, 3, 4, 5];
export const DEFAULT_WORKING_HOURS: DailyWindow = { start: '09:00', end: '18:00' };
export const DEFAULT_FOCUS_TIME: DailyWindow = { start: '09:00', end: '12:00' };
export const DEFAULT_SLEEP: DailyWindow = { start: '23:00', end: '07:00' };
export const DEFAULT_BUFFER_MIN = 5;

const HISTORY_WEEKS = 4;
const MIN_EVENTS = 10;
const EARLIEST_WORK = 7 * 60; // 07:00
const LATEST_WORK = 21 * 60; // 21:00
const MIN_WORK_SPAN = 8 * 60;
const FOCUS_SPAN = 3 * 60;
/** An event starting at/after 17:00 after a break of >= 90 min counts as personal (gym, dinner). */
const EVENING_FROM = 17 * 60;
const EVENING_GAP = 90;
const WEEKDAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A history event as minutes relative to its local start day. */
interface DayEvent {
  date: string; // yyyy-MM-dd (local)
  weekday: IsoWeekday;
  week: number; // 0 = most recent week
  start: number; // minutes since local midnight
  end: number; // may exceed 1440 if it ends after midnight
}

export function inferPreferences(input: InferInput): InferResult {
  const { timezone } = input;
  const evidence: string[] = [];
  const selection = selectCalendars(input.calendars);
  const history = historyEvents(input, new Set(selection.ids));

  const base = {
    timezone,
    selectedCalendarIds: selection.ids,
    bufferMin: DEFAULT_BUFFER_MIN,
    learned: emptyLearned(),
  };

  if (history.length < MIN_EVENTS) {
    evidence.push(
      `Only ${history.length} event${history.length === 1 ? '' : 's'} in the last 4 weeks, so Tempo starts with defaults: ` +
        `Mon–Fri ${fmtWindow(DEFAULT_WORKING_HOURS)}, focus ${fmtWindow(DEFAULT_FOCUS_TIME)}, sleep ${fmtWindow(DEFAULT_SLEEP)}. ` +
        'Plans will adapt as you drag blocks.',
    );
    evidence.push(...selection.evidence);
    return {
      prefs: {
        ...base,
        workingHours: { ...DEFAULT_WORKING_HOURS, days: [...DEFAULT_WORKING_DAYS] },
        focusTime: { ...DEFAULT_FOCUS_TIME },
        sleep: { ...DEFAULT_SLEEP },
      },
      evidence,
    };
  }

  const days = inferWorkingDays(history, evidence);
  const perDay = dailySpans(history.filter((e) => days.includes(e.weekday)));
  const workingHours = inferWorkingHours(perDay, evidence);
  const sleep = inferSleep(dailySpans(history), evidence);
  const focusTime = inferFocusTime(history.filter((e) => days.includes(e.weekday)), workingHours, evidence);
  evidence.push(...selection.evidence);

  return {
    prefs: { ...base, workingHours: { ...workingHours, days }, focusTime, sleep },
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Calendar selection
// ---------------------------------------------------------------------------

function isExcludedCalendar(c: CalendarInfo): string | undefined {
  if (c.isTempo) return 'tempo';
  if (c.id.includes('#holiday@')) return 'holidays';
  if (c.id.includes('#contacts@') || c.id.includes('addressbook#')) return 'birthdays';
  return undefined;
}

function selectCalendars(calendars: CalendarInfo[]): { ids: string[]; evidence: string[] } {
  const read = calendars.filter((c) => !isExcludedCalendar(c));
  const skipped = calendars.filter((c) => {
    const why = isExcludedCalendar(c);
    return why === 'holidays' || why === 'birthdays';
  });
  const evidence = [
    `Reading ${read.length} calendar${read.length === 1 ? '' : 's'} as busy time: ${read.map((c) => c.summary).join(', ') || 'none'}.`,
  ];
  if (skipped.length > 0) {
    evidence.push(`Skipping holiday/birthday calendars: ${skipped.map((c) => c.summary).join(', ')}.`);
  }
  return { ids: read.map((c) => c.id), evidence };
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

function historyEvents(input: InferInput, calendarIds: Set<string>): DayEvent[] {
  const end = DateTime.fromJSDate(input.now, { zone: input.timezone });
  const start = end.minus({ weeks: HISTORY_WEEKS });
  const out: DayEvent[] = [];
  for (const e of input.events) {
    if (e.tempo || e.allDay || e.status === 'cancelled' || e.selfResponse === 'declined') continue;
    if (!calendarIds.has(e.calendarId)) continue;
    const s = DateTime.fromJSDate(e.start, { zone: input.timezone });
    const f = DateTime.fromJSDate(e.end, { zone: input.timezone });
    if (!s.isValid || !f.isValid || f <= s || s < start || s >= end) continue;
    const minutes = f.diff(s, 'minutes').minutes;
    if (minutes > 12 * 60) continue; // multi-day blockers say nothing about the daily rhythm
    const startMin = s.hour * 60 + s.minute;
    out.push({
      date: s.toISODate() ?? '',
      weekday: s.weekday as IsoWeekday,
      week: Math.min(HISTORY_WEEKS - 1, Math.floor(end.diff(s, 'days').days / 7)),
      start: startMin,
      end: startMin + Math.round(minutes),
    });
  }
  return out;
}

function inferWorkingDays(history: DayEvent[], evidence: string[]): IsoWeekday[] {
  const weeksByDay = new Map<IsoWeekday, Set<number>>();
  for (const e of history) {
    const set = weeksByDay.get(e.weekday) ?? new Set<number>();
    set.add(e.week);
    weeksByDay.set(e.weekday, set);
  }
  const days = ([1, 2, 3, 4, 5, 6, 7] as IsoWeekday[]).filter((d) => (weeksByDay.get(d)?.size ?? 0) >= 2);
  if (days.length < 3) {
    evidence.push(`Working days Mon–Fri: your calendar shows a regular schedule on too few days to tell (default).`);
    return [...DEFAULT_WORKING_DAYS];
  }
  evidence.push(`Working days ${fmtDays(days)}: you had events on these days in at least 2 of the last 4 weeks.`);
  return days;
}

interface DaySpan {
  first: number;
  /** Last end of the main activity block (isolated evening events excluded). */
  lastWork: number;
  /** Last end of anything that day. */
  last: number;
  eveningExcluded: boolean;
}

function dailySpans(history: DayEvent[]): DaySpan[] {
  const byDate = groupByDate(history);
  const spans: DaySpan[] = [];
  for (const events of byDate.values()) {
    events.sort((a, b) => a.start - b.start);
    const first = events[0];
    if (!first) continue;
    let lastWork = first.end;
    let last = first.end;
    let eveningExcluded = false;
    for (const e of events.slice(1)) {
      if (!eveningExcluded && e.start >= EVENING_FROM && e.start - lastWork >= EVENING_GAP) eveningExcluded = true;
      if (!eveningExcluded) lastWork = Math.max(lastWork, e.end);
      last = Math.max(last, e.end);
    }
    spans.push({ first: first.start, lastWork, last, eveningExcluded });
  }
  return spans;
}

function groupByDate(history: DayEvent[]): Map<string, DayEvent[]> {
  const byDate = new Map<string, DayEvent[]>();
  for (const e of history) {
    const list = byDate.get(e.date) ?? [];
    list.push(e);
    byDate.set(e.date, list);
  }
  return byDate;
}

function inferWorkingHours(spans: DaySpan[], evidence: string[]): DailyWindow {
  if (spans.length === 0) {
    evidence.push(`Working hours ${fmtWindow(DEFAULT_WORKING_HOURS)} (default).`);
    return { ...DEFAULT_WORKING_HOURS };
  }
  const typicalStart = percentile(spans.map((s) => s.first), 0.15);
  const typicalEnd = percentile(spans.map((s) => s.lastWork), 0.85);
  let start = clampNum(floor30(typicalStart), EARLIEST_WORK, LATEST_WORK - 60);
  let end = clampNum(ceil30(typicalEnd), start + 60, LATEST_WORK);

  const parts = [`your first events usually start around ${fmtMin(floor30(typicalStart))}`];
  parts.push(`your day usually ends around ${fmtMin(ceil30(typicalEnd))}`);
  if (spans.some((s) => s.eveningExcluded)) parts.push('evening events after a break (e.g. sport) count as free time');
  if (end - start < MIN_WORK_SPAN) {
    end = Math.min(LATEST_WORK, start + MIN_WORK_SPAN);
    start = Math.max(EARLIEST_WORK, end - MIN_WORK_SPAN);
    parts.push('widened to 8 h so there is room for tasks');
  }
  const wh = { start: fmtMin(start), end: fmtMin(end) };
  evidence.push(`Working hours ${fmtWindow(wh)}: ${parts.join('; ')}.`);
  return wh;
}

function inferSleep(spans: DaySpan[], evidence: string[]): DailyWindow {
  const defaultStart = 23 * 60;
  const defaultEnd = 7 * 60;
  const regular = Math.max(3, Math.ceil(spans.length * 0.2));

  const early = spans.map((s) => s.first).filter((m) => m < defaultEnd);
  const late = spans.map((s) => s.last).filter((m) => m > defaultStart);
  let wake = defaultEnd;
  let bed = defaultStart;
  const notes: string[] = [];
  if (early.length >= regular) {
    wake = Math.max(5 * 60, floor30(percentile(early, 0.25)) - 30);
    notes.push(`you regularly have events before 07:00 (around ${fmtMin(floor30(percentile(early, 0.25)))})`);
  }
  if (late.length >= regular) {
    bed = Math.min(25 * 60, ceil30(percentile(late, 0.75)) + 30);
    notes.push(`you regularly have events after 23:00 (until around ${fmtMin(ceil30(percentile(late, 0.75)))})`);
  }
  const sleep = { start: fmtMin(bed), end: fmtMin(wake) };
  evidence.push(
    notes.length > 0
      ? `Sleep ${fmtWindow(sleep)}: ${notes.join(' and ')}.`
      : `Sleep ${fmtWindow(sleep)}: no regular events before 07:00 or after 23:00 (default).`,
  );
  return sleep;
}

function inferFocusTime(history: DayEvent[], wh: DailyWindow, evidence: string[]): DailyWindow {
  const whStart = toMin(wh.start);
  const whEnd = toMin(wh.end);
  if (whEnd - whStart < FOCUS_SPAN) {
    const ft = { start: wh.start, end: wh.end };
    evidence.push(`Focus time ${fmtWindow(ft)}: your working hours are short, so all of it.`);
    return ft;
  }
  const candidates: Array<{ start: number; busy: number }> = [];
  for (let s = whStart; s + FOCUS_SPAN <= whEnd; s += 30) {
    let busy = 0;
    for (const e of history) busy += overlap(e.start, e.end, s, s + FOCUS_SPAN);
    candidates.push({ start: s, busy });
  }
  const min = Math.min(...candidates.map((c) => c.busy));
  // Prefer mornings among near-ties (within 30 min over 4 weeks).
  const best = candidates.find((c) => c.busy <= min + 30) ?? candidates[0];
  const start = best?.start ?? toMin(DEFAULT_FOCUS_TIME.start);
  const ft = { start: fmtMin(start), end: fmtMin(start + FOCUS_SPAN) };
  const weeklyHours = (best?.busy ?? 0) / HISTORY_WEEKS / 60;
  evidence.push(
    `Focus time ${fmtWindow(ft)}: the quietest 3-hour window in your working hours ` +
      `(${weeklyHours < 0.5 ? 'almost no events' : `about ${weeklyHours.toFixed(1)} h of events per week`}).`,
  );
  return ft;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return a + (b - a) * (idx - lo);
}

function overlap(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));
}

const floor30 = (m: number): number => Math.floor(m / 30) * 30;
const ceil30 = (m: number): number => Math.ceil(m / 30) * 30;
const clampNum = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function toMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Minutes since midnight -> "HH:mm" (wraps past midnight). */
function fmtMin(m: number): string {
  const wrapped = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

function fmtWindow(w: DailyWindow): string {
  return `${w.start}–${w.end}`;
}

function fmtDays(days: IsoWeekday[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const contiguous = sorted.every((d, i) => i === 0 || d === (sorted[i - 1] ?? 0) + 1);
  if (contiguous && sorted.length > 2) return `${WEEKDAY_NAMES[sorted[0] ?? 1]}–${WEEKDAY_NAMES[sorted[sorted.length - 1] ?? 5]}`;
  return sorted.map((d) => WEEKDAY_NAMES[d]).join(', ');
}
