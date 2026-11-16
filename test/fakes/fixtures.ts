/**
 * Fixture builders for core tests. All wall-clock strings are local times in
 * Europe/Berlin ("2026-11-16T10:00"). The default week is Mon 16 – Fri 20 Nov 2026.
 */
import { DateTime } from 'luxon';
import {
  emptyLearned,
  type CalendarEvent,
  type LearnedPreferences,
  type PlanInput,
  type Preferences,
  type Question,
  type Signal,
  type Task,
  type TaskEstimate,
} from '../../src/core/types.js';

export const TZ = 'Europe/Berlin';
export const TEMPO_CAL = 'tempo-cal';
export const PRIMARY_CAL = 'me@example.com';
export const LIST = 'list-1';

/** Local wall-clock time in Europe/Berlin → instant. */
export function at(local: string): Date {
  const dt = DateTime.fromISO(local, { zone: TZ });
  if (!dt.isValid) throw new Error(`bad local time ${local}`);
  return dt.toJSDate();
}

/** Instant → "2026-11-16T10:00" local. */
export function local(d: Date): string {
  return DateTime.fromJSDate(d, { zone: TZ }).toFormat("yyyy-LL-dd'T'HH:mm");
}

/** End of the local due day (= next local midnight), as Google Tasks adapters normalise it. */
export function dueEndOf(day: string): Date {
  return DateTime.fromISO(day, { zone: TZ }).startOf('day').plus({ days: 1 }).toJSDate();
}

export function prefs(overrides: Partial<Preferences> = {}, learned: Partial<LearnedPreferences> = {}): Preferences {
  return {
    timezone: TZ,
    workingHours: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] },
    focusTime: { start: '09:00', end: '12:00' },
    sleep: { start: '23:00', end: '07:00' },
    selectedCalendarIds: [PRIMARY_CAL],
    bufferMin: 0,
    ...overrides,
    learned: { ...emptyLearned(), ...learned },
  };
}

export interface TaskSpec {
  id: string;
  title?: string;
  /** Local due day "2026-11-20". */
  due?: string;
  status?: Task['status'];
  parentId?: string;
  position?: string;
  notes?: string;
  updated?: Date;
}

export function task(spec: TaskSpec): Task {
  return {
    id: spec.id,
    listId: LIST,
    title: spec.title ?? spec.id,
    ...(spec.notes !== undefined ? { notes: spec.notes } : {}),
    ...(spec.due ? { due: dueEndOf(spec.due) } : {}),
    status: spec.status ?? 'needsAction',
    ...(spec.status === 'completed' ? { completedAt: at('2026-11-16T08:00') } : {}),
    ...(spec.parentId ? { parentId: spec.parentId } : {}),
    position: spec.position ?? '00000000000000000000',
    updated: spec.updated ?? at('2026-11-01T08:00'),
  };
}

export interface EventSpec {
  id: string;
  title?: string;
  start: string;
  end: string;
  transparency?: CalendarEvent['transparency'];
  status?: CalendarEvent['status'];
  selfResponse?: CalendarEvent['selfResponse'];
  allDay?: boolean;
  calendarId?: string;
}

/** A fixed (non-Tempo) event. */
export function event(spec: EventSpec): CalendarEvent {
  return {
    id: spec.id,
    calendarId: spec.calendarId ?? PRIMARY_CAL,
    title: spec.title ?? spec.id,
    start: at(spec.start),
    end: at(spec.end),
    allDay: spec.allDay ?? false,
    transparency: spec.transparency ?? 'opaque',
    status: spec.status ?? 'confirmed',
    ...(spec.selfResponse ? { selfResponse: spec.selfResponse } : {}),
    updated: at('2026-11-01T08:00'),
  };
}

export interface BlockSpec {
  id: string;
  taskId: string;
  title?: string;
  start: string;
  end: string;
  /** What Tempo last wrote (defaults to start/end = not moved by the user). */
  plannedStart?: string;
  plannedEnd?: string;
  part?: number;
}

/** A Tempo block in the Tempo calendar. */
export function block(spec: BlockSpec): CalendarEvent {
  return {
    id: spec.id,
    calendarId: TEMPO_CAL,
    title: spec.title ?? spec.taskId,
    start: at(spec.start),
    end: at(spec.end),
    allDay: false,
    transparency: 'opaque',
    status: 'confirmed',
    updated: at('2026-11-01T08:00'),
    tempo: {
      kind: 'block',
      taskId: spec.taskId,
      taskListId: LIST,
      plannedStart: at(spec.plannedStart ?? spec.start).toISOString(),
      plannedEnd: at(spec.plannedEnd ?? spec.end).toISOString(),
      ...(spec.part !== undefined ? { part: spec.part } : {}),
    },
  };
}

/** A cached estimate (estimatedAt in the past, so it is reused). */
export function estimate(
  taskId: string,
  e: Partial<Omit<TaskEstimate, 'taskId'>> = {},
): TaskEstimate & { estimatedAt: string } {
  return {
    taskId,
    durationMin: 60,
    priority: 3,
    urgency: 2,
    confidence: 0.9,
    minChunkMin: 30,
    deepWork: false,
    ...e,
    estimatedAt: at('2026-11-10T08:00').toISOString(),
  };
}

export interface InputSpec {
  now: string;
  events?: CalendarEvent[];
  tasks?: Task[];
  prefs?: Preferences;
  signals?: Signal[];
  estimates?: PlanInput['estimates'];
  openQuestion?: Question;
  queuedQuestions?: Question[];
  horizonDays?: number;
}

export function planInput(spec: InputSpec): PlanInput {
  return {
    now: at(spec.now),
    events: spec.events ?? [],
    tasks: spec.tasks ?? [],
    prefs: spec.prefs ?? prefs(),
    signals: spec.signals ?? [{ type: 'periodic' }],
    estimates: spec.estimates ?? {},
    ...(spec.openQuestion ? { openQuestion: spec.openQuestion } : {}),
    queuedQuestions: spec.queuedQuestions ?? [],
    horizonDays: spec.horizonDays ?? 14,
  };
}
