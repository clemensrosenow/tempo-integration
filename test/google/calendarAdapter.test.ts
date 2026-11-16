import { describe, expect, it } from 'vitest';
import { GoogleCalendarAdapter, recordSyncTokenStore } from '../../src/google/calendarAdapter.js';
import {
  DESCRIPTION_FOOTER,
  PROP,
  TEMPO_CALENDAR_DESCRIPTION,
  TEMPO_CALENDAR_MARKER,
  toGoogleEvent,
} from '../../src/google/mapping.js';
import { asCalendarApi, fakeCalendarApi, httpError, noSleep } from './fakes.js';

const NOW = new Date('2026-11-16T12:00:00.000Z');

function timed(id: string, start: string, end: string, extra: Record<string, unknown> = {}) {
  return { id, summary: id, status: 'confirmed', start: { dateTime: start }, end: { dateTime: end }, ...extra };
}

function make(api = fakeCalendarApi(), tokens: Record<string, string> = {}, logs: string[] = []) {
  const adapter = new GoogleCalendarAdapter(null, {
    api: asCalendarApi(api),
    syncTokens: recordSyncTokenStore(tokens),
    retry: noSleep,
    log: (l) => logs.push(l),
    now: () => NOW,
  });
  return { adapter, api, tokens, logs };
}

describe('GoogleCalendarAdapter.listEvents', () => {
  it('paginates, expands single events and maps all calendars', async () => {
    const { adapter, api } = make();
    api.events.list.mockImplementation(async (p) => {
      if (p.calendarId === 'primary' && !p.pageToken) {
        return { data: { items: [timed('a', '2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z')], nextPageToken: 'p2' } };
      }
      if (p.calendarId === 'primary' && p.pageToken === 'p2') {
        return {
          data: {
            timeZone: 'Europe/Berlin',
            items: [{ id: 'allday', start: { date: '2026-11-18' }, end: { date: '2026-11-19' } }],
          },
        };
      }
      return { data: { items: [timed('c', '2026-11-17T11:00:00Z', '2026-11-17T12:00:00Z')] } };
    });
    const events = await adapter.listEvents(['primary', 'uni', 'primary'], {
      start: new Date('2026-11-16T00:00:00Z'),
      end: new Date('2026-11-23T00:00:00Z'),
    });
    expect(events.map((e) => `${e.calendarId}/${e.id}`)).toEqual(['primary/a', 'primary/allday', 'uni/c']);
    expect(events[1]!.start.toISOString()).toBe('2026-11-17T23:00:00.000Z'); // Berlin midnight
    const first = api.events.list.mock.calls[0]![0];
    expect(first).toMatchObject({
      calendarId: 'primary',
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      timeMin: '2026-11-16T00:00:00.000Z',
      timeMax: '2026-11-23T00:00:00.000Z',
    });
    expect(api.events.list).toHaveBeenCalledTimes(3); // duplicate id read once
  });

  it('skips calendars that fail with 404/403 but rethrows other errors', async () => {
    const { adapter, api, logs } = make();
    api.events.list.mockImplementation(async (p) => {
      if (p.calendarId === 'gone') throw httpError(404);
      if (p.calendarId === 'forbidden') throw httpError(403, 'forbidden');
      return { data: { items: [timed('ok', '2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z')] } };
    });
    const range = { start: NOW, end: new Date('2026-11-20T00:00:00Z') };
    const events = await adapter.listEvents(['gone', 'forbidden', 'primary'], range);
    expect(events.map((e) => e.id)).toEqual(['ok']);
    expect(logs.some((l) => l.includes('gone'))).toBe(true);

    api.events.list.mockImplementation(async () => {
      throw httpError(400);
    });
    await expect(adapter.listEvents(['primary'], range)).rejects.toThrow('HTTP 400');
  });

  it('retries rate limits (403 rateLimitExceeded, 429) and 5xx', async () => {
    const { adapter, api } = make();
    let n = 0;
    api.events.list.mockImplementation(async () => {
      n++;
      if (n === 1) throw httpError(403, 'rateLimitExceeded');
      if (n === 2) throw httpError(429);
      if (n === 3) throw httpError(503);
      return { data: { items: [] } };
    });
    await expect(adapter.listEvents(['primary'], { start: NOW, end: NOW })).resolves.toEqual([]);
    expect(n).toBe(4);
  });
});

