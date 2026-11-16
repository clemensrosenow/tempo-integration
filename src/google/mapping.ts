/**
 * Pure mapping between Google API resources and the Tempo domain model.
 * No I/O here — everything is unit-tested in test/google/mapping.test.ts.
 */
import { DateTime } from 'luxon';
import {
  QUESTION_PREFIX,
  type BlockDraft,
  type CalendarEvent,
  type CalendarInfo,
  type Question,
  type ResponseStatus,
  type Task,
  type TempoBlockMeta,
} from '../core/types.js';
import type { calendar_v3, tasks_v1 } from './api.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Keys in `extendedProperties.private` / `.shared` (max 44 chars each). */
export const PROP = {
  tempo: 'tempo',
  kind: 'tempoKind',
  taskId: 'tempoTaskId',
  taskListId: 'tempoTaskListId',
  plannedStart: 'tempoPlannedStart',
  plannedEnd: 'tempoPlannedEnd',
  questionId: 'tempoQuestionId',
  part: 'tempoPart',
} as const;

/** Value of the `tempo` private property on every Tempo-written event. */
export const TEMPO_MARKER_VALUE = '1';

export const TEMPO_CALENDAR_SUMMARY = 'Tempo';
/** Machine marker inside the Tempo calendar's description (calendars have no extended properties). */
export const TEMPO_CALENDAR_MARKER = '[tempo-calendar]';
export const TEMPO_CALENDAR_DESCRIPTION =
  'Time blocks planned by Tempo from your Google Tasks. Drag or resize a block to correct Tempo; ' +
  'check off the Google Task when you are done. Untick this calendar to hide the blocks. ' +
  TEMPO_CALENDAR_MARKER;
/** Distinctive calendar colour (deep purple) set via calendarList.patch with colorRgbFormat. */
export const TEMPO_CALENDAR_COLOR = { backgroundColor: '#7c4dff', foregroundColor: '#ffffff' } as const;

export const LEARNED_PREFIX = 'Tempo learned: ';
export const DESCRIPTION_FOOTER =
  '— Planned by Tempo · drag or resize to correct me · check off the Google Task when done';

const RESPONSE_STATUSES: readonly ResponseStatus[] = ['needsAction', 'declined', 'tentative', 'accepted'];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isValidZone(zone: string | undefined | null): zone is string {
  return !!zone && DateTime.local().setZone(zone).isValid;
}

function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function toResponseStatus(value: string | null | undefined): ResponseStatus | undefined {
  return RESPONSE_STATUSES.find((s) => s === value);
}

/**
 * Google `EventDateTime` → instant. All-day `date` values are interpreted as
 * local midnight in `timeZone` (the event's, else the calendar's, else UTC).
 */
