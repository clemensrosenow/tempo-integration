/**
 * Behaviour tests through the planning seam (runPlanningPipeline):
 * calendar + tasks + preferences + signals + now → changes, questions, reasons.
 */
import { describe, expect, it } from 'vitest';
import { runPlanningPipeline } from '../../src/core/pipeline.js';
import { detectSignals, takeSnapshot } from '../../src/core/signals.js';
import { at, block, estimate, event, local, planInput, task } from '../fakes/fixtures.js';
import {
  creates,
  deletes,
  expectFixedEventsUntouched,
  expectNothingIntoLockWindow,
  expectReasons,
  moves,
  reasonOf,
  show,
  target,
} from '../fakes/planAssertions.js';
import { stubLlm } from '../fakes/stubLlm.js';

describe('planning pipeline', () => {
  it('first plan: places new tasks inside working hours with a reason', async () => {
    const llm = stubLlm({ estimates: { 'Read paper': { durationMin: 60 } } });
    const input = planInput({
      now: '2026-11-16T08:00',
      tasks: [task({ id: 'read', title: 'Read paper' })],
      signals: [{ type: 'initial' }],
    });
    const out = await runPlanningPipeline(input, llm);
    expect(creates(out.apply).map((c) => show(target(c)))).toEqual(['2026-11-16T09:00–10:00']);
    expect(out.estimates.read?.durationMin).toBe(60);
    expect(out.questions).toEqual([]);
    expectReasons(out);
  });

  it('meeting overrun: the following block moves out, the next hour stays untouched', async () => {
    const meeting = event({ id: 'meeting', title: 'Project meeting', start: '2026-11-16T15:00', end: '2026-11-16T17:00' });
    const events = [
      meeting,
      block({ id: 'b-inbox', taskId: 'inbox', title: 'Inbox', start: '2026-11-16T13:15', end: '2026-11-16T13:45' }),
      block({ id: 'b-read', taskId: 'read', title: 'Read paper', start: '2026-11-16T16:00', end: '2026-11-16T17:00' }),
      block({ id: 'b-slides', taskId: 'slides', title: 'Slides', start: '2026-11-16T17:00', end: '2026-11-16T18:00' }),
    ];
    const input = planInput({
      now: '2026-11-16T13:00',
      events,
      tasks: [task({ id: 'inbox', title: 'Inbox' }), task({ id: 'read', title: 'Read paper' }), task({ id: 'slides', title: 'Slides' })],
      estimates: { inbox: estimate('inbox', { durationMin: 30 }), read: estimate('read'), slides: estimate('slides') },
      signals: [{ type: 'fixed-event-changed', eventId: 'meeting' }],
    });
    const out = await runPlanningPipeline(input, stubLlm());

    expect(out.apply).toHaveLength(1);
    const [move] = moves(out.apply, 'read');
    expect(move?.eventId).toBe('b-read');
    expect(show(move?.to)).toBe('2026-11-16T14:00–15:00');
    expect(reasonOf(move!)).toContain('Project meeting');
    expectNothingIntoLockWindow(out, input.now);
    expectFixedEventsUntouched(out, events);
    expect(out.questions).toEqual([]);
  });

  it('a locked block the overrun now overlaps is moved out — never into the lock window', async () => {
    const events = [
      event({ id: 'meeting', title: 'Seminar', start: '2026-11-16T12:00', end: '2026-11-16T13:40' }),
      block({ id: 'b-a', taskId: 'a', start: '2026-11-16T13:15', end: '2026-11-16T13:45' }),
      block({ id: 'b-b', taskId: 'b', start: '2026-11-16T13:45', end: '2026-11-16T14:15' }),
    ];
    const input = planInput({
      now: '2026-11-16T13:00',
      events,
      tasks: [task({ id: 'a' }), task({ id: 'b' })],
      estimates: { a: estimate('a', { durationMin: 30 }), b: estimate('b', { durationMin: 30 }) },
      signals: [{ type: 'fixed-event-changed', eventId: 'meeting' }],
    });
    const out = await runPlanningPipeline(input, stubLlm());
    expect(out.apply.map((c) => `${c.op}:${c.op === 'create' ? c.block.taskId : c.eventId}`)).toEqual(['move:b-a']);
    expect(show(target(out.apply[0]!))).toBe('2026-11-16T14:15–14:45');
    expectNothingIntoLockWindow(out, input.now);
    expectFixedEventsUntouched(out, events);
  });

  it('block ends while its task is open: the rest is re-planned once', async () => {
    const events = [block({ id: 'b1', taskId: 'essay', title: 'Essay', start: '2026-11-16T10:00', end: '2026-11-16T11:00' })];
    const tasks = [task({ id: 'essay', title: 'Essay' })];
    const prev = takeSnapshot(events, tasks, at('2026-11-16T10:50'));
    const detected = detectSignals({ prev, events, tasks, now: at('2026-11-16T11:05'), handledEndedBlocks: [] });
    expect(detected.signals).toEqual([{ type: 'block-ended-open', eventId: 'b1', taskId: 'essay' }]);

    const input = planInput({
      now: '2026-11-16T11:05',
      events,
      tasks,
      estimates: { essay: estimate('essay', { durationMin: 60, minChunkMin: 30 }) },
      signals: detected.signals,
    });
    const out = await runPlanningPipeline(input, stubLlm());
    const [created] = creates(out.apply, 'essay');
    expect(show(target(created!))).toBe('2026-11-16T12:05–12:35');
    expect(reasonOf(created!)).toContain('still open');
    expect(out.apply.some((c) => c.op !== 'create' && c.eventId === 'b1')).toBe(false); // past block untouched
    expect(out.learned?.durationScale).toBeGreaterThan(1);

    const again = detectSignals({ prev: detected.snapshot, events, tasks, now: at('2026-11-16T11:20'), handledEndedBlocks: detected.handledEndedBlocks });
    expect(again.signals).toEqual([]);
  });

  it('Free and declined events are used as available time; fixed events are never moved', async () => {
    const events = [
      event({ id: 'lecture', title: 'Lecture', start: '2026-11-16T09:00', end: '2026-11-16T12:00' }),
      event({ id: 'skipped', title: 'Skipped lecture', start: '2026-11-16T12:00', end: '2026-11-16T14:00', transparency: 'transparent' }),
      event({ id: 'declined', title: 'Declined meeting', start: '2026-11-16T14:00', end: '2026-11-16T16:00', selfResponse: 'declined' }),
      event({ id: 'job', title: 'Job', start: '2026-11-16T16:00', end: '2026-11-16T18:00' }),
      event({ id: 'holiday', title: 'Name day', start: '2026-11-16T00:00', end: '2026-11-17T00:00', allDay: true }),
    ];
    const input = planInput({
      now: '2026-11-16T08:00',
      events,
      tasks: [task({ id: 'read', title: 'Read' }), task({ id: 'write', title: 'Write' })],
      signals: [{ type: 'initial' }],
    });
    const out = await runPlanningPipeline(input, stubLlm({ defaultEstimate: { durationMin: 120 } }));
    expect(show(target(creates(out.apply, 'read')[0]!))).toBe('2026-11-16T12:00–14:00');
    expect(show(target(creates(out.apply, 'write')[0]!))).toBe('2026-11-16T14:00–16:00');
    expectFixedEventsUntouched(out, events);
  });

  it('subtasks are planned in order, all before the parent due; the parent itself is not double-planned', async () => {
    const tasks = [
      task({ id: 'thesis', title: 'Thesis', due: '2026-11-18' }),
      task({ id: 's1', title: 'Outline', parentId: 'thesis', position: '001' }),
      task({ id: 's2', title: 'Draft', parentId: 'thesis', position: '002' }),
      task({ id: 's3', title: 'Polish', parentId: 'thesis', position: '003' }),
    ];
    const events = [event({ id: 'busy', start: '2026-11-16T09:00', end: '2026-11-16T15:00' })];
    const llm = stubLlm({
      estimates: {
        Outline: { durationMin: 120, priority: 1, minChunkMin: 60 },
        Draft: { durationMin: 180, priority: 3, minChunkMin: 60 },
        Polish: { durationMin: 60, priority: 5, minChunkMin: 30 },
        Thesis: { durationMin: 600 },
      },
    });
    const out = await runPlanningPipeline(planInput({ now: '2026-11-16T08:00', events, tasks, signals: [{ type: 'initial' }] }), llm);
    expect(creates(out.apply, 'thesis')).toEqual([]);
    const span = (id: string) => {
      const ranges = creates(out.apply, id).map((c) => target(c)!);
      expect(ranges.length).toBeGreaterThan(0);
      return {
        start: Math.min(...ranges.map((r) => r.start.getTime())),
        end: Math.max(...ranges.map((r) => r.end.getTime())),
      };
    };
    const [o, d, p] = [span('s1'), span('s2'), span('s3')];
    expect(o.end).toBeLessThanOrEqual(d.start);
    expect(d.end).toBeLessThanOrEqual(p.start);
    expect(p.end).toBeLessThanOrEqual(at('2026-11-19T00:00').getTime());
    expect(llm.calls.understand[0]?.tasks.map((t) => t.id).sort()).toEqual(['s1', 's2', 's3']);
  });

  it('a new urgent task is planned the same day, even if other blocks have to move', async () => {
    const events = [
      block({ id: 'b-x', taskId: 'x', start: '2026-11-16T14:00', end: '2026-11-16T16:00' }),
      block({ id: 'b-y', taskId: 'y', start: '2026-11-16T16:00', end: '2026-11-16T18:00' }),
    ];
    const tasks = [task({ id: 'x' }), task({ id: 'y' }), task({ id: 'form', title: 'Visa form', due: '2026-11-16' })];
    const input = planInput({
      now: '2026-11-16T13:00',
      events,
      tasks,
      estimates: { x: estimate('x', { durationMin: 120 }), y: estimate('y', { durationMin: 120 }) },
      signals: [{ type: 'tasks-changed', taskIds: ['form'] }],
    });
    const out = await runPlanningPipeline(input, stubLlm({ estimates: { 'Visa form': { durationMin: 30, urgency: 5 } } }));
    const [form] = creates(out.apply, 'form');
    expect(local(form!.block.start).slice(0, 10)).toBe('2026-11-16');
    expect(out.questions).toEqual([]);
    expectNothingIntoLockWindow(out, input.now);
    expectReasons(out);
  });

  it('completed task: its future blocks are removed, past blocks stay', async () => {
    const events = [
      block({ id: 'b-past', taskId: 'done', start: '2026-11-13T10:00', end: '2026-11-13T11:00' }),
      block({ id: 'b-future', taskId: 'done', start: '2026-11-16T10:00', end: '2026-11-16T11:00' }),
      block({ id: 'b-soon', taskId: 'done', start: '2026-11-16T08:30', end: '2026-11-16T08:45' }),
    ];
    const input = planInput({
      now: '2026-11-16T08:00',
      events,
      tasks: [task({ id: 'done', status: 'completed' })],
      signals: [{ type: 'task-completed', taskId: 'done' }],
    });
    const out = await runPlanningPipeline(input, stubLlm());
    expect(deletes(out.apply).map((d) => d.eventId).sort()).toEqual(['b-future', 'b-soon']);
    for (const d of deletes(out.apply)) expect(d.reason).toBe('Done — task checked off');
    expect(out.apply).toHaveLength(2);
  });

  it('stability: a periodic run over a valid plan changes nothing and does not call place', async () => {
    const events = [
      event({ id: 'lecture', start: '2026-11-16T10:00', end: '2026-11-16T12:00' }),
      block({ id: 'b-read', taskId: 'read', start: '2026-11-16T14:00', end: '2026-11-16T15:00' }),
    ];
    const llm = stubLlm();
    const out = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', events, tasks: [task({ id: 'read' })], estimates: { read: estimate('read') } }),
      llm,
    );
    expect(out.apply).toEqual([]);
    expect(out.questions).toEqual([]);
    expect(llm.calls.place).toHaveLength(0);
    expect(llm.calls.understand).toHaveLength(0);
  });

  it('periodic run repairs a plan that became invalid', async () => {
    const events = [
      event({ id: 'lecture', start: '2026-11-16T14:00', end: '2026-11-16T15:00' }),
      block({ id: 'b-read', taskId: 'read', start: '2026-11-16T14:00', end: '2026-11-16T15:00' }),
    ];
    const out = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', events, tasks: [task({ id: 'read' })], estimates: { read: estimate('read') } }),
      stubLlm(),
    );
    expect(moves(out.apply, 'read').map((m) => show(m.to))).toEqual(['2026-11-16T09:00–10:00']);
  });

  it('uses a valid LLM placement', async () => {
    const llm = stubLlm({ placements: [[{ taskId: 'read', start: at('2026-11-16T15:00'), end: at('2026-11-16T16:00') }]] });
    const out = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', tasks: [task({ id: 'read' })], signals: [{ type: 'initial' }] }),
      llm,
    );
    expect(creates(out.apply).map((c) => show(target(c)))).toEqual(['2026-11-16T15:00–16:00']);
    expect(llm.calls.place).toHaveLength(1);
  });

  it('feeds check errors back to the LLM (max 2 retries), then falls back to greedy', async () => {
    const bad = [{ taskId: 'read', start: at('2026-11-16T08:30'), end: at('2026-11-16T09:30') }];
    const llm = stubLlm({ placements: () => bad });
    const out = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', tasks: [task({ id: 'read' })], signals: [{ type: 'initial' }] }),
      llm,
    );
    expect(llm.calls.place).toHaveLength(3);
    expect(llm.calls.place[0]?.previousErrors).toBeUndefined();
    expect(llm.calls.place[1]?.previousErrors?.join(' ')).toContain('locked next hour');
    expect(creates(out.apply).map((c) => show(target(c)))).toEqual(['2026-11-16T09:00–10:00']);
  });

  it('uses LLM explanations when given, templates otherwise', async () => {
    const llm = stubLlm({ explanations: { read: 'Morning slot is free.' } });
    const out = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', tasks: [task({ id: 'read' }), task({ id: 'other' })], signals: [{ type: 'initial' }] }),
      llm,
    );
    expect(reasonOf(creates(out.apply, 'read')[0]!)).toBe('Morning slot is free.');
    expect(reasonOf(creates(out.apply, 'other')[0]!)).toMatch(/^Planned: /);
  });
});
