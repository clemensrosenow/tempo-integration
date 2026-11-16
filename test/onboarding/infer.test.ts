import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import type { CalendarEvent, CalendarInfo } from '../../src/core/types.js';
import { emptyLearned } from '../../src/core/types.js';
import { inferPreferences } from '../../src/onboarding/infer.js';

const tz = 'Europe/Berlin';
// Monday morning; history = the 4 weeks before.
const now = DateTime.fromISO('2026-11-16T08:00', { zone: tz }).toJSDate();

const calendars: CalendarInfo[] = [
  { id: 'student@example.com', summary: 'Student', primary: true, accessRole: 'owner', isTempo: false, timeZone: tz },
  { id: 'uni-schedule@group.calendar.google.com', summary: 'LMU Schedule', primary: false, accessRole: 'reader', isTempo: false },
  { id: 'partner@example.com', summary: 'Partner', primary: false, accessRole: 'freeBusyReader', isTempo: false },
  { id: 'de.german#holiday@group.v.calendar.google.com', summary: 'Holidays in Germany', primary: false, accessRole: 'reader', isTempo: false },
  { id: 'addressbook#contacts@group.v.calendar.google.com', summary: 'Birthdays', primary: false, accessRole: 'reader', isTempo: false },
  { id: 'tempo-cal@group.calendar.google.com', summary: 'Tempo', primary: false, accessRole: 'owner', isTempo: true },
];

let seq = 0;
function ev(day: DateTime, start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return {
    id: `e${seq++}`,
    calendarId: 'uni-schedule@group.calendar.google.com',
    title: 'Event',
    start: day.set({ hour: sh ?? 0, minute: sm ?? 0 }).toJSDate(),
    end: day.set({ hour: eh ?? 0, minute: em ?? 0 }).toJSDate(),
    allDay: false,
    transparency: 'opaque',
    status: 'confirmed',
    updated: now,
    ...extra,
  };
}

/** 4 weeks: lectures 10-16 Mon-Fri, gym Mon/Wed/Fri 18:00-19:30, plus noise that must be ignored. */
function studentHistory(): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  const first = DateTime.fromJSDate(now, { zone: tz }).minus({ weeks: 4 }).startOf('day');
  for (let d = 0; d < 28; d++) {
    const day = first.plus({ days: d });
    if (day.weekday <= 5) {
      events.push(ev(day, '10:00', '12:00', { title: 'HCI lecture' }));
      events.push(ev(day, '12:00', '14:00', { title: 'Tutorial' }));
      events.push(ev(day, '14:00', '16:00', { title: 'Algorithms lecture' }));
    }
    if ([1, 3, 5].includes(day.weekday)) {
      events.push(ev(day, '18:00', '19:30', { title: 'Gym', calendarId: 'student@example.com' }));
    }
    // Noise: declined early meeting, all-day, Tempo block, holiday calendar.
    events.push(ev(day, '06:00', '06:30', { selfResponse: 'declined' }));
    events.push(ev(day, '00:00', '23:59', { allDay: true }));
    events.push(
      ev(day, '20:00', '23:30', {
        calendarId: 'tempo-cal@group.calendar.google.com',
        tempo: { kind: 'block', taskId: 't', taskListId: 'l', plannedStart: '', plannedEnd: '' },
      }),
    );
    events.push(ev(day, '05:00', '05:30', { calendarId: 'de.german#holiday@group.v.calendar.google.com' }));
  }
  // An event older than 4 weeks must be ignored.
  events.push(ev(first.minus({ days: 3 }), '05:00', '23:00'));
  return events;
}

describe('inferPreferences', () => {
  it('infers a student week from 4 weeks of history', () => {
    const { prefs, evidence } = inferPreferences({ events: studentHistory(), calendars, timezone: tz, now });

    expect(prefs.timezone).toBe(tz);
    expect(prefs.workingHours.days).toEqual([1, 2, 3, 4, 5]);
    // Lectures 10-16, gym after a break is personal time; widened to 8 h.
    expect(prefs.workingHours.start).toBe('10:00');
    expect(prefs.workingHours.end).toBe('18:00');
    // The quietest 3 hours inside 10-18 are after the lectures.
    expect(prefs.focusTime).toEqual({ start: '15:00', end: '18:00' });
    expect(prefs.sleep).toEqual({ start: '23:00', end: '07:00' });
    expect(prefs.bufferMin).toBe(5);
    expect(prefs.learned).toEqual(emptyLearned());

    expect(prefs.selectedCalendarIds).toEqual([
      'student@example.com',
      'uni-schedule@group.calendar.google.com',
      'partner@example.com',
    ]);

    const text = evidence.join('\n');
    expect(text).toContain('Working hours 10:00–18:00');
    expect(text).toMatch(/first events usually start around 10:00/);
    expect(text).toMatch(/Working days Mon–Fri/);
    expect(text).toMatch(/Focus time 15:00–18:00/);
    expect(text).toMatch(/Skipping holiday\/birthday calendars: Holidays in Germany, Birthdays/);
  });

  it('falls back to defaults on empty history', () => {
    const { prefs, evidence } = inferPreferences({ events: [], calendars, timezone: tz, now });
    expect(prefs.workingHours).toEqual({ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] });
    expect(prefs.focusTime).toEqual({ start: '09:00', end: '12:00' });
    expect(prefs.sleep).toEqual({ start: '23:00', end: '07:00' });
    expect(prefs.selectedCalendarIds).toHaveLength(3);
    expect(evidence[0]).toMatch(/Only 0 events/);
  });

  it('treats thin history (< 10 events) as defaults', () => {
    const day = DateTime.fromJSDate(now, { zone: tz }).minus({ days: 3 });
    const events = Array.from({ length: 5 }, (_, i) => ev(day.minus({ days: i }), '07:00', '17:00'));
    const { prefs, evidence } = inferPreferences({ events, calendars, timezone: tz, now });
    expect(prefs.workingHours.start).toBe('09:00');
    expect(evidence[0]).toMatch(/Only 5 events/);
  });

  it('moves sleep for early birds and clamps working hours', () => {
    const events: CalendarEvent[] = [];
    const first = DateTime.fromJSDate(now, { zone: tz }).minus({ weeks: 4 }).startOf('day');
    for (let d = 0; d < 28; d++) {
      const day = first.plus({ days: d });
      if (day.weekday > 5) continue;
      events.push(ev(day, '06:00', '07:00', { title: 'Early shift' }));
      events.push(ev(day, '07:00', '15:00', { title: 'Work' }));
    }
    const { prefs, evidence } = inferPreferences({ events, calendars, timezone: tz, now });
    expect(prefs.sleep.end).toBe('05:30');
    expect(prefs.workingHours.start).toBe('07:00'); // clamped, not 06:00
    expect(prefs.workingHours.end).toBe('15:00');
    expect(evidence.join('\n')).toMatch(/before 07:00/);
  });
});
