/**
 * Stateful simulator of the Google Calendar v3 + Tasks v1 REST surface Tempo
 * uses, speaking raw Google JSON (Schema$Event, Schema$Task …). Lets the REAL
 * adapters (mapping, extendedProperties, attendee copies, RSVP) run against the
 * REAL engine without network. Two accounts: the student and the Tempo
 * organizer; inserting an event with attendees in the organizer calendar
 * creates the attendee copy in the student's primary calendar (same event id,
 * shared extendedProperties only — like Google).
 */
import type { CalendarApi, TasksApi, calendar_v3, tasks_v1 } from '../../src/google/api.js';

type Ev = calendar_v3.Schema$Event;
type Task = tasks_v1.Schema$Task;

function notFound(): Error {
  return Object.assign(new Error('Not Found'), { status: 404, code: 404, response: { status: 404, data: {} } });
}

function startMs(e: Ev): number {
  return new Date(e.start?.dateTime ?? `${e.start?.date}T00:00:00Z`).getTime();
}
function endMs(e: Ev): number {
  return new Date(e.end?.dateTime ?? `${e.end?.date}T00:00:00Z`).getTime();
}

export class GoogleSim {
  /** calendarId -> eventId -> event */
  readonly cals = new Map<string, { entry: calendar_v3.Schema$CalendarListEntry; owner: string; events: Map<string, Ev> }>();
  readonly tasklists = new Map<string, { list: tasks_v1.Schema$TaskList; tasks: Task[] }>();
  private seq = 0;

  constructor(
    readonly userEmail: string,
    readonly organizerEmail: string,
    private readonly now: () => Date,
  ) {
    this.addCalendar(userEmail, userEmail, { summary: userEmail, primary: true, accessRole: 'owner', timeZone: 'Europe/Berlin' });
    this.addCalendar(organizerEmail, organizerEmail, { summary: organizerEmail, primary: true, accessRole: 'owner', timeZone: 'Europe/Berlin' });
    this.tasklists.set('list-1', { list: { id: 'list-1', title: 'My Tasks' }, tasks: [] });
  }

