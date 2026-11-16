/**
 * One-step start (E1, D18): connect Google once, infer working hours, focus
 * time, sleep and calendar selection from the last 4 weeks, let the user
 * confirm (or override), create the Tempo calendar, persist preferences.
 */
import type { CalendarPort, StateStore } from '../core/ports.js';
import type { CalendarInfo, DailyWindow, IsoWeekday, Preferences } from '../core/types.js';
import { inferPreferences } from '../onboarding/infer.js';

export interface SetupOverrides {
  workingHours?: DailyWindow;
  workingDays?: IsoWeekday[];
  focusTime?: DailyWindow;
  sleep?: DailyWindow;
  calendarIds?: string[];
  timezone?: string;
}

export interface SetupProposal {
  userEmail: string;
  timezone: string;
  calendars: CalendarInfo[];
  prefs: Preferences;
  evidence: string[];
}

const HISTORY_DAYS = 28;

/** Read-only: infer a proposal from calendar history. Nothing is written. */
export async function proposeSetup(calendar: CalendarPort, now: Date, overrides: SetupOverrides = {}): Promise<SetupProposal> {
  const userEmail = await calendar.getUserEmail();
  const calendars = await calendar.listCalendars();
  const primary = calendars.find((c) => c.primary);
  const timezone =
    overrides.timezone ?? primary?.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const readable = calendars.filter((c) => !c.isTempo);
  const events = await calendar.listEvents(
    readable.map((c) => c.id),
    { start: new Date(now.getTime() - HISTORY_DAYS * 86_400_000), end: now },
  );
  const { prefs, evidence } = inferPreferences({ events, calendars, timezone, now });
  return { userEmail, timezone, calendars, prefs: applyOverrides(prefs, overrides), evidence };
}

export function applyOverrides(prefs: Preferences, o: SetupOverrides): Preferences {
  return {
    ...prefs,
    timezone: o.timezone ?? prefs.timezone,
    workingHours: {
      ...prefs.workingHours,
      ...(o.workingHours ?? {}),
      days: o.workingDays ?? prefs.workingHours.days,
    },
    focusTime: o.focusTime ?? prefs.focusTime,
    sleep: o.sleep ?? prefs.sleep,
    selectedCalendarIds: o.calendarIds ?? prefs.selectedCalendarIds,
  };
}

/** Write: create/find the Tempo calendar and persist the confirmed preferences. */
export async function confirmSetup(
  calendar: CalendarPort,
  store: StateStore,
  proposal: SetupProposal,
): Promise<{ tempoCalendarId: string }> {
  const tempoCalendarId = await calendar.ensureTempoCalendar(proposal.timezone);
  const state = await store.load();
  const previousLearned = state.prefs?.learned;
  state.prefs = {
    ...proposal.prefs,
    // Re-running setup must not forget what Tempo learned.
    learned: previousLearned ?? proposal.prefs.learned,
    selectedCalendarIds: proposal.prefs.selectedCalendarIds.filter((id) => id !== tempoCalendarId),
  };
  state.userEmail = proposal.userEmail;
  state.tempoCalendarId = tempoCalendarId;
  // Force a fresh baseline: the first tick after setup is an 'initial' plan.
  delete state.lastSnapshot;
  await store.save(state);
  return { tempoCalendarId };
}

export function describeProposal(p: SetupProposal): string {
  const days = p.prefs.workingHours.days.map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d]).join(' ');
  const selected = new Set(p.prefs.selectedCalendarIds);
  const lines = [
    `Account:        ${p.userEmail}`,
    `Timezone:       ${p.timezone}`,
    `Working hours:  ${p.prefs.workingHours.start}–${p.prefs.workingHours.end} (${days})`,
    `Focus time:     ${p.prefs.focusTime.start}–${p.prefs.focusTime.end}`,
    `Sleep:          ${p.prefs.sleep.start}–${p.prefs.sleep.end}`,
    `Calendars read as busy:`,
    ...p.calendars
      .filter((c) => !c.isTempo)
      .map((c) => `  [${selected.has(c.id) ? 'x' : ' '}] ${c.summary}  (${c.id})`),
    '',
    'Why:',
    ...p.evidence.map((e) => `  - ${e}`),
  ];
  return lines.join('\n');
}