export function eventDateTimeToDate(
  dt: calendar_v3.Schema$EventDateTime | undefined,
  fallbackZone?: string,
): { date: Date; allDay: boolean } | undefined {
  if (!dt) return undefined;
  if (dt.dateTime) {
    const d = parseDate(dt.dateTime);
    return d ? { date: d, allDay: false } : undefined;
  }
  if (dt.date) {
    const zone = isValidZone(dt.timeZone) ? dt.timeZone : isValidZone(fallbackZone) ? fallbackZone : 'UTC';
    const local = DateTime.fromISO(dt.date, { zone });
    return local.isValid ? { date: local.toJSDate(), allDay: true } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tempo metadata (extended properties)
// ---------------------------------------------------------------------------

/** Serialise TempoBlockMeta into `extendedProperties.private`. */
export function tempoPrivateProperties(meta: TempoBlockMeta): Record<string, string> {
  const props: Record<string, string> = {
    [PROP.tempo]: TEMPO_MARKER_VALUE,
    [PROP.kind]: meta.kind,
    [PROP.taskId]: meta.taskId,
    [PROP.taskListId]: meta.taskListId,
    [PROP.plannedStart]: meta.plannedStart,
    [PROP.plannedEnd]: meta.plannedEnd,
  };
  if (meta.questionId !== undefined) props[PROP.questionId] = meta.questionId;
  if (meta.part !== undefined) props[PROP.part] = String(meta.part);
  return props;
}

/** Properties placed in `extendedProperties.shared` of invitations (visible on the attendee copy). */
export function questionSharedProperties(q: Pick<Question, 'id' | 'taskId' | 'taskListId'>): Record<string, string> {
  return {
    [PROP.questionId]: q.id,
    [PROP.taskId]: q.taskId,
    [PROP.taskListId]: q.taskListId,
  };
}

export interface ParseMetaOptions {
  /** Live start/end of the event, used when planned times are missing. */
  liveStart?: Date;
  liveEnd?: Date;
  /**
   * Email of the Tempo organizer account. If set, the title-prefix fallback
   * only matches invitations organised by this account.
   */
  organizerEmail?: string;
}

function parsePart(v: string | undefined): number | undefined {
  if (v === undefined || !/^\d+$/.test(v)) return undefined;
  return Number(v);
}

/**
 * Recognise Tempo events:
 * 1. `extendedProperties.private.tempo` → block (or question on the organizer copy);
 * 2. `extendedProperties.shared.tempoQuestionId` → attendee copy of a Tempo invitation;
 * 3. title starts with "Tempo asks: " and the user is not the organizer → question (fallback).
 */
export function parseTempoMeta(ev: calendar_v3.Schema$Event, opts: ParseMetaOptions = {}): TempoBlockMeta | undefined {
  const priv = ev.extendedProperties?.private ?? undefined;
  const shared = ev.extendedProperties?.shared ?? undefined;
  const liveStartIso = opts.liveStart?.toISOString() ?? '';
  const liveEndIso = opts.liveEnd?.toISOString() ?? '';

  if (priv && priv[PROP.tempo] !== undefined) {
    const kind = priv[PROP.kind] === 'question' ? 'question' : 'block';
    const meta: TempoBlockMeta = {
      kind,
      taskId: priv[PROP.taskId] ?? shared?.[PROP.taskId] ?? '',
      taskListId: priv[PROP.taskListId] ?? shared?.[PROP.taskListId] ?? '',
      plannedStart: priv[PROP.plannedStart] ?? liveStartIso,
      plannedEnd: priv[PROP.plannedEnd] ?? liveEndIso,
    };
    const questionId = priv[PROP.questionId] ?? shared?.[PROP.questionId];
    if (questionId !== undefined) meta.questionId = questionId;
    const part = parsePart(priv[PROP.part]);
    if (part !== undefined) meta.part = part;
    return meta;
  }

  if (shared && shared[PROP.questionId] !== undefined) {
    return {
      kind: 'question',
      taskId: shared[PROP.taskId] ?? '',
      taskListId: shared[PROP.taskListId] ?? '',
      plannedStart: liveStartIso,
      plannedEnd: liveEndIso,
      questionId: shared[PROP.questionId],
    };
  }

  if (isQuestionTitle(ev.summary) && ev.organizer?.self !== true) {
    const org = ev.organizer?.email?.toLowerCase();
    if (opts.organizerEmail === undefined || org === opts.organizerEmail.toLowerCase()) {
      return { kind: 'question', taskId: '', taskListId: '', plannedStart: liveStartIso, plannedEnd: liveEndIso };
    }
  }
  return undefined;
}

export function isQuestionTitle(title: string | null | undefined): boolean {
  return typeof title === 'string' && title.startsWith(QUESTION_PREFIX);
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface FromEventOptions {
  /** Calendar time zone (events.list returns it as `timeZone`), for all-day events. */
  timeZone?: string;
  organizerEmail?: string;
}

/**
 * Google event → CalendarEvent. Returns `null` for events without usable times
 * — except cancelled events (deleted entries in incremental sync carry only
 * id + status); those get `start = end = epoch 0` so the engine still sees the deletion.
 */
export function fromGoogleEvent(
  ev: calendar_v3.Schema$Event,
  calendarId: string,
  opts: FromEventOptions = {},
): CalendarEvent | null {
  if (!ev.id) return null;
  const status: CalendarEvent['status'] =
    ev.status === 'cancelled' ? 'cancelled' : ev.status === 'tentative' ? 'tentative' : 'confirmed';
  const start = eventDateTimeToDate(ev.start, opts.timeZone);
  const end = eventDateTimeToDate(ev.end, opts.timeZone);
  if ((!start || !end) && status !== 'cancelled') return null;

  const startDate = start?.date ?? new Date(0);
  const endDate = end?.date ?? startDate;
  const out: CalendarEvent = {
    id: ev.id,
    calendarId,
    title: ev.summary ?? '',
    start: startDate,
    end: endDate,
    allDay: start?.allDay ?? false,
    transparency: ev.transparency === 'transparent' ? 'transparent' : 'opaque',
    status,
    updated: parseDate(ev.updated) ?? new Date(0),
  };
  if (ev.description) out.description = ev.description;
  if (ev.location) out.location = ev.location;
  const self = ev.attendees?.find((a) => a.self === true);
  const selfResponse = toResponseStatus(self?.responseStatus);
  if (selfResponse) out.selfResponse = selfResponse;
  const meta = parseTempoMeta(ev, {
    liveStart: startDate,
    liveEnd: endDate,
    ...(opts.organizerEmail !== undefined ? { organizerEmail: opts.organizerEmail } : {}),
  });
  if (meta) out.tempo = meta;
  return out;
}

/** BlockDraft → event resource for `events.insert` into the Tempo calendar. */
export function toGoogleEvent(block: BlockDraft, opts: { timeZone?: string } = {}): calendar_v3.Schema$Event {
  const meta: TempoBlockMeta = {
    kind: 'block',
    taskId: block.taskId,
    taskListId: block.taskListId,
    plannedStart: block.start.toISOString(),
    plannedEnd: block.end.toISOString(),
  };
  if (block.part !== undefined) meta.part = block.part;
  return {
    summary: block.title,
    description: renderBlockDescription({ reason: block.reason, learned: block.learned }),
    start: eventTime(block.start, opts.timeZone),
    end: eventTime(block.end, opts.timeZone),
    transparency: 'opaque',
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: tempoPrivateProperties(meta) },
  };
}

export function eventTime(d: Date, timeZone?: string): calendar_v3.Schema$EventDateTime {
  const out: calendar_v3.Schema$EventDateTime = { dateTime: d.toISOString() };
  if (isValidZone(timeZone)) out.timeZone = timeZone;
  return out;
}

/** Question → invitation resource (organizer account, user as the only attendee). */
export function toInviteEvent(
  question: Question,
  attendeeEmail: string,
  opts: { timeZone?: string; reminderMinutes?: number } = {},
): calendar_v3.Schema$Event {
  const meta: TempoBlockMeta = {
    kind: 'question',
    taskId: question.taskId,
    taskListId: question.taskListId,
    plannedStart: question.slot.start.toISOString(),
    plannedEnd: question.slot.end.toISOString(),
    questionId: question.id,
  };
  return {
    summary: question.title,
    description: question.description,
    start: eventTime(question.slot.start, opts.timeZone),
    end: eventTime(question.slot.end, opts.timeZone),
    attendees: [{ email: attendeeEmail }],
    guestsCanModify: false,
    guestsCanInviteOthers: false,
    guestsCanSeeOtherGuests: false,
    transparency: 'opaque',
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: opts.reminderMinutes ?? 10 }] },
    extendedProperties: {
      shared: questionSharedProperties(question),
      private: tempoPrivateProperties(meta),
    },
  };
}

