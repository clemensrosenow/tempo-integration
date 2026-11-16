import { vi } from 'vitest';
import type { CalendarApi, TasksApi } from '../../src/google/api.js';

/** Error shaped like a gaxios HTTP error. */
export function httpError(status: number, reason?: string): Error & { status: number; response: unknown } {
  const err = new Error(`HTTP ${status}${reason ? ` ${reason}` : ''}`) as Error & { status: number; response: unknown };
  err.status = status;
  err.response = { status, data: { error: { code: status, errors: reason ? [{ reason }] : [] } } };
  return err;
}

// Test-only: loose typing so each test can return just the fields it needs.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ApiFn = (params: any) => Promise<any>;

const notImplemented = (name: string) =>
  vi.fn<ApiFn>(async () => {
    throw new Error(`fake ${name} not implemented`);
  });

/** CalendarApi with every method a vi.fn; override what a test needs. */
export function fakeCalendarApi() {
  return {
    events: {
      list: notImplemented('events.list'),
      get: notImplemented('events.get'),
      insert: notImplemented('events.insert'),
      patch: notImplemented('events.patch'),
      delete: notImplemented('events.delete'),
      watch: notImplemented('events.watch'),
    },
    calendarList: {
      list: notImplemented('calendarList.list'),
      insert: notImplemented('calendarList.insert'),
      patch: notImplemented('calendarList.patch'),
    },
    calendars: {
      get: notImplemented('calendars.get'),
      insert: notImplemented('calendars.insert'),
    },
    channels: { stop: notImplemented('channels.stop') },
  };
}

export function fakeTasksApi() {
  return {
    tasklists: { list: notImplemented('tasklists.list') },
    tasks: { list: notImplemented('tasks.list') },
  };
}

export const asCalendarApi = (f: ReturnType<typeof fakeCalendarApi>): CalendarApi => f as unknown as CalendarApi;
export const asTasksApi = (f: ReturnType<typeof fakeTasksApi>): TasksApi => f as unknown as TasksApi;

export const noSleep = { retries: 3, sleep: async () => {} };
