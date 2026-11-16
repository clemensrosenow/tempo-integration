/**
 * Behaviour found while exercising Tempo against a live test account
 * (scripts/sandbox.ts): each case reproduces one real-life situation.
 */
import { describe, expect, it } from 'vitest';
import { mergeAdjacent, runPlanningPipeline } from '../../src/core/pipeline.js';
import { at, block, estimate, planInput, task } from '../fakes/fixtures.js';
import { creates, deletes, moves, reasonOf, show, target } from '../fakes/planAssertions.js';
import { stubLlm } from '../fakes/stubLlm.js';

describe('real-life refinements', () => {
  it('skips tasks that are long overdue (lapsed), asks about recently overdue ones', async () => {
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T08:00',
        tasks: [task({ id: 'tax', title: 'Tax return 2025', due: '2026-05-10' }), task({ id: 'train', title: 'Book train', due: '2026-11-15' })],
        estimates: { tax: estimate('tax'), train: estimate('train', { durationMin: 20, minChunkMin: 20 }) },
        signals: [{ type: 'initial' }],
      }),
      stubLlm(),
    );
    expect(creates(out.apply, 'tax')).toEqual([]);
    expect(out.questions.some((q) => q.taskId === 'tax')).toBe(false);
    const q = out.questions.find((x) => x.taskId === 'train');
    expect(q?.kind).toBe('missed-due');
    expect(q?.title).toMatch(/^Tempo asks: Book train is overdue\. Do it (today|tomorrow) \d\d:\d\d\?$/);
    expect(q?.description).toMatch(/was due Sun 15 Nov and isn't checked off/);
  });

  it('a new urgent task fits around the current plan instead of shuffling it (no big-change question)', async () => {
    // A full Monday of exam blocks with small gaps; a 30-min task due today arrives.
    const exam = (id: string, s: string, e: string) => block({ id, taskId: 'exam', title: 'Exam prep', start: `2026-11-16T${s}`, end: `2026-11-16T${e}` });
    const events = [exam('e1', '09:00', '11:00'), exam('e2', '11:30', '13:30'), exam('e3', '14:00', '16:00'), exam('e4', '16:30', '17:30')];
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T07:30',
        events,
        tasks: [task({ id: 'exam', title: 'Exam prep', due: '2026-12-10' }), task({ id: 'rent', title: 'Sign rental contract', due: '2026-11-16' })],
        estimates: {
          exam: estimate('exam', { durationMin: 420, minChunkMin: 60, urgency: 1 }),
          rent: estimate('rent', { durationMin: 30, minChunkMin: 30, urgency: 5, priority: 5 }),
        },
        signals: [{ type: 'tasks-changed', taskIds: ['rent'] }],
      }),
      stubLlm(),
    );
    expect(moves(out.apply, 'exam')).toEqual([]);
    expect(deletes(out.apply, 'exam')).toEqual([]);
    const rent = creates(out.apply, 'rent');
    expect(rent).toHaveLength(1);
    expect(target(rent[0]!)!.end.getTime()).toBeLessThanOrEqual(at('2026-11-17T00:00').getTime());
    expect(out.questions.filter((q) => q.kind === 'big-change')).toEqual([]);
  });

  it('merges back-to-back blocks of one task, and each change keeps its own reason', async () => {
    const events = [
      block({ id: 's1', taskId: 'sheet', title: 'Exercise sheet', start: '2026-11-16T14:00', end: '2026-11-16T15:00' }),
      block({ id: 's2', taskId: 'sheet', title: 'Exercise sheet', start: '2026-11-16T15:00', end: '2026-11-16T16:00' }),
    ];
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T08:00',
        events,
        tasks: [task({ id: 'sheet', title: 'Exercise sheet', due: '2026-11-17' })],
        estimates: { sheet: estimate('sheet', { durationMin: 120, minChunkMin: 60 }) },
        signals: [{ type: 'tasks-changed', taskIds: ['sheet'] }],
      }),
      stubLlm(),
    );
    const blocksAfter = out.apply.filter((c) => c.op !== 'delete');
    expect(blocksAfter).toHaveLength(1);
    expect(show(target(blocksAfter[0]!)!)).toBe('2026-11-16T14:00–16:00');
    expect(deletes(out.apply, 'sheet')).toHaveLength(1);
    expect(reasonOf(blocksAfter[0]!)).not.toMatch(/^Removed/);
  });

  it('mergeAdjacent joins only touching ranges of the same task', () => {
    const p = (taskId: string, s: string, e: string) => ({ taskId, start: at(`2026-11-16T${s}`), end: at(`2026-11-16T${e}`) });
    const merged = mergeAdjacent([p('a', '10:00', '11:00'), p('b', '11:00', '12:00'), p('a', '09:00', '10:00'), p('a', '11:05', '12:00')]);
    expect(merged.map((m) => `${m.taskId} ${show(m)}`)).toEqual(['a 2026-11-16T09:00–11:00', 'a 2026-11-16T11:05–12:00', 'b 2026-11-16T11:00–12:00']);
  });
});