  addCalendar(id: string, owner: string, entry: calendar_v3.Schema$CalendarListEntry): void {
    this.cals.set(id, { entry: { id, ...entry }, owner, events: new Map() });
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  // ---- user-side simulation helpers -------------------------------------------------
  addEvent(calendarId: string, ev: Ev): Ev {
    const full: Ev = { id: `ev${++this.seq}`, status: 'confirmed', updated: this.stamp(), ...ev };
    this.cals.get(calendarId)!.events.set(full.id!, full);
    return full;
  }
  editEvent(calendarId: string, id: string, patch: Ev): void {
    const ev = this.cals.get(calendarId)!.events.get(id);
    if (!ev) throw new Error(`no event ${id}`);
    Object.assign(ev, patch, { updated: this.stamp() });
  }
  /** Student RSVPs in their own calendar; Google syncs it to the organizer copy. */
  rsvp(eventId: string, responseStatus: 'accepted' | 'declined' | 'tentative'): void {
    for (const cal of [this.userEmail, this.organizerEmail]) {
      const ev = this.cals.get(cal)!.events.get(eventId);
      const me = ev?.attendees?.find((a) => a.email === this.userEmail);
      if (me && ev) {
        me.responseStatus = responseStatus;
        ev.updated = this.stamp();
      }
    }
  }
  addTask(t: Task): Task {
    const full: Task = { id: `t${++this.seq}`, status: 'needsAction', position: String(this.seq).padStart(20, '0'), updated: this.stamp(), ...t };
    this.tasklists.get('list-1')!.tasks.push(full);
    return full;
  }
  completeTask(id: string): void {
    const t = this.tasklists.get('list-1')!.tasks.find((x) => x.id === id)!;
    t.status = 'completed';
    t.completed = this.stamp();
    t.updated = this.stamp();
  }
  events(calendarId: string): Ev[] {
    return [...(this.cals.get(calendarId)?.events.values() ?? [])].filter((e) => e.status !== 'cancelled').sort((a, b) => startMs(a) - startMs(b));
  }
  tempoCalendarId(): string | undefined {
    return [...this.cals.values()].find((c) => c.entry.summary === 'Tempo')?.entry.id ?? undefined;
  }

  // ---- API surfaces -----------------------------------------------------------------
  /** Calendar API as seen by one account. */
  calendarApi(account: string): CalendarApi {
    const resolve = (id: string | undefined | null) => (id === 'primary' || !id ? account : id);
    const cal = (id: string | undefined | null) => {
      const c = this.cals.get(resolve(id));
      if (!c) throw notFound();
      return c;
    };
    const api = {
      events: {
        list: async (p: calendar_v3.Params$Resource$Events$List) => {
          const c = cal(p.calendarId);
          const min = p.timeMin ? new Date(p.timeMin).getTime() : -Infinity;
          const max = p.timeMax ? new Date(p.timeMax).getTime() : Infinity;
          const items = [...c.events.values()]
            .filter((e) => (p.showDeleted ? true : e.status !== 'cancelled'))
            .filter((e) => endMs(e) > min && startMs(e) < max)
            .sort((a, b) => startMs(a) - startMs(b))
            .map((e) => structuredClone(e));
          return { data: { items, timeZone: c.entry.timeZone, nextSyncToken: `sync-${this.seq}` } };
        },
        get: async (p: calendar_v3.Params$Resource$Events$Get) => {
          const ev = cal(p.calendarId).events.get(p.eventId!);
          if (!ev || ev.status === 'cancelled') throw notFound();
          return { data: structuredClone(ev) };
        },
        insert: async (p: calendar_v3.Params$Resource$Events$Insert) => {
          const c = cal(p.calendarId);
          const body = structuredClone(p.requestBody ?? {});
          if (body.id && c.events.has(body.id)) {
            throw Object.assign(new Error('Conflict'), { status: 409, code: 409, response: { status: 409, data: {} } });
          }
          const ev: Ev = {
            ...body,
            id: body.id ?? `ev${++this.seq}`,
            status: 'confirmed',
            updated: this.stamp(),
            organizer: { email: c.owner, self: true },
            attendees: body.attendees?.map((a) => ({ ...a, responseStatus: a.responseStatus ?? 'needsAction' })),
          };
          c.events.set(ev.id!, ev);
          // Google delivers the invitation into each attendee's primary calendar.
          for (const a of ev.attendees ?? []) {
            const target = this.cals.get(a.email!);
            if (!target) continue;
            const copy: Ev = {
              ...structuredClone(ev),
              organizer: { email: c.owner },
              attendees: ev.attendees?.map((x) => ({ ...x, self: x.email === a.email ? true : undefined })),
              extendedProperties: ev.extendedProperties?.shared ? { shared: { ...ev.extendedProperties.shared } } : undefined,
            };
            target.events.set(ev.id!, copy);
          }
          return { data: structuredClone(ev) };
        },
        patch: async (p: calendar_v3.Params$Resource$Events$Patch) => {
          const c = cal(p.calendarId);
          const ev = c.events.get(p.eventId!);
          if (!ev || ev.status === 'cancelled') throw notFound();
          const body = structuredClone(p.requestBody ?? {});
          const ext = body.extendedProperties;
          delete body.extendedProperties;
          Object.assign(ev, body, { updated: this.stamp() });
          if (ext) {
            ev.extendedProperties = {
              private: { ...(ev.extendedProperties?.private ?? {}), ...(ext.private ?? {}) },
              shared: { ...(ev.extendedProperties?.shared ?? {}), ...(ext.shared ?? {}) },
            };
          }
          // Organizer changes propagate to attendee copies.
          for (const a of ev.attendees ?? []) {
            const copy: Ev | undefined = this.cals.get(a.email!)?.events.get(ev.id!);
            if (copy && copy !== ev) Object.assign(copy, body, { updated: this.stamp() });
          }
          return { data: structuredClone(ev) };
        },
        delete: async (p: calendar_v3.Params$Resource$Events$Delete) => {
          const c = cal(p.calendarId);
          const ev = c.events.get(p.eventId!);
          if (!ev || ev.status === 'cancelled') throw Object.assign(notFound(), { status: 410, code: 410 });
          c.events.delete(p.eventId!);
          for (const a of ev.attendees ?? []) this.cals.get(a.email!)?.events.delete(ev.id!);
          return {};
        },
        watch: async () => {
          throw new Error('watch not simulated');
        },
      },
      calendarList: {
        list: async () => ({
          data: { items: [...this.cals.values()].filter((c) => c.owner === account || c.entry.accessRole !== 'owner' || c.entry.id === account).filter((c) => c.owner === account || this.shared.has(`${account}|${c.entry.id}`)).map((c) => ({ selected: true, ...c.entry, primary: c.entry.id === account ? true : undefined })) },
        }),
        insert: async (p: calendar_v3.Params$Resource$Calendarlist$Insert) => ({ data: { ...p.requestBody } }),
        patch: async (p: calendar_v3.Params$Resource$Calendarlist$Patch) => {
          const c = cal(p.calendarId);
          Object.assign(c.entry, p.requestBody);
          return { data: c.entry };
        },
      },
      calendars: {
        get: async (p: calendar_v3.Params$Resource$Calendars$Get) => {
          const c = cal(p.calendarId);
          return { data: { id: c.entry.id, summary: c.entry.summary, description: c.entry.description, timeZone: c.entry.timeZone } };
        },
        insert: async (p: calendar_v3.Params$Resource$Calendars$Insert) => {
          const id = `cal${++this.seq}@group.calendar.google.com`;
          this.addCalendar(id, account, { ...p.requestBody, accessRole: 'owner' } as calendar_v3.Schema$CalendarListEntry);
          return { data: { id, ...p.requestBody } };
        },
      },
      channels: { stop: async () => ({}) },
    };
    return api as unknown as CalendarApi;
  }

  /** Calendars other accounts shared with `account` (shows up in its calendarList). */
  readonly shared = new Set<string>();
  share(calendarId: string, withAccount: string): void {
    this.shared.add(`${withAccount}|${calendarId}`);
  }

  tasksApi(): TasksApi {
    const api = {
      tasklists: {
        list: async () => ({ data: { items: [...this.tasklists.values()].map((l) => l.list) } }),
      },
      tasks: {
        list: async (p: tasks_v1.Params$Resource$Tasks$List) => {
          const l = this.tasklists.get(p.tasklist!);
          if (!l) throw notFound();
          const completedMin = p.completedMin ? new Date(p.completedMin).getTime() : -Infinity;
          const items = l.tasks
            .filter((t) => !t.deleted)
            .filter((t) => (p.showCompleted === false ? t.status !== 'completed' : true))
            .filter((t) => (t.status === 'completed' ? new Date(t.completed!).getTime() >= completedMin : !p.completedMin))
            .map((t) => structuredClone(t));
          return { data: { items } };
        },
      },
    };
    return api as unknown as TasksApi;
  }
}
