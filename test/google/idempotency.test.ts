import { describe, expect, it } from 'vitest';
import { GoogleCalendarAdapter, newEventId } from '../../src/google/calendarAdapter.js';
import { asCalendarApi, fakeCalendarApi, httpError, noSleep } from './fakes.js';

const block = {
  taskId: 'task-1',
  taskListId: 'list-1',
  title: 'Read paper',
  start: new Date('2026-11-23T09:00:00Z'),
  end: new Date('2026-11-23T10:00:00Z'),
  reason: 'Planned in free time.',
};

describe('Google calendar adapter robustness', () => {
  it('generates valid base32hex event ids', () => {
    const id = newEventId();
    expect(id).toMatch(/^[a-v0-9]{5,1024}$/);
    expect(newEventId()).not.toBe(id);
  });

  it('treats 409 on a retried insert as success and reads the event back', async () => {
    const api = fakeCalendarApi();
    let sentId = '';
    api.events.insert.mockImplementation(async (p: { requestBody: { id: string } }) => {
      sentId = p.requestBody.id;
      throw httpError(409, 'duplicate');
    });
    api.events.get.mockImplementation(async (p: { eventId: string }) => ({
      data: {
        id: p.eventId,
        status: 'confirmed',
        summary: 'Read paper',
        updated: '2026-11-23T08:00:00Z',
        start: { dateTime: '2026-11-23T09:00:00Z' },
        end: { dateTime: '2026-11-23T10:00:00Z' },
        extendedProperties: {
          private: {
            tempo: '1',
            tempoKind: 'block',
            tempoTaskId: 'task-1',
            tempoTaskListId: 'list-1',
            tempoPlannedStart: '2026-11-23T09:00:00.000Z',
            tempoPlannedEnd: '2026-11-23T10:00:00.000Z',
          },
        },
      },
    }));
    const adapter = new GoogleCalendarAdapter(null, { api: asCalendarApi(api), retry: noSleep });
    const ev = await adapter.createBlock('tempo-cal', block);
    expect(ev.id).toBe(sentId);
    expect(ev.tempo?.taskId).toBe('task-1');
  });

  it('reports a deleted (cancelled) event as not found when moving it', async () => {
    const api = fakeCalendarApi();
    api.events.get.mockResolvedValue({ data: { id: 'x', status: 'cancelled' } });
    const adapter = new GoogleCalendarAdapter(null, { api: asCalendarApi(api), retry: noSleep });
    await expect(adapter.updateBlock('tempo-cal', 'x', { start: block.start, end: block.end })).rejects.toMatchObject({
      status: 404,
    });
    expect(api.events.patch).not.toHaveBeenCalled();
  });
});