describe('GoogleCalendarAdapter.listChanges', () => {
  it('does a full sync first, stores the token from the LAST page, then syncs incrementally', async () => {
    const { adapter, api, tokens } = make();
    api.events.list.mockImplementation(async (p) => {
      if (!p.syncToken && !p.pageToken) {
        return { data: { items: [timed('a', '2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z')], nextPageToken: 'x' } };
      }
      if (!p.syncToken && p.pageToken === 'x') {
        return { data: { items: [timed('b', '2026-11-18T09:00:00Z', '2026-11-18T10:00:00Z')], nextSyncToken: 'S1' } };
      }
      return { data: { items: [{ id: 'a', status: 'cancelled' }], nextSyncToken: 'S2' } };
    });

    const full = await adapter.listChanges('primary');
    expect(full.fullResync).toBe(true);
    expect(full.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(tokens.primary).toBe('S1');
    const fullParams = api.events.list.mock.calls[0]![0];
    expect(fullParams.timeMin).toBe('2026-11-09T12:00:00.000Z');
    expect(fullParams.orderBy).toBeUndefined();

    const delta = await adapter.listChanges('primary');
    expect(delta.fullResync).toBe(false);
    expect(delta.events).toHaveLength(1);
    expect(delta.events[0]).toMatchObject({ id: 'a', status: 'cancelled' });
    expect(tokens.primary).toBe('S2');
    const incParams = api.events.list.mock.calls[2]![0];
    expect(incParams).toMatchObject({ syncToken: 'S1', singleEvents: true });
    expect(incParams.timeMin).toBeUndefined();
    expect(incParams.timeMax).toBeUndefined();
    expect(incParams.orderBy).toBeUndefined();
    expect(incParams.showDeleted).toBeUndefined();
  });

  it('handles 410 GONE by clearing the token and doing a full resync', async () => {
    const { adapter, api, tokens, logs } = make(undefined, { primary: 'STALE' });
    api.events.list.mockImplementation(async (p) => {
      if (p.syncToken === 'STALE') throw httpError(410, 'fullSyncRequired');
      return { data: { items: [timed('fresh', '2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z')], nextSyncToken: 'NEW' } };
    });
    const delta = await adapter.listChanges('primary');
    expect(delta).toMatchObject({ fullResync: true });
    expect(delta.events.map((e) => e.id)).toEqual(['fresh']);
    expect(tokens.primary).toBe('NEW');
    expect(logs.join('\n')).toContain('410');
  });
});

describe('GoogleCalendarAdapter.ensureTempoCalendar', () => {
  it('reuses the calendar with the marker', async () => {
    const { adapter, api } = make();
    api.calendarList.list.mockResolvedValue({
      data: {
        items: [
          { id: 'me@gmail.com', summary: 'me', primary: true, accessRole: 'owner' },
          { id: 'tempo@group', summary: 'Tempo', description: `x ${TEMPO_CALENDAR_MARKER}`, accessRole: 'owner' },
        ],
      },
    });
    await expect(adapter.ensureTempoCalendar('Europe/Berlin')).resolves.toBe('tempo@group');
    expect(api.calendars.insert).not.toHaveBeenCalled();
  });

  it('creates and colours the calendar when missing', async () => {
    const { adapter, api } = make();
    api.calendarList.list.mockResolvedValue({ data: { items: [{ id: 'me@gmail.com', primary: true, accessRole: 'owner' }] } });
    api.calendars.insert.mockResolvedValue({ data: { id: 'new@group' } });
    api.calendarList.patch.mockResolvedValue({ data: {} });
    await expect(adapter.ensureTempoCalendar('Europe/Berlin')).resolves.toBe('new@group');
    expect(api.calendars.insert.mock.calls[0]![0]).toEqual({
      requestBody: { summary: 'Tempo', description: TEMPO_CALENDAR_DESCRIPTION, timeZone: 'Europe/Berlin' },
    });
    expect(api.calendarList.patch.mock.calls[0]![0]).toMatchObject({
      calendarId: 'new@group',
      colorRgbFormat: true,
      requestBody: { backgroundColor: '#7c4dff', foregroundColor: '#ffffff', selected: true },
    });
  });

  it('inserts into the calendar list when patch returns 404', async () => {
    const { adapter, api } = make();
    api.calendarList.list.mockResolvedValue({ data: { items: [] } });
    api.calendars.insert.mockResolvedValue({ data: { id: 'new@group' } });
    api.calendarList.patch.mockRejectedValue(httpError(404));
    api.calendarList.insert.mockResolvedValue({ data: {} });
    await adapter.ensureTempoCalendar('UTC');
    expect(api.calendarList.insert.mock.calls[0]![0]).toMatchObject({ requestBody: { id: 'new@group' } });
  });
});

describe('GoogleCalendarAdapter block writes', () => {
  const draft = {
    taskId: 't1',
    taskListId: 'l1',
    title: 'Essay',
    start: new Date('2026-11-17T09:00:00Z'),
    end: new Date('2026-11-17T10:00:00Z'),
    reason: 'Planned before Friday',
  };

  it('createBlock inserts into the Tempo calendar without notifications', async () => {
    const { adapter, api } = make();
    api.events.insert.mockImplementation(async (p) => ({ data: { ...p.requestBody, id: 'ev1' } }));
    const ev = await adapter.createBlock('tempo@group', draft);
    const call = api.events.insert.mock.calls[0]![0];
    expect(call).toMatchObject({ calendarId: 'tempo@group', sendUpdates: 'none' });
    expect(call.requestBody.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(ev).toMatchObject({ id: 'ev1', calendarId: 'tempo@group', tempo: { kind: 'block', taskId: 't1' } });
  });

  it('updateBlock always rewrites planned start/end and merges the description', async () => {
    const { adapter, api } = make();
    const existing = {
      ...toGoogleEvent({ ...draft, learned: ['you like mornings'] }),
      id: 'ev1',
      // user dragged it by +1h
      start: { dateTime: '2026-11-17T10:00:00Z' },
      end: { dateTime: '2026-11-17T11:00:00Z' },
    };
    api.events.get.mockResolvedValue({ data: existing });
    api.events.patch.mockImplementation(async (p) => ({
      data: {
        ...existing,
        ...p.requestBody,
        extendedProperties: { private: p.requestBody.extendedProperties.private },
      },
    }));

    // description-only update acknowledges the user's drag
    const ev = await adapter.updateBlock('tempo@group', 'ev1', { reason: 'Kept where you moved it' });
    const body = api.events.patch.mock.calls[0]![0].requestBody;
    expect(api.events.patch.mock.calls[0]![0]).toMatchObject({ calendarId: 'tempo@group', sendUpdates: 'none' });
    expect(body.start).toBeUndefined();
    expect(body.extendedProperties.private[PROP.plannedStart]).toBe('2026-11-17T10:00:00.000Z');
    expect(body.extendedProperties.private[PROP.plannedEnd]).toBe('2026-11-17T11:00:00.000Z');
    expect(body.extendedProperties.private[PROP.taskId]).toBe('t1');
    expect(body.description).toBe(
      `Kept where you moved it\nTempo learned: you like mornings\n\n${DESCRIPTION_FOOTER}`,
    );
    expect(ev.tempo?.plannedStart).toBe('2026-11-17T10:00:00.000Z');

    // move
    await adapter.updateBlock('tempo@group', 'ev1', {
      start: new Date('2026-11-18T08:00:00Z'),
      end: new Date('2026-11-18T09:30:00Z'),
    });
    const body2 = api.events.patch.mock.calls[1]![0].requestBody;
    expect(body2.start).toEqual({ dateTime: '2026-11-18T08:00:00.000Z' });
    expect(body2.extendedProperties.private[PROP.plannedEnd]).toBe('2026-11-18T09:30:00.000Z');
    expect(body2.description).toBeUndefined();
  });

  it('refuses to update events that are not Tempo blocks', async () => {
    const { adapter, api } = make();
    api.events.get.mockResolvedValue({ data: timed('fixed', '2026-11-17T09:00:00Z', '2026-11-17T10:00:00Z') });
    await expect(adapter.updateBlock('tempo@group', 'fixed', { reason: 'x' })).rejects.toThrow(/not a Tempo block/);
    expect(api.events.patch).not.toHaveBeenCalled();
  });

  it('deleteBlock ignores already-deleted events', async () => {
    const { adapter, api } = make();
    api.events.delete.mockRejectedValueOnce(httpError(410)).mockResolvedValueOnce({});
    await adapter.deleteBlock('tempo@group', 'gone');
    await adapter.deleteBlock('tempo@group', 'ev2');
    expect(api.events.delete.mock.calls[1]![0]).toEqual({ calendarId: 'tempo@group', eventId: 'ev2', sendUpdates: 'none' });
  });

  it('getUserEmail reads the primary calendar id once', async () => {
    const { adapter, api } = make();
    api.calendars.get.mockResolvedValue({ data: { id: 'me@gmail.com' } });
    await expect(adapter.getUserEmail()).resolves.toBe('me@gmail.com');
    await adapter.getUserEmail();
    expect(api.calendars.get).toHaveBeenCalledTimes(1);
  });
});
