/**
 * The settings file (`tempo.json`): the user-editable source of truth for
 * working hours, focus time, sleep, buffer and the calendars read as busy.
 *
 * - `tempo setup` writes it from what it inferred (calendars: the ones shown
 *   in Google Calendar's sidebar).
 * - The user changes it on demand, by editing the file or with
 *   `tempo prefs …` / `tempo calendars add|remove …`.
 * - A running Tempo re-reads it on every tick (SettingsStore) and re-plans
 *   when it changed. What Tempo learned stays in the state file.
 * - An invalid file never stops Tempo: it keeps the last valid settings and
 *   logs the problem once.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { StateStore, TempoState } from '../core/ports.js';
import { emptyLearned, type CalendarInfo, type DailyWindow, type IsoWeekday, type Preferences } from '../core/types.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type WeekdayKey = (typeof WEEKDAYS)[number];

const WINDOW_RE = /^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-4]):([0-5]\d)$/;
const windowString = z
  .string()
  .transform((s) => s.replace(/\s+/g, ''))
  .refine((s) => WINDOW_RE.test(s) && !/24:[1-5]/.test(s), { message: 'expected "HH:mm-HH:mm", e.g. "09:00-17:30"' })
  .refine((s) => s.slice(0, 5) !== s.slice(6), { message: 'start and end must differ' });
const dayValue = z.union([z.literal('off'), windowString]);

export const settingsSchema = z
  .object({
    timezone: z.string().refine(isValidZone, { message: 'unknown IANA timezone, e.g. "Europe/Berlin"' }),
    workingHours: z
      .object(Object.fromEntries(WEEKDAYS.map((d) => [d, dayValue])) as Record<WeekdayKey, typeof dayValue>)
      .strict()
      .refine((wh) => WEEKDAYS.some((d) => wh[d] !== 'off'), { message: 'at least one day must not be "off"' })
      .refine((wh) => WEEKDAYS.every((d) => wh[d] === 'off' || wh[d].slice(0, 5) < wh[d].slice(6)), {
        message: 'working hours must end after they start on the same day',
      }),
    focusTime: windowString,
    sleep: windowString,
    bufferMinutes: z.number().int().min(0).max(60),
    busyCalendars: z.array(z.object({ name: z.string().optional(), id: z.string().min(1) }).strict()),
  })
  .strict();

export type SettingsFile = z.infer<typeof settingsSchema>;

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

export function windowToString(w: DailyWindow): string {
  return `${w.start}-${w.end}`;
}

export function parseWindowString(s: string): DailyWindow {
  const v = s.replace(/\s+/g, '');
  const [start, end] = v.split('-');
  return { start: start!, end: end! };
}

export function settingsFromPrefs(prefs: Preferences, calendars: readonly CalendarInfo[] = []): SettingsFile {
  const names = new Map(calendars.map((c) => [c.id, c.summary]));
  const workingHours = {} as Record<WeekdayKey, string>;
  WEEKDAYS.forEach((key, i) => {
    const day = (i + 1) as IsoWeekday;
    const w = prefs.workingHours.perDay?.[day] ?? prefs.workingHours;
    workingHours[key] = prefs.workingHours.days.includes(day) ? windowToString(w) : 'off';
  });
  return {
    timezone: prefs.timezone,
    workingHours,
    focusTime: windowToString(prefs.focusTime),
    sleep: windowToString(prefs.sleep),
    bufferMinutes: prefs.bufferMin,
    busyCalendars: prefs.selectedCalendarIds.map((id) => {
      const name = names.get(id);
      return name ? { name, id } : { id };
    }),
  };
}

/** Settings → Preferences. Keeps what Tempo learned from `base`. */
export function prefsFromSettings(s: SettingsFile, base?: Preferences): Preferences {
  const windows = new Map<IsoWeekday, string>();
  WEEKDAYS.forEach((key, i) => {
    if (s.workingHours[key] !== 'off') windows.set((i + 1) as IsoWeekday, s.workingHours[key]);
  });
  const days = [...windows.keys()];
  // The most common window is the default; other days get their own.
  const counts = new Map<string, number>();
  for (const w of windows.values()) counts.set(w, (counts.get(w) ?? 0) + 1);
  const common = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]![0];
  const perDay: Partial<Record<IsoWeekday, DailyWindow>> = {};
  for (const [d, w] of windows) if (w !== common) perDay[d] = parseWindowString(w);
  return {
    timezone: s.timezone,
    workingHours: { ...parseWindowString(common), days, ...(Object.keys(perDay).length ? { perDay } : {}) },
    focusTime: parseWindowString(s.focusTime),
    sleep: parseWindowString(s.sleep),
    bufferMin: s.bufferMinutes,
    selectedCalendarIds: [...new Set(s.busyCalendars.map((c) => c.id))],
    learned: base?.learned ?? emptyLearned(),
  };
}

/** Everything that affects planning except what Tempo learned. */
export function planningPrefsKey(prefs: Preferences): string {
  const { learned: _learned, ...rest } = prefs;
  return JSON.stringify(rest);
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export type ReadSettingsResult =
  | { kind: 'missing' }
  | { kind: 'ok'; settings: SettingsFile }
  | { kind: 'invalid'; error: string };

export async function readSettings(file: string): Promise<ReadSettingsResult> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { kind: 'invalid', error: `${path.basename(file)} is not valid JSON: ${(err as Error).message}` };
  }
  const parsed = settingsSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { kind: 'invalid', error: `${path.basename(file)}: ${issues}` };
  }
  return { kind: 'ok', settings: parsed.data };
}

export async function writeSettings(file: string, s: SettingsFile): Promise<void> {
  const valid = settingsSchema.parse(s);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(valid, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * StateStore decorator: every load() overlays the settings file onto
 * `state.prefs`, so edits apply on the next tick without a restart. Problems
 * with the file are reported once per distinct message; the last valid
 * preferences stay in use.
 */
export class SettingsStore implements StateStore {
  private lastProblem: string | undefined;

  constructor(
    private readonly inner: StateStore,
    readonly file: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async load(): Promise<TempoState> {
    const state = await this.inner.load();
    if (!state.prefs) return state; // not set up yet: setup writes both
    const r = await readSettings(this.file);
    if (r.kind === 'ok') {
      state.prefs = prefsFromSettings(r.settings, state.prefs);
      this.lastProblem = undefined;
    } else {
      const problem =
        r.kind === 'missing'
          ? `${this.file} is missing; using the settings saved at setup (run \`tempo prefs\` to recreate it)`
          : `${r.error} — keeping the previous settings until this is fixed`;
      if (problem !== this.lastProblem) this.log(`settings: ${problem}`);
      this.lastProblem = problem;
    }
    return state;
  }

  save(state: TempoState): Promise<void> {
    return this.inner.save(state);
  }
}

function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
