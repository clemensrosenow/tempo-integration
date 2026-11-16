import { describe, expect, it } from 'vitest';
import { detectSignals, takeSnapshot } from '../../src/core/signals.js';
import type { CalendarEvent } from '../../src/core/types.js';
import { at, block, event, task } from '../fakes/fixtures.js';

const now = at('2026-11-16T12:00');

function question(): CalendarEvent {
  return {
    ...event({ id: 'inv', title: 'Tempo asks: Slides 1 day late?', start: '2026-11-18T09:00', end: '2026-11-18T10:00' }),
    tempo: { kind: 'question', taskId: 'slides', taskListId: 'list-1', plannedStart: '', plannedEnd: '', questionId: 'q1' },
  };
}

describe('detectSignals', () => {
  it('first run → initial', () => {
    const res = detectSignals({ events: [], tasks: [], now, handledEndedBlocks: [] });
    expect(res.signals).toEqual([{ type: 'initial' }]);
    expect(res.snapshot.takenAt).toBe(now.toISOString());
  });

  it('nothing changed → no signals; question invitations are ignored', () => {
    const events = [event({ id: 'lecture', start: '2026-11-16T14:00', end: '2026-11-16T16:00' }), question()];
    const tasks = [task({ id: 'a' })];
    const prev = takeSnapshot(events, tasks, at('2026-11-16T11:00'));
    expect(prev.events.map((e) => e.id)).toEqual(['lecture']);
    const res = detectSignals({ prev, events: [events[0]!], tasks, now, handledEndedBlocks: [] });
    expect(res.signals).toEqual([]);
  });

  it('fixed events: moved, resized, set to Free, declined, added, removed', () => {
    const before = [
      event({ id: 'moved', start: '2026-11-16T14:00', end: '2026-11-16T15:00' }),
      event({ id: 'free', start: '2026-11-17T14:00', end: '2026-11-17T15:00' }),
      event({ id: 'rsvp', start: '2026-11-17T16:00', end: '2026-11-17T17:00', selfResponse: 'needsAction' }),
      event({ id: 'removed', start: '2026-11-18T14:00', end: '2026-11-18T15:00' }),
      event({ id: 'past', start: '2026-11-16T08:00', end: '2026-11-16T09:00' }),
    ];
    const prev = takeSnapshot(before, [], at('2026-11-16T11:00'));
    const after = [
      event({ id: 'moved', start: '2026-11-16T14:00', end: '2026-11-16T15:45' }),
      event({ id: 'free', start: '2026-11-17T14:00', end: '2026-11-17T15:00', transparency: 'transparent' }),
      event({ id: 'rsvp', start: '2026-11-17T16:00', end: '2026-11-17T17:00', selfResponse: 'declined' }),
      event({ id: 'added', start: '2026-11-19T10:00', end: '2026-11-19T11:00' }),
    ];
    const res = detectSignals({ prev, events: after, tasks: [], now, handledEndedBlocks: [] });
    expect(res.signals).toEqual([
      { type: 'fixed-event-changed', eventId: 'moved' },
      { type: 'fixed-event-changed', eventId: 'free' },
      { type: 'fixed-event-changed', eventId: 'rsvp' },
      { type: 'fixed-event-changed', eventId: 'added' },
      { type: 'fixed-event-changed', eventId: 'removed' },
    ]);
  });

  it('tasks: new, changed due, completed, deleted', () => {
    const before = [task({ id: 'a' }), task({ id: 'b', due: '2026-11-20' }), task({ id: 'c' }), task({ id: 'd' })];
    const prev = takeSnapshot([], before, at('2026-11-16T11:00'));
    const after = [
      task({ id: 'a' }),
      task({ id: 'b', due: '2026-11-19' }),
      task({ id: 'c', status: 'completed' }),
      task({ id: 'new' }),
    ];
    const res = detectSignals({ prev, events: [], tasks: after, now, handledEndedBlocks: [] });
    expect(res.signals).toEqual([
      { type: 'tasks-changed', taskIds: ['b', 'd', 'new'] },
      { type: 'task-completed', taskId: 'c' },
    ]);
  });

  it('blocks: moved by the user, deleted by the user, ended with the task open (once)', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })];
    const before = [
      block({ id: 'b-a', taskId: 'a', start: '2026-11-16T14:00', end: '2026-11-16T15:00' }),
      block({ id: 'b-b', taskId: 'b', start: '2026-11-16T15:00', end: '2026-11-16T16:00' }),
      block({ id: 'b-c', taskId: 'c', start: '2026-11-16T10:00', end: '2026-11-16T11:30' }),
    ];
    const prev = takeSnapshot(before, tasks, at('2026-11-16T11:00'));
    const after = [
      block({ id: 'b-a', taskId: 'a', start: '2026-11-16T16:00', end: '2026-11-16T17:00', plannedStart: '2026-11-16T14:00', plannedEnd: '2026-11-16T15:00' }),
      before[2]!,
    ];
    const res = detectSignals({ prev, events: after, tasks, now, handledEndedBlocks: [] });
    expect(res.signals).toEqual([
      { type: 'block-deleted-by-user', eventId: 'b-b', taskId: 'b', range: { start: at('2026-11-16T15:00'), end: at('2026-11-16T16:00') } },
      { type: 'block-ended-open', eventId: 'b-c', taskId: 'c' },
      {
        type: 'block-moved-by-user',
        eventId: 'b-a',
        taskId: 'a',
        from: { start: at('2026-11-16T14:00'), end: at('2026-11-16T15:00') },
        to: { start: at('2026-11-16T16:00'), end: at('2026-11-16T17:00') },
      },
    ]);
    expect(res.handledEndedBlocks).toEqual(['b-c']);
    const again = detectSignals({ prev: res.snapshot, events: [before[2]!], tasks, now: at('2026-11-16T12:05'), handledEndedBlocks: res.handledEndedBlocks });
    expect(again.signals.filter((s) => s.type === 'block-ended-open')).toEqual([]);
  });

  it('incremental-sync deletions (cancelled, start=end=epoch) are deletions, never moves', () => {
    const tasks = [task({ id: 'a' })];
    const before = [
      block({ id: 'b-a', taskId: 'a', start: '2026-11-16T14:00', end: '2026-11-16T15:00' }),
      event({ id: 'lecture', start: '2026-11-16T16:00', end: '2026-11-16T17:00' }),
    ];
    const prev = takeSnapshot(before, tasks, at('2026-11-16T11:00'));
    const gone = (e: CalendarEvent): CalendarEvent => ({ ...e, status: 'cancelled', start: new Date(0), end: new Date(0) });
    const res = detectSignals({ prev, events: [gone(before[0]!), gone(before[1]!)], tasks, now, handledEndedBlocks: [] });
    expect(res.signals).toEqual([
      { type: 'fixed-event-changed', eventId: 'lecture' },
      { type: 'block-deleted-by-user', eventId: 'b-a', taskId: 'a', range: { start: at('2026-11-16T14:00'), end: at('2026-11-16T15:00') } },
    ]);
  });
});
