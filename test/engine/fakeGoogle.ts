/**
 * In-memory stand-in for the Google adapters (Calendar user account, Tasks,
 * invitations from the organizer account) used by end-to-end engine tests.
 * Behaves like the real adapters at the port level: blocks get Tempo meta with
 * plannedStart/End, events carry `updated` stamps, invitation copies appear in
 * the user's primary calendar as kind 'question'.
 */
import type { CalendarPort, InvitePort, StateStore, TasksPort, TempoState } from '../../src/core/ports.js';
import type {
  BlockDraft,
  CalendarEvent,
  CalendarInfo,
  Question,
  ResponseStatus,
  Task,
  TimeRange,
} from '../../src/core/types.js';

export class FakeClock {
  constructor(public now: Date) {}
  advanceMin(min: number): void {
    this.now = new Date(this.now.getTime() + min * 60_000);
  }
  set(iso: string): void {
    this.now = new Date(iso);
  }
  fn = (): Date => new Date(this.now);
}

export class FakeGoogle implements CalendarPort, TasksPort {
  readonly userEmail = 'student@example.com';
  readonly calendars: CalendarInfo[] = [
    { id: 'student@example.com', summary: 'Student', primary: true, accessRole: 'owner', isTempo: false, timeZone: 'Europe/Berlin' },
    { id: 'uni', summary: 'LMU lectures', primary: false, accessRole: 'reader', isTempo: false },
  ];
  events: CalendarEvent[] = [];
  tasks: Task[] = [];
  writes: Array<{ op: string; id: string }> = [];
  private seq = 0;

  constructor(private readonly clock: FakeClock) {}

  // --- helpers for test scripts (simulate the user) -------------------------
  addFixed(e: Partial<Omit<CalendarEvent, 'start' | 'end'>> & { title: string; start: string; end: string }): CalendarEvent {
    const ev: CalendarEvent = {
      id: `fixed-${++this.seq}`,
      calendarId: e.calendarId ?? 'student@example.com',
      transparency: 'opaque',
      status: 'confirmed',
      allDay: false,
      ...e,
      start: new Date(e.start),
      end: new Date(e.end),
      updated: this.clock.fn(),
    } as CalendarEvent;
    this.events.push(ev);
    return ev;
  }
  userEditEvent(id: string, patch: Partial<Pick<CalendarEvent, 'start' | 'end' | 'transparency' | 'selfResponse'>>): void {
    const ev = this.events.find((e) => e.id === id);
    if (!ev) throw new Error(`no event ${id}`);
    Object.assign(ev, patch, { updated: this.clock.fn() });
  }
  addTask(t: Partial<Task> & { title: string }): Task {
    const task: Task = {
      id: `task-${++this.seq}`,
      listId: 'list-1',
      status: 'needsAction',
      position: String(this.seq).padStart(8, '0'),
      ...t,
      updated: this.clock.fn(),
    };
    this.tasks.push(task);
    return task;
  }
  completeTask(id: string): void {
    const t = this.tasks.find((x) => x.id === id)!;
    t.status = 'completed';
    t.completedAt = this.clock.fn();
    t.updated = this.clock.fn();
  }
  tempoBlocks(): CalendarEvent[] {
    return this.events.filter((e) => e.calendarId === 'tempo' && e.tempo?.kind === 'block').sort((a, b) => +a.start - +b.start);
  }
  fixedEvents(): CalendarEvent[] {
    return this.events.filter((e) => !e.tempo);
  }

