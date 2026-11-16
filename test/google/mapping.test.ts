import { describe, expect, it } from 'vitest';
import { QUESTION_PREFIX, RSVP_HELP, type BlockDraft, type Question } from '../../src/core/types.js';
import {
  DESCRIPTION_FOOTER,
  PROP,
  TEMPO_CALENDAR_MARKER,
  dueDateToDeadline,
  fromCalendarListEntry,
  fromGoogleEvent,
  fromGoogleTask,
  parseBlockDescription,
  parseTempoMeta,
  renderBlockDescription,
  toGoogleEvent,
  toInviteEvent,
} from '../../src/google/mapping.js';

const block: BlockDraft = {
  taskId: 'task-1',
  taskListId: 'list-1',
  title: 'Write essay intro',
  start: new Date('2026-11-17T09:00:00.000Z'),
  end: new Date('2026-11-17T10:30:00.000Z'),
  part: 1,
  reason: 'Moved after your meeting ran 45 min over',
  learned: ['Writing takes you ~1.5x longer'],
};

describe('event mapping', () => {
  it('round-trips a BlockDraft through the Google resource', () => {
    const resource = toGoogleEvent(block, { timeZone: 'Europe/Berlin' });
    expect(resource.summary).toBe(block.title);
    expect(resource.start).toEqual({ dateTime: '2026-11-17T09:00:00.000Z', timeZone: 'Europe/Berlin' });
    expect(resource.transparency).toBe('opaque');
    expect(resource.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(resource.extendedProperties?.private).toMatchObject({
      [PROP.tempo]: '1',
      [PROP.kind]: 'block',
      [PROP.taskId]: 'task-1',
      [PROP.taskListId]: 'list-1',
      [PROP.plannedStart]: '2026-11-17T09:00:00.000Z',
      [PROP.plannedEnd]: '2026-11-17T10:30:00.000Z',
      [PROP.part]: '1',
    });

    const ev = fromGoogleEvent(
      { ...resource, id: 'ev1', status: 'confirmed', updated: '2026-11-16T08:00:00.000Z' },
      'tempo-cal',
    );
    expect(ev).not.toBeNull();
    expect(ev!.id).toBe('ev1');
    expect(ev!.calendarId).toBe('tempo-cal');
    expect(ev!.start.toISOString()).toBe(block.start.toISOString());
    expect(ev!.end.toISOString()).toBe(block.end.toISOString());
    expect(ev!.allDay).toBe(false);
    expect(ev!.updated.toISOString()).toBe('2026-11-16T08:00:00.000Z');
    expect(ev!.tempo).toEqual({
      kind: 'block',
      taskId: 'task-1',
      taskListId: 'list-1',
      plannedStart: '2026-11-17T09:00:00.000Z',
      plannedEnd: '2026-11-17T10:30:00.000Z',
      part: 1,
    });
    expect(parseBlockDescription(ev!.description)).toEqual({
      reason: block.reason,
      learned: ['Writing takes you ~1.5x longer'],
    });
  });

  it('keeps planned times separate from live times (user drag detection)', () => {
    const resource = toGoogleEvent(block);
    const dragged = fromGoogleEvent(
      {
        ...resource,
        id: 'ev1',
        start: { dateTime: '2026-11-17T12:00:00+01:00' },
        end: { dateTime: '2026-11-17T14:00:00+01:00' },
      },
      'tempo-cal',
    )!;
    expect(dragged.start.toISOString()).toBe('2026-11-17T11:00:00.000Z');
    expect(dragged.tempo?.plannedStart).toBe('2026-11-17T09:00:00.000Z');
  });

  it('maps all-day events to local midnight of the calendar time zone', () => {
    const ev = fromGoogleEvent(
      { id: 'a', summary: 'Holiday', start: { date: '2026-12-24' }, end: { date: '2026-12-25' } },
      'cal',
      { timeZone: 'Europe/Berlin' },
    )!;
    expect(ev.allDay).toBe(true);
    expect(ev.start.toISOString()).toBe('2026-12-23T23:00:00.000Z');
    expect(ev.end.toISOString()).toBe('2026-12-24T23:00:00.000Z');
    // Falls back to UTC without a zone
    const utc = fromGoogleEvent({ id: 'b', start: { date: '2026-12-24' }, end: { date: '2026-12-25' } }, 'cal')!;
    expect(utc.start.toISOString()).toBe('2026-12-24T00:00:00.000Z');
  });

  it('reads the own RSVP from the attendee with self=true, transparency and status', () => {
    const ev = fromGoogleEvent(
      {
        id: 'm',
        summary: 'Lecture',
        transparency: 'transparent',
        status: 'tentative',
        start: { dateTime: '2026-11-17T10:00:00Z' },
        end: { dateTime: '2026-11-17T12:00:00Z' },
        attendees: [
          { email: 'prof@uni.de', responseStatus: 'accepted', organizer: true },
          { email: 'me@gmail.com', responseStatus: 'declined', self: true },
        ],
      },
      'primary',
    )!;
    expect(ev.selfResponse).toBe('declined');
    expect(ev.transparency).toBe('transparent');
    expect(ev.status).toBe('tentative');
    expect(ev.tempo).toBeUndefined();
  });

  it('has no selfResponse when the user is not an attendee', () => {
    const ev = fromGoogleEvent(
      { id: 'x', start: { dateTime: '2026-11-17T10:00:00Z' }, end: { dateTime: '2026-11-17T11:00:00Z' } },
      'primary',
    )!;
    expect(ev.selfResponse).toBeUndefined();
    expect(ev.transparency).toBe('opaque');
    expect(ev.status).toBe('confirmed');
    expect(ev.title).toBe('');
  });

  it('keeps cancelled tombstones from incremental sync and drops malformed events', () => {
    const tomb = fromGoogleEvent({ id: 'gone', status: 'cancelled' }, 'cal')!;
    expect(tomb.status).toBe('cancelled');
    expect(tomb.start.getTime()).toBe(0);
    expect(fromGoogleEvent({ id: 'bad', status: 'confirmed' }, 'cal')).toBeNull();
    expect(fromGoogleEvent({ start: { dateTime: '2026-11-17T10:00:00Z' } }, 'cal')).toBeNull();
  });
});

describe('question detection', () => {
  const base = {
    id: 'q1',
    summary: `${QUESTION_PREFIX}Move "Essay" to Thursday?`,
    start: { dateTime: '2026-11-18T14:00:00Z' },
    end: { dateTime: '2026-11-18T15:00:00Z' },
    organizer: { email: 'tempo.organizer@gmail.com' },
    attendees: [{ email: 'me@gmail.com', self: true, responseStatus: 'tentative' }],
  };

  it('recognises the attendee copy via SHARED extended properties', () => {
    const ev = fromGoogleEvent(
      {
        ...base,
        extendedProperties: {
          shared: { [PROP.questionId]: 'Q-7', [PROP.taskId]: 'task-1', [PROP.taskListId]: 'list-1' },
        },
      },
      'me@gmail.com',
    )!;
    expect(ev.selfResponse).toBe('tentative');
    expect(ev.tempo).toEqual({
      kind: 'question',
      taskId: 'task-1',
      taskListId: 'list-1',
      questionId: 'Q-7',
      plannedStart: '2026-11-18T14:00:00.000Z',
      plannedEnd: '2026-11-18T15:00:00.000Z',
    });
  });

  it('falls back to the "Tempo asks: " title prefix when shared props are not visible', () => {
    expect(fromGoogleEvent(base, 'me@gmail.com')!.tempo?.kind).toBe('question');
    // organizer filter
    expect(parseTempoMeta(base, { organizerEmail: 'TEMPO.organizer@gmail.com' })?.kind).toBe('question');
    expect(parseTempoMeta(base, { organizerEmail: 'someone@else.com' })).toBeUndefined();
    // the user's own event with that title is not a question
    expect(parseTempoMeta({ ...base, organizer: { email: 'me@gmail.com', self: true } })).toBeUndefined();
    // unrelated title
    expect(parseTempoMeta({ ...base, summary: 'Team sync' })).toBeUndefined();
  });

  it('builds the invitation resource with shared + private props and guest restrictions', () => {
    const q: Question = {
      id: 'Q-7',
      kind: 'missed-due',
      title: `${QUESTION_PREFIX}Finish "Essay" 1 day late?`,
      description: `Essay cannot fit before Friday.\n${RSVP_HELP}`,
      slot: { start: new Date('2026-11-18T14:00:00Z'), end: new Date('2026-11-18T15:00:00Z') },
      taskId: 'task-1',
      taskListId: 'list-1',
      proposal: [],
      alternatives: [],
      replacedBlocks: [],
      replacedEventIds: [],
      createdAt: new Date('2026-11-16T10:00:00Z'),
      answerBy: new Date('2026-11-18T13:00:00Z'),
      status: 'open',
    };
    const r = toInviteEvent(q, 'me@gmail.com');
    expect(r.summary).toBe(q.title);
    expect(r.description).toBe(q.description);
    expect(r.attendees).toEqual([{ email: 'me@gmail.com' }]);
    expect(r).toMatchObject({ guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false });
    expect(r.reminders).toEqual({ useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
    expect(r.extendedProperties?.shared).toEqual({
      [PROP.questionId]: 'Q-7',
      [PROP.taskId]: 'task-1',
      [PROP.taskListId]: 'list-1',
    });
    expect(r.extendedProperties?.private).toMatchObject({ [PROP.kind]: 'question', [PROP.questionId]: 'Q-7' });
    // The organizer copy maps back to a question as well
    const orgCopy = fromGoogleEvent({ ...r, id: 'inv1' }, 'primary')!;
    expect(orgCopy.tempo).toMatchObject({ kind: 'question', questionId: 'Q-7', taskId: 'task-1' });
  });
});

describe('block descriptions', () => {
  it('renders reason, learned lines and the footer', () => {
    const text = renderBlockDescription({
      reason: 'Moved because  "Project meeting" ran late',
      learned: ['Tempo learned: you prefer mornings', 'Reading takes ~40 min'],
    });
    expect(text.split('\n')).toEqual([
      'Moved because "Project meeting" ran late',
      'Tempo learned: you prefer mornings',
      'Tempo learned: Reading takes ~40 min',
      '',
      DESCRIPTION_FOOTER,
    ]);
  });

  it('renders only the footer without reason/learned', () => {
    expect(renderBlockDescription({})).toBe(DESCRIPTION_FOOTER);
    expect(parseBlockDescription(DESCRIPTION_FOOTER)).toEqual({ learned: [] });
  });

  it('parses descriptions tolerant to edits', () => {
    expect(parseBlockDescription(undefined)).toEqual({ learned: [] });
    expect(parseBlockDescription('\nfirst\nsecond\ntempo learned: x')).toEqual({ reason: 'first', learned: ['x'] });
  });
});

describe('calendar list mapping', () => {
  it('flags the Tempo calendar by its description marker', () => {
    const info = fromCalendarListEntry({
      id: 'abc@group.calendar.google.com',
      summary: 'Tempo',
      description: `Blocks ${TEMPO_CALENDAR_MARKER}`,
      accessRole: 'owner',
      timeZone: 'Europe/Berlin',
    })!;
    expect(info).toEqual({
      id: 'abc@group.calendar.google.com',
      summary: 'Tempo',
      primary: false,
      accessRole: 'owner',
      isTempo: true,
      timeZone: 'Europe/Berlin',
      visible: false,
    });
    expect(fromCalendarListEntry({ id: 'x', selected: true })!.visible).toBe(true);
    expect(fromCalendarListEntry({ id: 'x', selected: true, hidden: true })!.visible).toBe(false);
    const primary = fromCalendarListEntry({ id: 'me@gmail.com', summary: 'me', summaryOverride: 'Me', primary: true })!;
    expect(primary).toMatchObject({ summary: 'Me', primary: true, isTempo: false, accessRole: 'reader' });
  });
});

describe('task mapping', () => {
  it('maps fields incl. parent, position, completion and drops deleted tasks', () => {
    const t = fromGoogleTask(
      {
        id: 't1',
        title: 'Read chapter 3',
        notes: 'pp. 40-80',
        status: 'completed',
        completed: '2026-11-15T18:00:00.000Z',
        parent: 'p1',
        position: '00000000000000000001',
        updated: '2026-11-15T18:00:01.000Z',
        due: '2026-11-20T00:00:00.000Z',
      },
      'list-1',
      'Europe/Berlin',
    )!;
    expect(t).toEqual({
      id: 't1',
      listId: 'list-1',
      title: 'Read chapter 3',
      notes: 'pp. 40-80',
      status: 'completed',
      completedAt: new Date('2026-11-15T18:00:00.000Z'),
      parentId: 'p1',
      position: '00000000000000000001',
      updated: new Date('2026-11-15T18:00:01.000Z'),
      due: new Date('2026-11-20T23:00:00.000Z'),
    });
    expect(fromGoogleTask({ id: 'd', deleted: true }, 'l', 'UTC')).toBeNull();
    const open = fromGoogleTask({ id: 'o', status: 'needsAction' }, 'l', 'UTC')!;
    expect(open).toMatchObject({ status: 'needsAction', title: '', position: '' });
    expect(open.due).toBeUndefined();
    expect(open.parentId).toBeUndefined();
  });

  it.each([
    // zone, due date, expected exclusive deadline (next local midnight) in UTC
    ['Europe/Berlin', '2026-11-20T00:00:00.000Z', '2026-11-20T23:00:00.000Z'],
    ['America/Los_Angeles', '2026-11-20T00:00:00.000Z', '2026-11-21T08:00:00.000Z'],
    ['UTC', '2026-11-20T00:00:00.000Z', '2026-11-21T00:00:00.000Z'],
    // Berlin spring forward (29 Mar 2026 02:00 → 03:00)
    ['Europe/Berlin', '2026-03-28T00:00:00.000Z', '2026-03-28T23:00:00.000Z'],
    ['Europe/Berlin', '2026-03-29T00:00:00.000Z', '2026-03-29T22:00:00.000Z'],
    // Berlin fall back (25 Oct 2026)
    ['Europe/Berlin', '2026-10-24T00:00:00.000Z', '2026-10-24T22:00:00.000Z'],
    ['Europe/Berlin', '2026-10-25T00:00:00.000Z', '2026-10-25T23:00:00.000Z'],
    // Los Angeles spring forward (8 Mar 2026) and fall back (1 Nov 2026)
    ['America/Los_Angeles', '2026-03-07T00:00:00.000Z', '2026-03-08T08:00:00.000Z'],
    ['America/Los_Angeles', '2026-03-08T00:00:00.000Z', '2026-03-09T07:00:00.000Z'],
    ['America/Los_Angeles', '2026-11-01T00:00:00.000Z', '2026-11-02T08:00:00.000Z'],
  ])('normalises due in %s: %s → %s', (zone, due, expected) => {
    expect(dueDateToDeadline(due, zone)?.toISOString()).toBe(expected);
  });

  it('ignores the time part of due and invalid zones fall back to UTC', () => {
    expect(dueDateToDeadline('2026-11-20T13:45:00.000Z', 'Europe/Berlin')?.toISOString()).toBe(
      '2026-11-20T23:00:00.000Z',
    );
    expect(dueDateToDeadline('2026-11-20', 'Not/AZone')?.toISOString()).toBe('2026-11-21T00:00:00.000Z');
    expect(dueDateToDeadline('garbage', 'UTC')).toBeUndefined();
  });
});
