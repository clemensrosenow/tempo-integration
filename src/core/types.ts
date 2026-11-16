/**
 * Tempo domain model.
 *
 * This file is the shared contract between all modules (Google adapters,
 * planning core, LLM adapters, onboarding, storage, engine). Keep it free of
 * runtime dependencies. All instants are JS `Date` (absolute UTC instants);
 * local wall-clock interpretation always goes through `Preferences.timezone`.
 */

/** Half-open interval [start, end). */
export interface TimeRange {
  start: Date;
  end: Date;
}

/** "HH:mm" in the user's local timezone, 24h clock. */
export type LocalTime = string;

/** ISO weekday: 1 = Monday ... 7 = Sunday (luxon convention). */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

// ---------------------------------------------------------------------------
// Calendars & events
// ---------------------------------------------------------------------------

export interface CalendarInfo {
  id: string;
  summary: string;
  primary: boolean;
  /** Google accessRole: owner | writer | reader | freeBusyReader */
  accessRole: string;
  /** True for the dedicated "Tempo" calendar Tempo writes to. */
  isTempo: boolean;
  timeZone?: string;
  /**
   * Checked (shown) in Google Calendar's sidebar (`selected && !hidden`).
   * Setup reads exactly these calendars as busy time; undefined = unknown.
   */
  visible?: boolean;
}

export type ResponseStatus = 'needsAction' | 'declined' | 'tentative' | 'accepted';

/** Hidden metadata Tempo stores in `extendedProperties.private` of its own events. */
export interface TempoBlockMeta {
  kind: 'block' | 'question';
  /** Google Task id this block works on (for questions: the task the question is about). */
  taskId: string;
  taskListId: string;
  /** What Tempo last wrote. A difference to the live start/end = user dragged/resized. */
  plannedStart: string; // ISO
  plannedEnd: string; // ISO
  /** For questions: id of the Question in the store. */
  questionId?: string;
  /** 0-based index if one task is split into several blocks. */
  part?: number;
}

export interface CalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** Google `transparency`: 'transparent' means the user marked it "Free". */
  transparency: 'opaque' | 'transparent';
  /** Google `status` */
  status: 'confirmed' | 'tentative' | 'cancelled';
  /** The connected user's own RSVP, if the user is an attendee. */
  selfResponse?: ResponseStatus;
  updated: Date;
  /**
   * Present iff this event was created by Tempo: a block in the Tempo calendar
   * (kind 'block'), or the attendee copy of a Tempo invitation in the user's
   * primary calendar (kind 'question', detected via extendedProperties.shared).
   * Tempo events are never treated as fixed/busy events.
   */
  tempo?: TempoBlockMeta;
}

/** Convenience: the event is a Tempo-owned block (not a question, not a fixed event). */
export function isTempoBlock(e: CalendarEvent): boolean {
  return e.tempo?.kind === 'block';
}

/**
 * E7: fixed events are never moved. They block time unless marked Free
 * (transparent), declined, cancelled or all-day.
 */
