import { describe, expect, it } from 'vitest';
import { findGaps } from '../../src/core/gaps.js';
import { at, block, event, local, prefs } from '../fakes/fixtures.js';
import type { TimeRange } from '../../src/core/types.js';

const show = (gaps: TimeRange[]) => gaps.map((g) => `${local(g.start)}–${local(g.end).slice(11)}`);

describe('findGaps', () => {
  it('starts after the lock window (rounded to 5 min) and stays inside working hours', () => {
    const gaps = findGaps({ now: at('2026-11-16T10:02'), events: [], prefs: prefs(), horizonDays: 1 });
    expect(show(gaps)).toEqual(['2026-11-16T11:05–18:00', '2026-11-17T09:00–10:00']);
  });

  it('subtracts busy fixed events with buffer; Free, declined, cancelled and all-day events stay available', () => {
    const events = [
      event({ id: 'lecture', start: '2026-11-16T10:00', end: '2026-11-16T11:00' }),
      event({ id: 'free', start: '2026-11-16T12:00', end: '2026-11-16T13:00', transparency: 'transparent' }),
      event({ id: 'declined', start: '2026-11-16T13:00', end: '2026-11-16T14:00', selfResponse: 'declined' }),
      event({ id: 'cancelled', start: '2026-11-16T14:00', end: '2026-11-16T15:00', status: 'cancelled' }),
      event({ id: 'allday', start: '2026-11-16T00:00', end: '2026-11-17T00:00', allDay: true }),
    ];
    const gaps = findGaps({ now: at('2026-11-16T07:00'), events, prefs: prefs({ bufferMin: 5 }), horizonDays: 1 });
    expect(show(gaps)).toEqual(['2026-11-16T09:00–09:55', '2026-11-16T11:05–18:00']);
  });

  it('keeps movable Tempo blocks as free time but subtracts locked and frozen ones', () => {
    const events = [
      block({ id: 'locked', taskId: 'a', start: '2026-11-16T09:30', end: '2026-11-16T10:30' }),
      block({ id: 'movable', taskId: 'b', start: '2026-11-16T12:00', end: '2026-11-16T13:00' }),
      block({ id: 'frozen', taskId: 'q', start: '2026-11-16T15:00', end: '2026-11-16T16:00' }),
    ];
    const gaps = findGaps({ now: at('2026-11-16T09:00'), events, prefs: prefs(), horizonDays: 1, frozenTaskIds: ['q'] });
    expect(show(gaps)).toEqual(['2026-11-16T10:30–15:00', '2026-11-16T16:00–18:00']);
  });

  it('releases a locked block that a busy event now overlaps', () => {
    const events = [
      event({ id: 'meeting', start: '2026-11-16T08:00', end: '2026-11-16T09:45' }),
      block({ id: 'locked', taskId: 'a', start: '2026-11-16T09:30', end: '2026-11-16T10:30' }),
    ];
    const gaps = findGaps({ now: at('2026-11-16T09:00'), events, prefs: prefs(), horizonDays: 1 });
    expect(show(gaps)).toEqual(['2026-11-16T10:00–18:00']);
  });

  it('has no gaps on the weekend and handles the DST weekend', () => {
    const gaps = findGaps({ now: at('2026-10-23T17:00'), events: [], prefs: prefs(), horizonDays: 3 });
    expect(show(gaps)).toEqual(['2026-10-26T09:00–16:00']);
    expect(gaps[0]!.start.toISOString()).toBe('2026-10-26T08:00:00.000Z');
  });
});
