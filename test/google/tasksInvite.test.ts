import { describe, expect, it } from 'vitest';
import { QUESTION_PREFIX, type Question } from '../../src/core/types.js';
import { GoogleInviteAdapter } from '../../src/google/inviteAdapter.js';
import { PROP } from '../../src/google/mapping.js';
import { GoogleTasksAdapter } from '../../src/google/tasksAdapter.js';
import { asCalendarApi, asTasksApi, fakeCalendarApi, fakeTasksApi, httpError, noSleep } from './fakes.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

describe('GoogleTasksAdapter', () => {
  it('reads all lists with pagination, open + recently completed, skips deleted/old', async () => {
    const api = fakeTasksApi();
    api.tasklists.list.mockImplementation(async (p) =>
      p.pageToken ? { data: { items: [{ id: 'L2' }] } } : { data: { items: [{ id: 'L1' }], nextPageToken: 'n' } },
    );
    api.tasks.list.mockImplementation(async (p) => {
      if (p.tasklist === 'L1' && p.showCompleted === false) {
        if (!p.pageToken) {
          return {
            data: {
              items: [{ id: 'open1', title: 'Essay', status: 'needsAction', due: '2026-11-20T00:00:00.000Z', position: '1' }],
              nextPageToken: 'pg2',
            },
          };
        }
        return {
          data: {
            items: [
              { id: 'sub1', title: 'Outline', status: 'needsAction', parent: 'open1', position: '2' },
              { id: 'del', title: 'x', status: 'needsAction', deleted: true },
            ],
          },
        };
      }
      if (p.tasklist === 'L1' && p.showCompleted === true) {
        return {
          data: {
            items: [
              { id: 'done', title: 'Read', status: 'completed', completed: '2026-11-15T10:00:00.000Z', hidden: true },
              { id: 'old', title: 'Old', status: 'completed', completed: '2026-10-01T10:00:00.000Z' },
            ],
          },
        };
      }
      return { data: { items: [] } };
    });

    const adapter = new GoogleTasksAdapter(null, () => 'America/Los_Angeles', {
      api: asTasksApi(api),
      retry: noSleep,
      now: () => NOW,
    });
    const tasks = await adapter.listTasks();
    expect(tasks.map((t) => t.id).sort()).toEqual(['done', 'open1', 'sub1']);
    const essay = tasks.find((t) => t.id === 'open1')!;
    expect(essay.listId).toBe('L1');
    expect(essay.due?.toISOString()).toBe('2026-11-21T08:00:00.000Z');
    expect(tasks.find((t) => t.id === 'sub1')!.parentId).toBe('open1');
    expect(tasks.find((t) => t.id === 'done')!.completedAt?.toISOString()).toBe('2026-11-15T10:00:00.000Z');

    const calls = api.tasks.list.mock.calls.map((c) => c[0]);
    const completedCall = calls.find((c) => c.tasklist === 'L1' && c.showCompleted === true)!;
    expect(completedCall).toMatchObject({
      showHidden: true,
      showDeleted: false,
      maxResults: 100,
      completedMin: '2026-11-09T12:00:00.000Z',
    });
    expect(calls.filter((c) => c.tasklist === 'L2')).toHaveLength(2);
  });

  it('honours completedSinceDays=0 (no completed query)', async () => {
    const api = fakeTasksApi();
    api.tasklists.list.mockResolvedValue({ data: { items: [{ id: 'L1' }] } });
    api.tasks.list.mockResolvedValue({ data: { items: [] } });
    const adapter = new GoogleTasksAdapter(null, () => 'UTC', { api: asTasksApi(api), now: () => NOW });
    await adapter.listTasks({ completedSinceDays: 0 });
    expect(api.tasks.list).toHaveBeenCalledTimes(1);
  });
});

describe('GoogleInviteAdapter', () => {
  const question: Question = {
    id: 'Q1',
    kind: 'big-change',
    title: `${QUESTION_PREFIX}Move 4 blocks to tomorrow?`,
    description: 'Yes = apply · No = keep as is · Maybe = other time',
    slot: { start: new Date('2026-11-17T14:00:00Z'), end: new Date('2026-11-17T15:00:00Z') },
    taskId: 't1',
    taskListId: 'l1',
    proposal: [],
    alternatives: [],
    replacedBlocks: [],
    replacedEventIds: [],
    createdAt: NOW,
    answerBy: new Date('2026-11-17T13:00:00Z'),
    status: 'queued',
  };

  function make() {
    const api = fakeCalendarApi();
    const logs: string[] = [];
    const adapter = new GoogleInviteAdapter(null, { api: asCalendarApi(api), retry: noSleep, log: (l) => logs.push(l) });
    return { api, adapter, logs };
  }

  it('sends the invitation from the organizer primary calendar with sendUpdates=all', async () => {
    const { api, adapter } = make();
    api.events.insert.mockResolvedValue({ data: { id: 'inv1' } });
    await expect(adapter.sendQuestion(question, 'me@gmail.com')).resolves.toBe('inv1');
    const call = api.events.insert.mock.calls[0]![0];
    expect(call.calendarId).toBe('primary');
    expect(call.sendUpdates).toBe('all');
    expect(call.requestBody.attendees).toEqual([{ email: 'me@gmail.com' }]);
    expect(call.requestBody.extendedProperties.shared[PROP.questionId]).toBe('Q1');
  });

  it('reads the attendee response case-insensitively', async () => {
    const { api, adapter } = make();
    api.events.get.mockResolvedValue({
      data: {
        id: 'inv1',
        attendees: [
          { email: 'tempo@gmail.com', organizer: true, responseStatus: 'accepted' },
          { email: 'Me@GMail.com', responseStatus: 'tentative' },
        ],
      },
    });
    await expect(adapter.getResponse('inv1', 'me@gmail.com')).resolves.toBe('tentative');
    await expect(adapter.getResponse('inv1', 'other@gmail.com')).resolves.toBe('needsAction');
    api.events.get.mockRejectedValue(httpError(404));
    await expect(adapter.getResponse('inv1', 'me@gmail.com')).resolves.toBe('needsAction');
  });

  it('annotates silently and cancels with notifications', async () => {
    const { api, adapter } = make();
    api.events.patch.mockResolvedValue({ data: {} });
    api.events.delete.mockResolvedValueOnce({}).mockRejectedValueOnce(httpError(410));
    await adapter.annotate('inv1', 'No answer — kept your plan.');
    expect(api.events.patch.mock.calls[0]![0]).toEqual({
      calendarId: 'primary',
      eventId: 'inv1',
      sendUpdates: 'none',
      requestBody: { description: 'No answer — kept your plan.' },
    });
    await adapter.cancel('inv1');
    expect(api.events.delete.mock.calls[0]![0]).toEqual({ calendarId: 'primary', eventId: 'inv1', sendUpdates: 'all' });
    await expect(adapter.cancel('inv1')).resolves.toBeUndefined();
  });
});