  // --- CalendarPort -----------------------------------------------------------
  async getUserEmail(): Promise<string> {
    return this.userEmail;
  }
  async listCalendars(): Promise<CalendarInfo[]> {
    return this.calendars;
  }
  async ensureTempoCalendar(): Promise<string> {
    if (!this.calendars.some((c) => c.id === 'tempo')) {
      this.calendars.push({ id: 'tempo', summary: 'Tempo', primary: false, accessRole: 'owner', isTempo: true });
    }
    return 'tempo';
  }
  async listEvents(calendarIds: string[], range: TimeRange): Promise<CalendarEvent[]> {
    const ids = new Set(calendarIds);
    return this.events
      .filter((e) => ids.has(e.calendarId) && e.status !== 'cancelled' && e.end > range.start && e.start < range.end)
      .map((e) => ({ ...e, tempo: e.tempo ? { ...e.tempo } : undefined }));
  }
  async createBlock(calendarId: string, block: BlockDraft): Promise<CalendarEvent> {
    const ev: CalendarEvent = {
      id: `block-${++this.seq}`,
      calendarId,
      title: block.title,
      description: renderDescription(block.reason, block.learned),
      start: new Date(block.start),
      end: new Date(block.end),
      allDay: false,
      transparency: 'opaque',
      status: 'confirmed',
      updated: this.clock.fn(),
      tempo: {
        kind: 'block',
        taskId: block.taskId,
        taskListId: block.taskListId,
        plannedStart: new Date(block.start).toISOString(),
        plannedEnd: new Date(block.end).toISOString(),
        part: block.part,
      },
    };
    this.events.push(ev);
    this.writes.push({ op: 'create', id: ev.id });
    return { ...ev };
  }
  async updateBlock(
    calendarId: string,
    eventId: string,
    patch: { start?: Date; end?: Date; reason?: string; learned?: string[]; title?: string },
  ): Promise<CalendarEvent> {
    const ev = this.events.find((e) => e.id === eventId && e.calendarId === calendarId);
    if (!ev) throw Object.assign(new Error('Not Found'), { code: 404 });
    if (patch.start) ev.start = new Date(patch.start);
    if (patch.end) ev.end = new Date(patch.end);
    if (patch.title) ev.title = patch.title;
    if (patch.reason !== undefined || patch.learned) ev.description = renderDescription(patch.reason, patch.learned);
    ev.tempo = { ...ev.tempo!, plannedStart: ev.start.toISOString(), plannedEnd: ev.end.toISOString() };
    ev.updated = this.clock.fn();
    this.writes.push({ op: 'update', id: ev.id });
    return { ...ev };
  }
  async deleteBlock(calendarId: string, eventId: string): Promise<void> {
    const idx = this.events.findIndex((e) => e.id === eventId && e.calendarId === calendarId);
    if (idx < 0) throw Object.assign(new Error('Not Found'), { code: 404 });
    this.events.splice(idx, 1);
    this.writes.push({ op: 'delete', id: eventId });
  }

  /** Simulate the user dragging/resizing a Tempo block in Google Calendar. */
  userMoveBlock(eventId: string, start: Date, end: Date): void {
    const ev = this.events.find((e) => e.id === eventId)!;
    ev.start = start;
    ev.end = end;
    ev.updated = this.clock.fn();
  }

  // --- TasksPort --------------------------------------------------------------
  async listTasks(): Promise<Task[]> {
    return this.tasks.map((t) => ({ ...t }));
  }
}

/** Organizer account: invitations land in the user's primary calendar as kind 'question'. */
export class FakeInvites implements InvitePort {
  responses = new Map<string, ResponseStatus>();
  sent: Question[] = [];
  cancelled: string[] = [];
  annotated: Array<{ id: string; description: string }> = [];
  private seq = 0;
  constructor(private readonly google: FakeGoogle, private readonly clock: FakeClock) {}

  async sendQuestion(q: Question, attendeeEmail: string): Promise<string> {
    const id = `invite-${++this.seq}`;
    this.sent.push(q);
    this.responses.set(id, 'needsAction');
    this.google.events.push({
      id,
      calendarId: attendeeEmail,
      title: q.title,
      description: q.description,
      start: new Date(q.slot.start),
      end: new Date(q.slot.end),
      allDay: false,
      transparency: 'opaque',
      status: 'confirmed',
      selfResponse: 'needsAction',
      updated: this.clock.fn(),
      tempo: {
        kind: 'question',
        taskId: q.taskId,
        taskListId: q.taskListId,
        plannedStart: new Date(q.slot.start).toISOString(),
        plannedEnd: new Date(q.slot.end).toISOString(),
        questionId: q.id,
      },
    });
    return id;
  }
  /** Simulate the student answering in Google Calendar (Yes / No / Maybe). */
  answer(inviteId: string, r: ResponseStatus): void {
    this.responses.set(inviteId, r);
    const copy = this.google.events.find((e) => e.id === inviteId);
    if (copy) {
      copy.selfResponse = r;
      copy.updated = this.clock.fn();
    }
  }
  async getResponse(inviteEventId: string): Promise<ResponseStatus> {
    return this.responses.get(inviteEventId) ?? 'needsAction';
  }
  async annotate(inviteEventId: string, description: string): Promise<void> {
    this.annotated.push({ id: inviteEventId, description });
  }
  async cancel(inviteEventId: string): Promise<void> {
    this.cancelled.push(inviteEventId);
    this.google.events = this.google.events.filter((e) => e.id !== inviteEventId);
  }
}

export class InMemoryStore implements StateStore {
  state: TempoState = {
    version: 1,
    estimates: {},
    questions: [],
    handledEndedBlocks: [],
    syncTokens: {},
    channels: [],
  };
  async load(): Promise<TempoState> {
    return structuredClone(this.state);
  }
  async save(state: TempoState): Promise<void> {
    this.state = structuredClone(state);
  }
}

function renderDescription(reason?: string, learned?: string[]): string {
  return [reason ?? '', ...(learned ?? []).map((l) => (l.startsWith('Tempo learned') ? l : `Tempo learned: ${l}`))]
    .filter(Boolean)
    .join('\n');
}