export function isBusyFixedEvent(e: CalendarEvent): boolean {
  if (e.tempo) return false;
  if (e.status === 'cancelled') return false;
  if (e.transparency === 'transparent') return false;
  if (e.selfResponse === 'declined') return false;
  if (e.allDay) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export interface Task {
  id: string;
  listId: string;
  title: string;
  notes?: string;
  /**
   * Google Tasks stores only a date (time is discarded by the API).
   * Adapters normalise it to the END of that local day in the user's timezone
   * (i.e. next local midnight), so "due" is an exclusive deadline instant.
   */
  due?: Date;
  status: 'needsAction' | 'completed';
  completedAt?: Date;
  /** Parent task id for subtasks (Google Tasks supports one level). */
  parentId?: string;
  /** Google `position` string; lexicographic order = order in the list. */
  position: string;
  updated: Date;
}

/** E3: LLM-understood task. */
export interface TaskEstimate {
  taskId: string;
  /** Total remaining work in minutes. */
  durationMin: number;
  /** 1 (low) .. 5 (critical) */
  priority: number;
  /** 1 (can wait) .. 5 (today) */
  urgency: number;
  /** 0..1 confidence in the priority estimate. < 0.5 triggers an "unclear priority" question (E9). */
  confidence: number;
  /** Minimum sensible chunk if the task is split across several blocks. */
  minChunkMin: number;
  /** Prefer focus time (deep work) for this task. */
  deepWork: boolean;
  /** Short rationale, for debugging / explanations. */
  rationale?: string;
}

// ---------------------------------------------------------------------------
// Preferences (onboarding + learning)
// ---------------------------------------------------------------------------

export interface DailyWindow {
  start: LocalTime;
  end: LocalTime;
}

export interface Preferences {
  /** IANA timezone, e.g. "Europe/Berlin". */
  timezone: string;
  /**
   * Tempo only places blocks inside working hours on working days.
   * `start`/`end` apply to every working day unless `perDay` gives that
   * weekday its own window (from the settings file, e.g. a short Friday).
   */
  workingHours: DailyWindow & { days: IsoWeekday[]; perDay?: Partial<Record<IsoWeekday, DailyWindow>> };
  /** Preferred window for deep-work tasks. */
  focusTime: DailyWindow;
  /** Never planned (may wrap midnight, e.g. 23:00-07:00). */
  sleep: DailyWindow;
  /** Calendar ids read as busy (E13). The Tempo calendar is always read too. */
  selectedCalendarIds: string[];
  /** Minutes of buffer kept between blocks and fixed events. */
  bufferMin: number;
  /** Learned (E12) — see LearnedPreferences. */
  learned: LearnedPreferences;
}

export interface LearnedPreferences {
  /** Per task: duration the user taught by resizing (minutes). Overrides estimates. */
  taskDurationMin: Record<string, number>;
  /** Global multiplier on LLM duration estimates, learned from resizes (EMA). 1 = no bias. */
  durationScale: number;
  /** Hour-of-day (0..23, local) affinity learned from drags. Positive = user moves blocks there. */
  hourAffinity: Record<number, number>;
  /** Per task: the user explicitly chose this priority via a question. */
  taskPriority: Record<string, number>;
  /** RSVP "No" answers: proposals the user rejected (task id -> count). */
  rejectedProposals: Record<string, number>;
  /** Human-readable log, newest last, e.g. "Writing tasks take you ~1.5x longer". */
  notes: string[];
}

export function emptyLearned(): LearnedPreferences {
  return {
    taskDurationMin: {},
    durationScale: 1,
    hourAffinity: {},
    taskPriority: {},
    rejectedProposals: {},
    notes: [],
  };
}

// ---------------------------------------------------------------------------
// Plans, changes, questions
// ---------------------------------------------------------------------------

export interface BlockDraft {
  taskId: string;
  taskListId: string;
  title: string;
  start: Date;
  end: Date;
  part?: number;
  /** E11 one-line reason (set by the Explain step). */
  reason?: string;
  /** E12 "Tempo learned: …" lines to show in the description. */
  learned?: string[];
}

export type EventChange =
  | { op: 'create'; block: BlockDraft }
  | {
      op: 'move';
      eventId: string;
      taskId: string;
      from: TimeRange;
      to: TimeRange;
      reason?: string;
      learned?: string[];
    }
  | { op: 'delete'; eventId: string; taskId: string; reason?: string };

export type QuestionKind = 'missed-due' | 'dropped-task' | 'unclear-priority' | 'big-change';

export type QuestionStatus = 'queued' | 'open' | 'yes' | 'no' | 'maybe' | 'expired' | 'superseded';

export interface Question {
  id: string;
  kind: QuestionKind;
  /** Invitation title, always starts with "Tempo asks: ". */
  title: string;
  /** Invitation description incl. "Yes = apply · No = keep as is · Maybe = other time". */
  description: string;
  /** Proposed slot = where the invitation is placed. */
  slot: TimeRange;
  /** The task the question is mainly about. */
  taskId: string;
  taskListId: string;
  /** Applied on "Yes". */
  proposal: EventChange[];
  /** Ordered next-best options, consumed one by one on "Maybe". */
  alternatives: Array<{ slot: TimeRange; proposal: EventChange[]; summary: string }>;
  /** Tempo blocks hidden (deleted) while the question is open; restored on "No". */
  replacedBlocks: BlockDraft[];
  /** Event ids of `replacedBlocks` in the Tempo calendar; the engine deletes them when the question opens. */
  replacedEventIds: string[];
  /** For unclear-priority questions: the priority applied on "Yes". */
  proposedPriority?: number;
  createdAt: Date;
  /** = slot.start - 1h. No answer by then means "No" (E10/D12). */
  answerBy: Date;
  status: QuestionStatus;
  /** Event id of the invitation (in the organizer account's calendar), once sent. */
  inviteEventId?: string;
}

/** What happened since the last planning run. */
export type Signal =
  | { type: 'initial' }
  | { type: 'periodic' }
  /** The user changed settings (working hours, busy calendars …): re-place everything that no longer fits. */
  | { type: 'settings-changed' }
  | { type: 'tasks-changed'; taskIds: string[] }
  | { type: 'task-completed'; taskId: string }
  | { type: 'fixed-event-changed'; eventId: string }
  | {
      /** User dragged and/or resized a Tempo block (E6 + E12). */
      type: 'block-moved-by-user';
      eventId: string;
      taskId: string;
      from: TimeRange;
      to: TimeRange;
    }
  | { type: 'block-deleted-by-user'; eventId: string; taskId: string }
  | {
      /** A block ended but its task is not checked off (E6). */
      type: 'block-ended-open';
      eventId: string;
      taskId: string;
    }
  | { type: 'question-answered'; questionId: string; answer: 'yes' | 'no' | 'maybe' }
  | { type: 'question-timeout'; questionId: string };

/** Input of the planning pipeline — the single test seam (see spec "Testing Decisions"). */
export interface PlanInput {
  now: Date;
  /** All events in the planning horizon from selected calendars AND the Tempo calendar. */
  events: CalendarEvent[];
  /** Open tasks plus recently completed ones. */
  tasks: Task[];
  prefs: Preferences;
  signals: Signal[];
  /** Cached estimates; the pipeline re-estimates tasks missing here or changed since `estimatedAt`. */
  estimates: Record<string, TaskEstimate & { estimatedAt: string }>;
  /** Currently open question (max one, E10). */
  openQuestion?: Question;
  /** Queued questions (not yet sent). */
  queuedQuestions: Question[];
  /** Planning horizon in days from now. */
  horizonDays: number;
}

export interface PlanOutput {
  /** Changes applied to the Tempo calendar right away. */
  apply: EventChange[];
  /** New questions; the engine sends at most one at a time and queues the rest. */
  questions: Question[];
  /** Questions whose status changed (answered/expired/superseded) — persisted by the engine. */
  updatedQuestions: Question[];
  /** Updated estimates to cache. */
  estimates: Record<string, TaskEstimate & { estimatedAt: string }>;
  /** Updated learned preferences (full object), if anything was learned. */
  learned?: LearnedPreferences;
  /** Debug log lines (not shown to the user). */
  log: string[];
}

export const LOCK_WINDOW_MIN = 60; // E8: next hour locked
export const BIG_CHANGE_MAX_BLOCKS = 3; // E9: >3 blocks moved => ask
export const BIG_CHANGE_MAX_DAYS = 2; // E9: any block moved >2 days => ask
export const DEBOUNCE_MS = 90_000; // E8: bursts of changes collapse into one re-plan
export const QUESTION_PREFIX = 'Tempo asks: ';
export const RSVP_HELP = 'Yes = apply · No = keep as is · Maybe = other time';
