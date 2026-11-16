/**
 * Narrow, structural views of the googleapis clients Tempo actually uses.
 *
 * The real `calendar_v3.Calendar` / `tasks_v1.Tasks` objects satisfy these
 * interfaces (checked at compile time in the factories below), while tests can
 * pass small hand-written fakes without network access.
 *
 * We deep-import the per-API modules instead of the `googleapis` root: the root
 * module loads ~400 APIs and takes seconds to import; the per-API modules load
 * in ~100 ms.
 */
import type { OAuth2Client } from 'google-auth-library';
import { calendar, calendar_v3 } from 'googleapis/build/src/apis/calendar/index.js';
import { tasks, tasks_v1 } from 'googleapis/build/src/apis/tasks/index.js';

export { calendar_v3, tasks_v1 };

type Res<T> = Promise<{ data: T }>;

export interface CalendarApi {
  events: {
    list(params: calendar_v3.Params$Resource$Events$List): Res<calendar_v3.Schema$Events>;
    get(params: calendar_v3.Params$Resource$Events$Get): Res<calendar_v3.Schema$Event>;
    insert(params: calendar_v3.Params$Resource$Events$Insert): Res<calendar_v3.Schema$Event>;
    patch(params: calendar_v3.Params$Resource$Events$Patch): Res<calendar_v3.Schema$Event>;
    delete(params: calendar_v3.Params$Resource$Events$Delete): Promise<unknown>;
    watch(params: calendar_v3.Params$Resource$Events$Watch): Res<calendar_v3.Schema$Channel>;
  };
  calendarList: {
    list(params: calendar_v3.Params$Resource$Calendarlist$List): Res<calendar_v3.Schema$CalendarList>;
    insert(params: calendar_v3.Params$Resource$Calendarlist$Insert): Res<calendar_v3.Schema$CalendarListEntry>;
    patch(params: calendar_v3.Params$Resource$Calendarlist$Patch): Res<calendar_v3.Schema$CalendarListEntry>;
  };
  calendars: {
    get(params: calendar_v3.Params$Resource$Calendars$Get): Res<calendar_v3.Schema$Calendar>;
    insert(params: calendar_v3.Params$Resource$Calendars$Insert): Res<calendar_v3.Schema$Calendar>;
  };
  channels: {
    stop(params: calendar_v3.Params$Resource$Channels$Stop): Promise<unknown>;
  };
  settings?: {
    get(params: calendar_v3.Params$Resource$Settings$Get): Res<calendar_v3.Schema$Setting>;
  };
}

export interface TasksApi {
  tasklists: {
    list(params: tasks_v1.Params$Resource$Tasklists$List): Res<tasks_v1.Schema$TaskLists>;
  };
  tasks: {
    list(params: tasks_v1.Params$Resource$Tasks$List): Res<tasks_v1.Schema$Tasks>;
  };
}

export function createCalendarApi(auth: OAuth2Client): CalendarApi {
  const api: calendar_v3.Calendar = calendar({ version: 'v3', auth });
  return api;
}

export function createTasksApi(auth: OAuth2Client): TasksApi {
  const api: tasks_v1.Tasks = tasks({ version: 'v1', auth });
  return api;
}
