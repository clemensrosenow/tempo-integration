import { describe, expect, it } from 'vitest';
import type { UnderstandRequest } from '../../src/core/ports.js';
import { HeuristicLlm } from '../../src/llm/heuristic.js';

const now = new Date('2026-11-16T09:00:00+01:00');
const llm = new HeuristicLlm();

function req(tasks: UnderstandRequest['tasks']): UnderstandRequest {
  return { tasks, now, timezone: 'Europe/Berlin', learnedNotes: [] };
}

async function one(task: UnderstandRequest['tasks'][number]) {
  const [e] = await llm.understand(req([task]));
  if (!e) throw new Error('no estimate');
  return e;
}

describe('HeuristicLlm.understand', () => {
  it('treats exam preparation as long deep work with high priority', async () => {
    const e = await one({ id: 'a', title: 'Study for HCI exam', due: new Date('2026-11-18T00:00:00+01:00') });
    expect(e.taskId).toBe('a');
    expect(e.durationMin).toBeGreaterThanOrEqual(120);
    expect(e.deepWork).toBe(true);
    expect(e.priority).toBeGreaterThanOrEqual(4);
    expect(e.urgency).toBeGreaterThanOrEqual(4);
    expect(e.confidence).toBeGreaterThanOrEqual(0.5);
    expect(e.minChunkMin).toBeLessThanOrEqual(e.durationMin);
  });

  it('treats writing tasks as long deep work', async () => {
    for (const title of ['Write essay on Horvitz', 'Prepare slides for presentation', 'Seminar paper draft']) {
      const e = await one({ id: title, title });
      expect(e.durationMin, title).toBeGreaterThanOrEqual(90);
      expect(e.deepWork, title).toBe(true);
    }
  });

  it('treats errands as short and reading as medium', async () => {
    const email = await one({ id: 'e', title: 'Email professor about extension' });
    expect(email.durationMin).toBeLessThanOrEqual(30);
    expect(email.deepWork).toBe(false);
    const read = await one({ id: 'r', title: 'Read chapter 4' });
    expect(read.durationMin).toBeGreaterThan(email.durationMin);
    expect(read.durationMin).toBeLessThanOrEqual(90);
  });

  it('adds time for long notes and respects explicit durations', async () => {
    const plain = await one({ id: 'p', title: 'Read chapter 4' });
    const noted = await one({ id: 'n', title: 'Read chapter 4', notes: 'x'.repeat(800) });
    expect(noted.durationMin).toBeGreaterThan(plain.durationMin);
    const explicit = await one({ id: 'x', title: 'Practice guitar 45 min' });
    expect(explicit.durationMin).toBe(45);
  });

  it('derives urgency from due distance', async () => {
    const soon = await one({ id: 's', title: 'Read paper', due: new Date('2026-11-17T00:00:00+01:00') });
    const later = await one({ id: 'l', title: 'Read paper', due: new Date('2026-12-20T00:00:00+01:00') });
    const none = await one({ id: 'n', title: 'Read paper' });
    expect(soon.urgency).toBe(5);
    expect(later.urgency).toBe(1);
    expect(none.urgency).toBeLessThan(soon.urgency);
  });

  it('raises priority for deadline words and exclamation marks', async () => {
    const plain = await one({ id: 'p', title: 'Read paper' });
    const bang = await one({ id: 'b', title: 'Read paper!!' });
    const submit = await one({ id: 's', title: 'Submit assignment 3' });
    expect(bang.priority).toBeGreaterThan(plain.priority);
    expect(submit.priority).toBeGreaterThan(plain.priority);
  });

  it('is unsure only about very vague titles', async () => {
    const vague = await one({ id: 'v', title: 'Stuff' });
    expect(vague.confidence).toBeLessThan(0.5);
    const vagueWithDue = await one({ id: 'w', title: 'Stuff', due: new Date('2026-11-20T00:00:00+01:00') });
    expect(vagueWithDue.confidence).toBeGreaterThanOrEqual(0.5);
    const clear = await one({ id: 'c', title: 'Buy milk' });
    expect(clear.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it('caps subtasks and sizes parents by their subtasks', async () => {
    const sub = await one({ id: 's', title: 'Write introduction', parentId: 'p' });
    expect(sub.durationMin).toBeLessThanOrEqual(90);
    const parent = await one({ id: 'p', title: 'Group project', subtaskTitles: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(parent.durationMin).toBeGreaterThanOrEqual(180);
  });

  it('is deterministic', async () => {
    const tasks = [{ id: 'a', title: 'Study for exam' }, { id: 'b', title: 'Call mom' }];
    expect(await llm.understand(req(tasks))).toEqual(await llm.understand(req(tasks)));
  });
});

describe('HeuristicLlm.place / explain', () => {
  it('leaves placement to the core', async () => {
    const r = await llm.place();
    expect(r).toBeNull();
  });

  it('writes short reasons from the cause', async () => {
    const out = await llm.explain({
      now,
      timezone: 'Europe/Berlin',
      changes: [
        {
          taskId: 'a',
          title: 'Essay',
          kind: 'moved',
          cause: "Fixed event 'Project meeting' extended by 45 min",
          from: { start: new Date('2026-11-16T14:00:00+01:00'), end: new Date('2026-11-16T15:00:00+01:00') },
          to: { start: new Date('2026-11-16T15:00:00+01:00'), end: new Date('2026-11-16T16:00:00+01:00') },
        },
        { taskId: 'b', title: 'Read', kind: 'created', cause: 'new task due Friday' },
        { taskId: 'c', title: 'Long', kind: 'dropped', cause: 'x'.repeat(200) },
      ],
    });
    expect(out.a).toContain('Project meeting');
    expect(out.a?.startsWith('Moved')).toBe(true);
    expect(out.b).toContain('due Friday');
    for (const reason of Object.values(out)) expect(reason.length).toBeLessThanOrEqual(90);
  });
});
