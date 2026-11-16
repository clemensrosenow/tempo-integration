import { describe, expect, it } from 'vitest';
import {
  durationMin,
  intersectRanges,
  localDayDiff,
  mergeRanges,
  roundUpToSlot,
  sleepWindows,
  subtractRanges,
  workingWindows,
} from '../../src/core/time.js';
import { at, local, prefs } from '../fakes/fixtures.js';

const r = (a: string, b: string) => ({ start: at(a), end: at(b) });

describe('time helpers', () => {
  it('working windows follow local wall-clock time across the DST switch', () => {
    // DST in Berlin ends Sun 25 Oct 2026 (UTC+2 → UTC+1).
    const windows = workingWindows(r('2026-10-23T00:00', '2026-10-27T00:00'), prefs());
    expect(windows.map((w) => [local(w.start), local(w.end)])).toEqual([
      ['2026-10-23T09:00', '2026-10-23T18:00'],
      ['2026-10-26T09:00', '2026-10-26T18:00'],
    ]);
    expect(windows[0]!.start.toISOString()).toBe('2026-10-23T07:00:00.000Z');
    expect(windows[1]!.start.toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });

  it('sleep wraps midnight and the DST night is one hour longer', () => {
    const nights = sleepWindows(r('2026-10-24T12:00', '2026-10-25T12:00'), prefs());
    expect(nights).toHaveLength(1);
    expect(local(nights[0]!.start)).toBe('2026-10-24T23:00');
    expect(local(nights[0]!.end)).toBe('2026-10-25T07:00');
    expect(durationMin(nights[0]!)).toBe(9 * 60);
  });

  it('sleep windows starting the evening before the span are included', () => {
    const nights = sleepWindows(r('2026-11-16T05:00', '2026-11-16T08:00'), prefs());
    expect(nights.map((n) => [local(n.start), local(n.end)])).toEqual([['2026-11-16T05:00', '2026-11-16T07:00']]);
  });

  it('subtract, intersect and merge ranges', () => {
    const base = [r('2026-11-16T09:00', '2026-11-16T18:00')];
    const cut = subtractRanges(base, [r('2026-11-16T10:00', '2026-11-16T11:00'), r('2026-11-16T17:30', '2026-11-16T19:00')]);
    expect(cut.map((x) => [local(x.start), local(x.end)])).toEqual([
      ['2026-11-16T09:00', '2026-11-16T10:00'],
      ['2026-11-16T11:00', '2026-11-16T17:30'],
    ]);
    const inter = intersectRanges(cut, [r('2026-11-16T09:30', '2026-11-16T12:00')]);
    expect(inter.map((x) => [local(x.start), local(x.end)])).toEqual([
      ['2026-11-16T09:30', '2026-11-16T10:00'],
      ['2026-11-16T11:00', '2026-11-16T12:00'],
    ]);
    const merged = mergeRanges([r('2026-11-16T09:00', '2026-11-16T10:00'), r('2026-11-16T10:00', '2026-11-16T11:00')]);
    expect(merged).toHaveLength(1);
  });

  it('rounds up to 5 minutes and counts local days', () => {
    expect(local(roundUpToSlot(at('2026-11-16T10:02')))).toBe('2026-11-16T10:05');
    expect(localDayDiff(at('2026-10-24T23:30'), at('2026-10-26T00:30'), 'Europe/Berlin')).toBe(2);
  });
});
