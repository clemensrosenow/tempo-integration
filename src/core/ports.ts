/**
 * Ports (interfaces) between the Tempo core and the outside world.
 * Google adapters implement CalendarPort / TasksPort / InvitePort,
 * LLM adapters implement LlmPort, storage implements StateStore.
 * Tests use in-memory fakes of all of them.
 */
import type {
  BlockDraft,
  CalendarEvent,
  CalendarInfo,
  LearnedPreferences,
  Preferences,
  Question,
  ResponseStatus,
  Task,
  TaskEstimate,
  TimeRange,
} from './types.js';

// ---------------------------------------------------------------------------
// Google Calendar (user account)
// ---------------------------------------------------------------------------

export interface EventsDelta {
  /** Changed or new events (cancelled ones have status 'cancelled'). */
  events: CalendarEvent[];
  /** True if the sync token was invalid and a full resync happened (events = full set). */
  fullResync: boolean;
}

export interface CalendarPort {
  /** Email of the connected user (primary calendar id). */
  getUserEmail(): Promise<string>;
  /**
   * Whether invitations from senders the user doesn't know (like the Tempo
   * organizer) appear in their calendar. 'hidden-unknown' means Tempo's
   * questions stay invisible until the user changes the setting or adds the
   * organizer to their contacts. Optional; 'unknown' if it cannot be read.
   */
  invitationVisibility?(): Promise<'all' | 'hidden-unknown' | 'hidden' | 'unknown'>;
  listCalendars(): Promise<CalendarInfo[]>;
  /** Find the "Tempo" secondary calendar or create it (E2). Returns its id. */
  ensureTempoCalendar(timeZone: string): Promise<string>;
  /** Expanded single events (recurring instances expanded) overlapping `range`. */
  listEvents(calendarIds: string[], range: TimeRange): Promise<CalendarEvent[]>;
  /**
   * Incremental changes per calendar using Google sync tokens.
   * Implementations keep the sync token internally (or via a token store).
   */
  listChanges?(calendarId: string): Promise<EventsDelta>;
  /** Write a block into the Tempo calendar (E13: the only calendar Tempo writes to). */
  createBlock(tempoCalendarId: string, block: BlockDraft): Promise<CalendarEvent>;
  /** Move/resize and/or rewrite description of a Tempo block. */
  updateBlock(
    tempoCalendarId: string,
    eventId: string,
    patch: { start?: Date; end?: Date; reason?: string; learned?: string[]; title?: string },
  ): Promise<CalendarEvent>;
  deleteBlock(tempoCalendarId: string, eventId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Google Tasks (user account) — no push notifications, polled.
// ---------------------------------------------------------------------------

export interface TasksPort {
  /**
   * All tasks from all task lists: open tasks + tasks completed in the last
   * `completedSinceDays` days. Subtasks carry `parentId`.
   */
  listTasks(opts?: { completedSinceDays?: number }): Promise<Task[]>;
}

// ---------------------------------------------------------------------------
// Invitations (separate "Tempo organizer" Google account, E9/E10)
// ---------------------------------------------------------------------------

export interface InvitePort {
  /**
   * Create an event in the organizer account's calendar at `question.slot`
   * with the user as attendee and send the invitation (sendUpdates=all).
   * Returns the invitation event id.
   */
  sendQuestion(question: Question, attendeeEmail: string): Promise<string>;
  /** The attendee's current RSVP on the invitation. */
  getResponse(inviteEventId: string, attendeeEmail: string): Promise<ResponseStatus>;
  /** Update description (e.g. "No answer — kept your plan.") */
  annotate(inviteEventId: string, description: string): Promise<void>;
  /** Cancel/delete the invitation (sendUpdates=all). */
  cancel(inviteEventId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------

export interface UnderstandRequest {
  tasks: Array<Pick<Task, 'id' | 'title' | 'notes' | 'due' | 'parentId'> & { subtaskTitles?: string[] }>;
  now: Date;
  timezone: string;
  /** Context: learned notes the model may use (e.g. "user's writing tasks take 1.5x"). */
  learnedNotes: string[];
}

export interface PlaceRequest {
  now: Date;
  timezone: string;
  /** Tasks to place with their estimates (already scaled by learned prefs) and deadlines. */
  tasks: Array<{
    taskId: string;
    title: string;
    durationMin: number;
    minChunkMin: number;
    priority: number;
    urgency: number;
    deepWork: boolean;
    due?: Date;
    /** Subtasks of the same parent must be placed in this order. */
    orderGroup?: string;
    orderIndex?: number;
  }>;
  /** Free gaps (already cleaned of fixed events, sleep, lock window, outside working hours). */
  gaps: TimeRange[];
  /** Where blocks currently are — "minimal change": keep these when still valid. */
  currentBlocks: Array<{ taskId: string; start: Date; end: Date }>;
  focusTime: { start: string; end: string };
  learnedNotes: string[];
  /** Validation errors from the previous attempt (Check step feedback, max 2 retries). */
  previousErrors?: string[];
}

export interface Placement {
  taskId: string;
  start: Date;
  end: Date;
}

export interface ExplainRequest {
  now: Date;
  timezone: string;
  changes: Array<{
    taskId: string;
    title: string;
    kind: 'created' | 'moved' | 'dropped';
    from?: TimeRange;
    to?: TimeRange;
    /** Machine cause, e.g. "fixed event 'Project meeting' extended by 45 min". */
    cause: string;
  }>;
}

export interface LlmPort {
  readonly name: string;
  /** Step 1 — Understand: duration, priority, urgency, confidence per task. */
  understand(req: UnderstandRequest): Promise<Omit<TaskEstimate, never>[]>;
  /**
   * Step 3 — Place. May return `null` to let the core use its deterministic
   * greedy placer (e.g. heuristic provider, or no API key).
   */
  place(req: PlaceRequest): Promise<Placement[] | null>;
  /** Step 6 — Explain: one short line (<= 90 chars) per changed task id. */
  explain(req: ExplainRequest): Promise<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface EventFingerprint {
  id: string;
  calendarId: string;
  start: string;
  end: string;
  status: string;
  transparency: string;
  selfResponse?: string;
  updated: string;
  tempoTaskId?: string;
}

export interface TempoState {
  version: 1;
  /** Set after onboarding (`tempo setup`). */
  prefs?: Preferences;
  userEmail?: string;
  tempoCalendarId?: string;
  estimates: Record<string, TaskEstimate & { estimatedAt: string }>;
  questions: Question[];
  /** Last observed events/tasks, used by change detection to derive Signals. */
  lastSnapshot?: {
    takenAt: string;
    events: EventFingerprint[];
    tasks: Array<{ id: string; status: string; updated: string; due?: string; title: string }>;
  };
  /** Ids of block events whose "ended while task open" signal was already handled. */
  handledEndedBlocks: string[];
  /** Debounce bookkeeping (E8). */
  pendingSince?: string;
  lastPlanAt?: string;
  /** Planning-relevant preferences at the last plan; a difference triggers a re-plan. */
  prefsKey?: string;
  /** Google Calendar sync tokens per calendar id. */
  syncTokens: Record<string, string>;
  /** Active push-notification channels (optional webhook mode). */
  channels: Array<{ id: string; resourceId: string; calendarId: string; expiration: string }>;
}

export interface StateStore {
  load(): Promise<TempoState>;
  save(state: TempoState): Promise<void>;
}

export type { LearnedPreferences, Preferences };
