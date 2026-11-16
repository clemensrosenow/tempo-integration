import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { emptyLearned, type CalendarInfo, type Preferences } from '../../src/core/types.js';
import { workingWindows } from '../../src/core/time.js';
import { inferPreferences } from '../../src/onboarding/infer.js';
import { MemoryStateStore } from '../../src/store/memoryStore.js';
import {
  prefsFromSettings,
  readSettings,
  settingsFromPrefs,
  SettingsStore,
  writeSettings,
  type SettingsFile,
} from '../../src/settings/settings.js';

const base: Preferences = {
  timezone: 'Europe/Berlin',
  workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
  focusTime: { start: '09:00', end: '12:00' },
  sleep: { start: '23:30', end: '07:00' },
  selectedCalendarIds: ['a@x', 'b@x'],
  bufferMin: 5,
  learned: { ...emptyLearned(), durationScale: 1.4 },
};

describe('settings file', () => {
  it('round-trips preferences and keeps learned values', () => {
    const s = settingsFromPrefs(base, [{ id: 'a@x', summary: 'Uni', primary: false, accessRole: 'reader', isTempo: false }]);
    expect(s.workingHours).toMatchObject({ mon: '09:00-18:00', fri: '09:00-18:00', sat: 'off', sun: 'off' });
    expect(s.busyCalendars).toEqual([{ name: 'Uni', id: 'a@x' }, { id: 'b@x' }]);
    const back = prefsFromSettings(s, base);
    expect(back).toEqual(base);
  });

  it('supports different hours per weekday', () => {
    const s = settingsFromPrefs(base);
    s.workingHours.fri = '09:00-14:00';
    s.workingHours.sat = '10:00-13:00';
    const p = prefsFromSettings(s, base);
    expect(p.workingHours.days).toEqual([1, 2, 3, 4, 5, 6]);
    expect(p.workingHours.perDay).toEqual({ 5: { start: '09:00', end: '14:00' }, 6: { start: '10:00', end: '13:00' } });
    // Mon 23 Nov 2026 .. Sun 29 Nov 2026 (Berlin, UTC+1)
    const w = workingWindows({ start: new Date('2026-11-22T23:00:00Z'), end: new Date('2026-11-29T23:00:00Z') }, p);
    expect(w.map((r) => r.start.toISOString())).toEqual([
      '2026-11-23T08:00:00.000Z',
      '2026-11-24T08:00:00.000Z',
      '2026-11-25T08:00:00.000Z',
      '2026-11-26T08:00:00.000Z',
      '2026-11-27T08:00:00.000Z',
      '2026-11-28T09:00:00.000Z',
    ]);
    expect(w[4]!.end.toISOString()).toBe('2026-11-27T13:00:00.000Z');
    expect(settingsFromPrefs(p).workingHours).toEqual(s.workingHours);
  });

  it('rejects invalid files with a readable message', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tempo-settings-'));
    const file = path.join(dir, 'tempo.json');
    const bad = { ...settingsFromPrefs(base), workingHours: { ...settingsFromPrefs(base).workingHours, mon: '18:00-09:00' }, focusTime: '9-12' };
    await writeFile(file, JSON.stringify(bad));
    const r = await readSettings(file);
    expect(r.kind).toBe('invalid');
    expect(r.kind === 'invalid' && r.error).toMatch(/focusTime: expected "HH:mm-HH:mm"/);
    expect(r.kind === 'invalid' && r.error).toMatch(/end after they start/);
    expect((await readSettings(path.join(dir, 'nope.json'))).kind).toBe('missing');
  });

  it('SettingsStore overlays the file on every load and survives a broken file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'tempo-settings-'));
    const file = path.join(dir, 'tempo.json');
    const inner = new MemoryStateStore();
    const st = await inner.load();
    st.prefs = base;
    await inner.save(st);
    const logs: string[] = [];
    const store = new SettingsStore(inner, file, (l) => logs.push(l));

    const s: SettingsFile = settingsFromPrefs(base);
    s.workingHours.sat = '10:00-14:00';
    s.busyCalendars = [{ id: 'c@x' }];
    await writeSettings(file, s);
    const loaded = await store.load();
    expect(loaded.prefs!.workingHours.days).toContain(6);
    expect(loaded.prefs!.selectedCalendarIds).toEqual(['c@x']);
    expect(loaded.prefs!.learned.durationScale).toBe(1.4);

    await writeFile(file, '{ not json');
    await store.load();
    await store.load();
    expect(logs.filter((l) => l.includes('not valid JSON'))).toHaveLength(1); // reported once
  });
});

describe('busy calendars from Google Calendar visibility', () => {
  const cal = (id: string, summary: string, visible?: boolean): CalendarInfo => ({
    id, summary, primary: id === 'me@x', accessRole: 'owner', isTempo: false, ...(visible !== undefined ? { visible } : {}),
  });
  it('reads the calendars shown in the sidebar', () => {
    const calendars = [cal('me@x', 'me', true), cal('uni@x', 'Uni', true), cal('sport@x', 'Sport', false), cal('de#holiday@group.v.calendar.google.com', 'Holidays', true)];
    const { prefs, evidence } = inferPreferences({ events: [], calendars, timezone: 'Europe/Berlin', now: new Date('2026-11-16T12:00:00Z') });
    expect(prefs.selectedCalendarIds).toEqual(['me@x', 'uni@x']);
    expect(evidence.join('\n')).toMatch(/Not reading calendars you hide in Google Calendar: Sport/);
  });
});