// ---------------------------------------------------------------------------
// Block descriptions (E11 reason + E12 learned lines)
// ---------------------------------------------------------------------------

export interface BlockDescription {
  reason?: string | undefined;
  learned?: string[] | undefined;
}

function stripLearnedPrefix(line: string): string {
  const t = line.trim();
  return t.toLowerCase().startsWith(LEARNED_PREFIX.toLowerCase()) ? t.slice(LEARNED_PREFIX.length).trim() : t;
}

/**
 * Line 1 = reason, then one "Tempo learned: …" line per entry, then a blank
 * line and the footer.
 */
export function renderBlockDescription(d: BlockDescription): string {
  const lines: string[] = [];
  const reason = d.reason?.replace(/\s+/g, ' ').trim();
  if (reason) lines.push(reason);
  for (const entry of d.learned ?? []) {
    const text = stripLearnedPrefix(entry.replace(/\s+/g, ' '));
    if (text) lines.push(LEARNED_PREFIX + text);
  }
  if (lines.length > 0) lines.push('');
  lines.push(DESCRIPTION_FOOTER);
  return lines.join('\n');
}

/** Inverse of renderBlockDescription (tolerant to user edits). */
export function parseBlockDescription(description: string | null | undefined): { reason?: string; learned: string[] } {
  const out: { reason?: string; learned: string[] } = { learned: [] };
  if (!description) return out;
  for (const raw of description.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(DESCRIPTION_FOOTER.slice(0, 18))) break; // "— Planned by Tempo"
    if (line.toLowerCase().startsWith(LEARNED_PREFIX.toLowerCase())) {
      const text = stripLearnedPrefix(line);
      if (text) out.learned.push(text);
    } else if (out.reason === undefined) {
      out.reason = line;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Calendars
// ---------------------------------------------------------------------------

/** The calendar list entry is Tempo's own calendar (marker in description). */
export function isTempoCalendarEntry(entry: calendar_v3.Schema$CalendarListEntry): boolean {
  return typeof entry.description === 'string' && entry.description.includes(TEMPO_CALENDAR_MARKER);
}

export function fromCalendarListEntry(entry: calendar_v3.Schema$CalendarListEntry): CalendarInfo | null {
  if (!entry.id) return null;
  const info: CalendarInfo = {
    id: entry.id,
    summary: entry.summaryOverride ?? entry.summary ?? entry.id,
    primary: entry.primary === true,
    accessRole: entry.accessRole ?? 'reader',
    isTempo: isTempoCalendarEntry(entry),
  };
  if (entry.timeZone) info.timeZone = entry.timeZone;
  info.visible = entry.selected === true && entry.hidden !== true;
  return info;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Google Tasks `due` keeps only the date (RFC 3339 with the time discarded,
 * e.g. "2026-11-20T00:00:00.000Z"). Tempo treats it as an exclusive deadline at
 * the END of that local calendar date = next local midnight in `timeZone`.
 */
export function dueDateToDeadline(due: string, timeZone: string): Date | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(due);
  if (!m?.[1]) return undefined;
  const zone = isValidZone(timeZone) ? timeZone : 'UTC';
  const day = DateTime.fromISO(m[1], { zone });
  if (!day.isValid) return undefined;
  return day.plus({ days: 1 }).startOf('day').toJSDate();
}

/** Google Task → Task. Returns `null` for deleted tasks or tasks without an id. */
export function fromGoogleTask(t: tasks_v1.Schema$Task, listId: string, timeZone: string): Task | null {
  if (!t.id || t.deleted === true) return null;
  const task: Task = {
    id: t.id,
    listId,
    title: t.title ?? '',
    status: t.status === 'completed' ? 'completed' : 'needsAction',
    position: t.position ?? '',
    updated: parseDate(t.updated) ?? new Date(0),
  };
  if (t.notes) task.notes = t.notes;
  const due = t.due ? dueDateToDeadline(t.due, timeZone) : undefined;
  if (due) task.due = due;
  const completedAt = parseDate(t.completed);
  if (completedAt) task.completedAt = completedAt;
  if (t.parent) task.parentId = t.parent;
  return task;
}
