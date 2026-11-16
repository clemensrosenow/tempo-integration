/**
 * Asking only when it matters (E9/E10) — behaviour through runPlanningPipeline.
 */
import { describe, expect, it } from 'vitest';
import { runPlanningPipeline } from '../../src/core/pipeline.js';
import { QUESTION_PREFIX, RSVP_HELP, type CalendarEvent, type PlanInput, type Question } from '../../src/core/types.js';
import { at, block, estimate, event, local, planInput, task } from '../fakes/fixtures.js';
import { creates, expectFixedEventsUntouched, moves, reasonOf, show, target } from '../fakes/planAssertions.js';
import { stubLlm } from '../fakes/stubLlm.js';

/**
 * Slides (120 min, due Tue 17 Nov) has a block Tue 10:00–12:00. Monday is busy
 * until 17:00 and an exam now fills Tuesday: only 60 min fit before the due.
 */
function missedDueScenario(): { input: PlanInput; events: CalendarEvent[] } {
  const events = [
    event({ id: 'mon', title: 'Lectures', start: '2026-11-16T09:00', end: '2026-11-16T17:00' }),
    event({ id: 'exam', title: 'Exam', start: '2026-11-17T09:00', end: '2026-11-17T18:00' }),
    block({ id: 'b-slides', taskId: 'slides', title: 'Slides', start: '2026-11-17T10:00', end: '2026-11-17T12:00' }),
  ];
  const input = planInput({
    now: '2026-11-16T08:00',
    events,
    tasks: [task({ id: 'slides', title: 'Slides', due: '2026-11-17' })],
    estimates: { slides: estimate('slides', { durationMin: 120, minChunkMin: 60 }) },
    signals: [{ type: 'fixed-event-changed', eventId: 'exam' }],
  });
  return { input, events };
}

/** Engine behaviour while a question is open: replaced blocks are deleted. */
function withOpen(input: PlanInput, q: Question, overrides: Partial<PlanInput>): PlanInput {
  return {
    ...input,
    events: input.events.filter((e) => !q.replacedEventIds.includes(e.id)),
    openQuestion: { ...q, status: 'open', inviteEventId: 'inv-1' },
    queuedQuestions: [],
    ...overrides,
  };
}

