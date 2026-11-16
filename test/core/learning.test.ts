/**
 * Learning by doing (E12) — drags and resizes, through detectSignals + runPlanningPipeline.
 */
import { describe, expect, it } from 'vitest';
import { runPlanningPipeline } from '../../src/core/pipeline.js';
import { detectSignals, takeSnapshot } from '../../src/core/signals.js';
import { at, block, estimate, planInput, prefs, task } from '../fakes/fixtures.js';
import { creates, moves, show } from '../fakes/planAssertions.js';
import { stubLlm } from '../fakes/stubLlm.js';

describe('learning from the user', () => {
  it('resize → duration preference stored, block stays, description gets "Tempo learned"', async () => {
    const tasks = [task({ id: 'read', title: 'Read paper' })];
    const planned = block({ id: 'b-read', taskId: 'read', title: 'Read paper', start: '2026-11-16T10:00', end: '2026-11-16T11:00' });
    const prev = takeSnapshot([planned], tasks, at('2026-11-16T07:50'));
    // The user drags the bottom edge: 10:00–11:30.
    const resized = block({
      id: 'b-read',
      taskId: 'read',
      title: 'Read paper',
      start: '2026-11-16T10:00',
      end: '2026-11-16T11:30',
      plannedStart: '2026-11-16T10:00',
      plannedEnd: '2026-11-16T11:00',
    });
    const { signals } = detectSignals({ prev, events: [resized], tasks, now: at('2026-11-16T08:00'), handledEndedBlocks: [] });
    expect(signals.map((s) => s.type)).toEqual(['block-moved-by-user']);

    const out = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', events: [resized], tasks, estimates: { read: estimate('read', { durationMin: 60 }) }, signals }),
      stubLlm(),
    );
    expect(out.learned?.taskDurationMin.read).toBe(90);
    expect(out.learned?.durationScale).toBeCloseTo(1.15);
    const [kept] = moves(out.apply, 'read');
    expect(kept?.eventId).toBe('b-read');
    expect(show(kept?.to)).toBe('2026-11-16T10:00–11:30');
    expect(kept?.learned).toEqual(["Tempo learned: 'Read paper' takes ~90 min"]);
    expect(out.apply).toHaveLength(1); // nothing else re-planned for this task
  });

  it('drag → hour affinity, the block stays where the user put it', async () => {
    const tasks = [task({ id: 'read', title: 'Read paper' })];
    const dragged = block({
      id: 'b-read',
      taskId: 'read',
      start: '2026-11-16T14:00',
      end: '2026-11-16T15:00',
      plannedStart: '2026-11-16T10:00',
      plannedEnd: '2026-11-16T11:00',
    });
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T08:00',
        events: [dragged],
        tasks,
        prefs: prefs({}, { hourAffinity: { 9: 2 } }),
        estimates: { read: estimate('read') },
        signals: [
          {
            type: 'block-moved-by-user',
            eventId: 'b-read',
            taskId: 'read',
            from: { start: at('2026-11-16T10:00'), end: at('2026-11-16T11:00') },
            to: { start: at('2026-11-16T14:00'), end: at('2026-11-16T15:00') },
          },
        ],
      }),
      stubLlm(),
    );
    expect(out.learned?.hourAffinity[14]).toBe(1);
    expect(out.learned?.hourAffinity[9]).toBeCloseTo(1.8);
    expect(out.learned?.taskDurationMin.read).toBeUndefined();
    const [kept] = moves(out.apply, 'read');
    expect(show(kept?.to)).toBe('2026-11-16T14:00–15:00');
    expect(kept?.learned).toEqual(['Tempo learned: you prefer this kind of work around 14:00']);
  });

  it('learned hour affinity steers new blocks within a day', async () => {
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T08:00',
        tasks: [task({ id: 'mail', title: 'Mails' })],
        prefs: prefs({}, { hourAffinity: { 14: 3 } }),
        signals: [{ type: 'initial' }],
      }),
      stubLlm(),
    );
    expect(creates(out.apply).map((c) => show({ start: c.block.start, end: c.block.end }))).toEqual(['2026-11-16T14:00–15:00']);
  });

  it('deep-work tasks prefer focus time', async () => {
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T12:30',
        tasks: [task({ id: 'thesis', title: 'Thesis' })],
        signals: [{ type: 'initial' }],
        prefs: prefs({ focusTime: { start: '15:00', end: '17:00' } }),
      }),
      stubLlm({ estimates: { Thesis: { deepWork: true, durationMin: 120 } } }),
    );
    expect(creates(out.apply).map((c) => show({ start: c.block.start, end: c.block.end }))).toEqual(['2026-11-16T15:00–17:00']);
  });
});
