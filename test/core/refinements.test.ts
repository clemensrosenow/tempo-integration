/**
 * Behaviour found while exercising Tempo against a live test account
 * (scripts/sandbox.ts): each case reproduces one real-life situation.
 */
import { describe, expect, it } from 'vitest';
import { mergeAdjacent, runPlanningPipeline } from '../../src/core/pipeline.js';
import { at, block, estimate, event, planInput, task } from '../fakes/fixtures.js';
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

describe('missed due with a full week', () => {
  // Mon/Tue mostly in meetings; exam blocks (due 10 Dec) fill the rest of the week.
  const exam = (id: string, day: string, s: string, e: string) =>
    block({ id, taskId: 'exam', title: 'Exam prep', start: `${day}T${s}`, end: `${day}T${e}` });
  const events = [
    event({ id: 'm1', title: 'Workshop', start: '2026-11-16T09:00', end: '2026-11-16T17:00' }),
    event({ id: 'm2', title: 'Job', start: '2026-11-17T09:00', end: '2026-11-17T15:00' }),
    exam('x1', '2026-11-16', '17:00', '18:00'),
    exam('x2', '2026-11-17', '15:00', '18:00'),
    exam('x3', '2026-11-18', '09:00', '18:00'),
    exam('x4', '2026-11-19', '09:00', '18:00'),
  ];
  const tasks = [task({ id: 'exam', title: 'Exam prep', due: '2026-12-10' }), task({ id: 'lab', title: 'Lab report', due: '2026-11-17' })];
  const estimates = {
    exam: estimate('exam', { durationMin: 22 * 60, minChunkMin: 60, urgency: 1 }),
    lab: estimate('lab', { durationMin: 360, minChunkMin: 60, urgency: 5, priority: 4 }),
  };

  it('proposes time taken from later work, keeps that work until Yes, then moves it without a big-change question', async () => {
    const first = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', events, tasks, estimates, signals: [{ type: 'tasks-changed', taskIds: ['lab'] }] }),
      stubLlm(),
    );
    const q = first.questions.find((x) => x.taskId === 'lab')!;
    expect(q?.kind).toBe('missed-due');
    expect(q.title).toMatch(/Lab report 1 day late\?/);
    expect(q.description).toMatch(/To make room, Tempo moves 'Exam prep' to later/);
    expect(first.apply.filter((c) => c.op !== 'create' && c.eventId.startsWith('x'))).toEqual([]);

    // While the question is open, the exam blocks stay where they are.
    const open = { ...q, status: 'open' as const };
    const waiting = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:05', events, tasks, estimates, openQuestion: open, signals: [{ type: 'periodic' }] }),
      stubLlm(),
    );
    expect(waiting.apply.filter((c) => c.op !== 'create' && c.eventId.startsWith('x'))).toEqual([]);

    const answered = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T08:10',
        events,
        tasks,
        estimates,
        openQuestion: open,
        signals: [{ type: 'question-answered', questionId: q.id, answer: 'yes' }],
      }),
      stubLlm(),
    );
    expect(creates(answered.apply, 'lab').length).toBeGreaterThan(0);
    expect(answered.apply.some((c) => c.op !== 'create' && c.eventId.startsWith('x'))).toBe(true);
    expect(answered.questions.filter((x) => x.kind === 'big-change')).toEqual([]);
    expect(reasonOf(creates(answered.apply, 'lab')[0]!)).toMatch(/You said Yes/);
  });
});

describe('question wording', () => {
  it('says "Make room" when the proposal is on time thanks to later work', async () => {
    const { buildMissedDueQuestion } = await import('../../src/core/questions.js');
    const { prefs } = await import('../fakes/fixtures.js');
    const item = {
      taskId: 'slides', taskListId: 'l', title: 'HCI slides', needMin: 180, minChunkMin: 60, priority: 3, urgency: 4,
      deepWork: false, due: at('2026-11-20T00:00'), lateOk: false, avoid: [],
    };
    const q = buildMissedDueQuestion({
      now: at('2026-11-16T08:00'),
      prefs: prefs(),
      item,
      options: [{ blocks: [{ start: at('2026-11-19T09:00'), end: at('2026-11-19T12:00') }], unplacedMin: 0 }],
      replaced: [],
      displaced: ['Exam prep'],
    })!;
    expect(q.title).toBe('Tempo asks: Make room for HCI slides before Thu 19 Nov?');
    expect(q.description).toMatch(/only fits before its due \(Thu 19 Nov\) if other work moves.*To make room, Tempo moves 'Exam prep' to later/s);
  });
});