describe('questions', () => {
  it('due date missed → exactly one invitation at the late slot; the task is held meanwhile', async () => {
    const { input, events } = missedDueScenario();
    const out = await runPlanningPipeline(input, stubLlm());
    expect(out.questions).toHaveLength(1);
    const q = out.questions[0]!;
    expect(q.kind).toBe('missed-due');
    expect(q.status).toBe('open');
    expect(q.title).toBe(`${QUESTION_PREFIX}Slides 1 day late?`);
    expect(q.description.endsWith(`\n\n${RSVP_HELP}`)).toBe(true);
    expect(q.description.split('\n')[0]).toContain("doesn't fit before its due");
    expect(show(q.slot)).toBe('2026-11-18T09:00–10:00');
    expect(q.answerBy.getTime()).toBe(at('2026-11-18T08:00').getTime());
    expect(q.replacedEventIds).toEqual(['b-slides']);
    expect(show(q.replacedBlocks[0])).toBe('2026-11-17T10:00–12:00');
    // Proposal = all blocks of the task as 'create' (the replaced block is gone while open).
    expect(q.proposal.map((c) => `${c.op} ${show(target(c))}`)).toEqual([
      'create 2026-11-16T17:00–18:00',
      'create 2026-11-18T09:00–10:00',
    ]);
    for (const c of q.proposal) expect(reasonOf(c)).toBeTruthy();
    expect(q.alternatives.length).toBeGreaterThan(0);
    expect(q.alternatives.length).toBeLessThanOrEqual(3);
    // Nothing about Slides is applied while asking.
    expect(out.apply).toEqual([]);
    expectFixedEventsUntouched(out, events);
  });

  it('Yes applies the proposal and does not ask again', async () => {
    const { input } = missedDueScenario();
    const first = await runPlanningPipeline(input, stubLlm());
    const q = first.questions[0]!;
    const out = await runPlanningPipeline(
      withOpen(input, q, { now: at('2026-11-16T09:00'), signals: [{ type: 'question-answered', questionId: q.id, answer: 'yes' }] }),
      stubLlm(),
    );
    expect(out.updatedQuestions.map((u) => [u.id, u.status])).toEqual([[q.id, 'yes']]);
    expect(creates(out.apply, 'slides').map((c) => show(target(c)))).toEqual([
      '2026-11-16T17:00–18:00',
      '2026-11-18T09:00–10:00',
    ]);
    expect(out.questions).toEqual([]);
  });

  it('no answer (timeout) = No: the replaced block comes back, nothing else changes, Tempo learns', async () => {
    const { input } = missedDueScenario();
    const q = (await runPlanningPipeline(input, stubLlm())).questions[0]!;
    const out = await runPlanningPipeline(
      withOpen(input, q, { now: at('2026-11-18T08:00'), signals: [{ type: 'question-timeout', questionId: q.id }] }),
      stubLlm(),
    );
    expect(out.updatedQuestions.map((u) => u.status)).toEqual(['expired']);
    expect(out.apply).toHaveLength(1);
    const [restored] = creates(out.apply, 'slides');
    expect(show(target(restored!))).toBe('2026-11-17T10:00–12:00');
    expect(reasonOf(restored!)).toBe('No answer — kept your plan.');
    expect(out.learned?.rejectedProposals.slides).toBe(1);
    expect(out.questions).toEqual([]);
  });

  it('Maybe → the next-best option is queued as a new question; Maybe without options behaves like No', async () => {
    const { input } = missedDueScenario();
    const q = (await runPlanningPipeline(input, stubLlm())).questions[0]!;
    const maybe = await runPlanningPipeline(
      withOpen(input, q, { now: at('2026-11-16T09:00'), signals: [{ type: 'question-answered', questionId: q.id, answer: 'maybe' }] }),
      stubLlm(),
    );
    expect(maybe.updatedQuestions.map((u) => u.status)).toEqual(['maybe']);
    expect(maybe.apply).toEqual([]);
    expect(maybe.questions).toHaveLength(1);
    const next = maybe.questions[0]!;
    expect(next.kind).toBe('missed-due');
    expect(next.taskId).toBe('slides');
    expect(next.status).toBe('queued');
    expect(next.id).not.toBe(q.id);
    expect(show(next.slot)).toBe(show(q.alternatives[0]!.slot));
    expect(next.title.startsWith(QUESTION_PREFIX)).toBe(true);
    expect(next.replacedBlocks).toEqual(q.replacedBlocks);
    expect(next.alternatives).toHaveLength(q.alternatives.length - 1);

    const lastOption = { ...q, alternatives: [] };
    const out = await runPlanningPipeline(
      withOpen(input, lastOption, {
        now: at('2026-11-16T09:00'),
        signals: [{ type: 'question-answered', questionId: q.id, answer: 'maybe' }],
      }),
      stubLlm(),
    );
    expect(out.updatedQuestions.map((u) => u.status)).toEqual(['maybe']);
    expect(creates(out.apply, 'slides').map((c) => show(target(c)))).toEqual(['2026-11-17T10:00–12:00']);
    expect(out.learned?.rejectedProposals.slides).toBe(1);
  });

  it('a second question is queued while one is open; the open question’s task is frozen', async () => {
    const { input } = missedDueScenario();
    const open: Question = {
      id: 'q-open',
      kind: 'unclear-priority',
      title: `${QUESTION_PREFIX}Is 'Gym plan' a top priority?`,
      description: `x\n\n${RSVP_HELP}`,
      slot: { start: at('2026-11-19T09:00'), end: at('2026-11-19T10:00') },
      taskId: 'gym',
      taskListId: 'list-1',
      proposal: [],
      alternatives: [],
      replacedBlocks: [],
      replacedEventIds: [],
      proposedPriority: 5,
      createdAt: at('2026-11-15T08:00'),
      answerBy: at('2026-11-19T08:00'),
      status: 'open',
    };
    const gymBlock = block({ id: 'b-gym', taskId: 'gym', title: 'Gym plan', start: '2026-11-17T12:00', end: '2026-11-17T13:00' });
    const out = await runPlanningPipeline(
      {
        ...input,
        events: [...input.events, gymBlock],
        tasks: [...input.tasks, task({ id: 'gym', title: 'Gym plan' })],
        estimates: { ...input.estimates, gym: estimate('gym', { confidence: 0.2 }) },
        openQuestion: open,
      },
      stubLlm(),
    );
    expect(out.questions.map((q) => [q.kind, q.taskId, q.status])).toEqual([['missed-due', 'slides', 'queued']]);
    // The gym block overlaps the exam but its task is frozen by the open question.
    expect(out.apply.filter((c) => (c.op === 'create' ? c.block.taskId : c.taskId) === 'gym')).toEqual([]);
  });

  it('a queued question detected again keeps its id; one no longer relevant is superseded', async () => {
    const { input } = missedDueScenario();
    const first = (await runPlanningPipeline(input, stubLlm())).questions[0]!;
    const stale: Question = { ...first, id: 'q-stale', kind: 'dropped-task', taskId: 'gone', status: 'queued' };
    const out = await runPlanningPipeline(
      { ...input, now: at('2026-11-16T08:10'), queuedQuestions: [{ ...first, status: 'queued' }, stale] },
      stubLlm(),
    );
    expect(out.questions).toEqual([]);
    const byId = new Map(out.updatedQuestions.map((q) => [q.id, q.status]));
    expect(byId.get(first.id)).toBe('queued');
    expect(byId.get('q-stale')).toBe('superseded');
  });

  it('more than 3 blocks moved → the whole re-plan is proposed in one invitation, nothing applied', async () => {
    const events = [
      event({ id: 'workshop', title: 'Workshop', start: '2026-11-16T09:00', end: '2026-11-16T13:00' }),
      ...['a', 'b', 'c', 'd'].map((t, i) =>
        block({ id: `b-${t}`, taskId: t, start: `2026-11-16T${String(9 + i).padStart(2, '0')}:00`, end: `2026-11-16T${String(10 + i).padStart(2, '0')}:00` }),
      ),
    ];
    const tasks = ['a', 'b', 'c', 'd'].map((id) => task({ id }));
    const estimates = Object.fromEntries(tasks.map((t) => [t.id, estimate(t.id)]));
    const out = await runPlanningPipeline(
      planInput({ now: '2026-11-16T08:00', events, tasks, estimates, signals: [{ type: 'fixed-event-changed', eventId: 'workshop' }] }),
      stubLlm(),
    );
    expect(out.apply).toEqual([]);
    expect(out.questions).toHaveLength(1);
    const q = out.questions[0]!;
    expect(q.kind).toBe('big-change');
    expect(q.title).toBe(`${QUESTION_PREFIX}Move 4 blocks?`);
    expect(q.replacedEventIds).toEqual(['b-a']);
    expect(show(q.slot)).toBe('2026-11-16T13:00–14:00');
    expect(moves(q.proposal)).toHaveLength(3);
    expect(creates(q.proposal).map((c) => c.block.taskId)).toEqual(['a']);
    expectFixedEventsUntouched(out, events);
  });

  it('a block moved by more than 2 days → invitation', async () => {
    const events = [
      ...['16', '17', '18'].map((d) => event({ id: `conf-${d}`, title: 'Conference', start: `2026-11-${d}T09:00`, end: `2026-11-${d}T18:00` })),
      block({ id: 'b-a', taskId: 'a', start: '2026-11-16T09:00', end: '2026-11-16T10:00' }),
    ];
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T08:00',
        events,
        tasks: [task({ id: 'a', title: 'Report' })],
        estimates: { a: estimate('a') },
        signals: [{ type: 'fixed-event-changed', eventId: 'conf-16' }],
      }),
      stubLlm(),
    );
    expect(out.apply).toEqual([]);
    expect(out.questions.map((q) => q.kind)).toEqual(['big-change']);
    expect(out.questions[0]!.title).toBe(`${QUESTION_PREFIX}Move 'Report' to Thu 19 Nov?`);
    expect(local(out.questions[0]!.slot.start)).toBe('2026-11-19T09:00');
  });

  it('unclear priority → question at the task’s block; Yes stores the priority', async () => {
    const input = planInput({
      now: '2026-11-16T06:30',
      tasks: [task({ id: 'vague', title: 'Sort out stuff' })],
      signals: [{ type: 'tasks-changed', taskIds: ['vague'] }],
    });
    const llm = stubLlm({ estimates: { 'Sort out stuff': { confidence: 0.3, priority: 2 } } });
    const out = await runPlanningPipeline(input, llm);
    const [created] = creates(out.apply, 'vague');
    expect(created).toBeDefined();
    expect(out.questions.map((q) => [q.kind, q.status])).toEqual([['unclear-priority', 'open']]);
    const q = out.questions[0]!;
    expect(show(q.slot)).toBe(show(target(created!)));
    expect(q.replacedEventIds).toEqual([]);

    const answered = await runPlanningPipeline(
      {
        ...input,
        now: at('2026-11-16T08:30'),
        events: [block({ id: 'b-vague', taskId: 'vague', start: local(created!.block.start), end: local(created!.block.end) })],
        estimates: out.estimates,
        openQuestion: { ...q, status: 'open' },
        signals: [{ type: 'question-answered', questionId: q.id, answer: 'yes' }],
      },
      llm,
    );
    expect(answered.learned?.taskPriority.vague).toBe(5);
    expect(answered.updatedQuestions.map((u) => u.status)).toEqual(['yes']);
    expect(answered.questions).toEqual([]);
  });

  it('unclear priority answered No → keep the estimate and stop asking', async () => {
    const input = planInput({
      now: '2026-11-16T08:00',
      tasks: [task({ id: 'vague', title: 'Sort out stuff' })],
      signals: [{ type: 'tasks-changed', taskIds: ['vague'] }],
    });
    const llm = stubLlm({ estimates: { 'Sort out stuff': { confidence: 0.3, priority: 2 } } });
    const first = await runPlanningPipeline(input, llm);
    const q = first.questions[0]!;
    const out = await runPlanningPipeline(
      { ...input, estimates: first.estimates, openQuestion: { ...q, status: 'open' }, signals: [{ type: 'question-answered', questionId: q.id, answer: 'no' }] },
      llm,
    );
    expect(out.estimates.vague?.confidence).toBe(1);
    expect(out.estimates.vague?.priority).toBe(2);
    expect(out.questions).toEqual([]);
  });

  it('a task that cannot be placed at all within the horizon → dropped-task question', async () => {
    const events = [event({ id: 'busy', title: 'Internship', start: '2026-11-16T09:00', end: '2026-11-16T18:00' })];
    const out = await runPlanningPipeline(
      planInput({
        now: '2026-11-16T08:00',
        events,
        horizonDays: 1,
        tasks: [task({ id: 'big', title: 'Big essay' })],
        signals: [{ type: 'tasks-changed', taskIds: ['big'] }],
      }),
      stubLlm({ estimates: { 'Big essay': { durationMin: 240 } } }),
    );
    expect(out.questions.map((q) => [q.kind, q.title])).toEqual([['dropped-task', `${QUESTION_PREFIX}Drop 'Big essay'?`]]);
    expect(out.questions[0]!.slot.start.getTime()).toBeGreaterThanOrEqual(at('2026-11-16T10:00').getTime());
    expect(out.apply).toEqual([]);
  });
});
