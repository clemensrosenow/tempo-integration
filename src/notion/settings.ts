import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { REPO_ROOT } from '../config.js';
import { prefsFromSettings, settingsSchema } from '../settings/settings.js';

export const mappingSchema = z.object({
  completion: z.string().optional(),
  done: z.array(z.string()).min(1).optional(),
  parked: z.array(z.string()).optional(),
  due: z.string().optional(),
  priority: z.string().optional(),
  duration: z.string().optional(),
  durationFallback: z.string().optional(),
  durationUnit: z.enum(['minutes', 'hours']).default('minutes'),
  notes: z.string().optional(),
  project: z.string().optional(),
  area: z.string().optional(),
}).strict();

const settings = settingsSchema.pick({ timezone: true, workingHours: true, bufferMinutes: true }).extend({
  notion: z.object({
    taskSource: z.string().optional(),
    sessionsParent: z.string().optional(),
    createTasksIfMissing: z.boolean().default(false),
    mapping: mappingSchema.default(() => mappingSchema.parse({})),
  }).strict().default(() => ({ createTasksIfMissing: false, mapping: mappingSchema.parse({}) })),
  google: z.object({ calendars: z.array(z.string().min(1)).max(50).min(1).default(['primary']) }).strict()
    .default(() => ({ calendars: ['primary'] })),
  horizonDays: z.number().int().min(2).max(30).default(7),
  pollSeconds: z.number().int().min(30).default(90),
  maxAutomaticMoveDays: z.number().int().min(0).default(2),
  maxAutomaticMoves: z.number().int().min(0).default(3),
  protectedMinutes: z.number().int().min(0).default(60),
}).strict();

export type NotionSettings = z.infer<typeof settings>;
export type TaskMapping = z.infer<typeof mappingSchema>;
export const settingsPath = () => path.resolve(process.env.TEMPO_NOTION_SETTINGS || path.join(REPO_ROOT, 'tempo.notion.json'));
export const dataPath = () => path.resolve(process.env.TEMPO_NOTION_DATA_DIR || path.join(REPO_ROOT, '.tempo', 'notion'));
const hours = '10:00-20:00';
const defaults = {
  timezone: 'Europe/Berlin',
  workingHours: { mon: hours, tue: hours, wed: hours, thu: hours, fri: hours, sat: 'off', sun: 'off' },
  bufferMinutes: 5,
};

export async function readNotionSettings(file = settingsPath()): Promise<NotionSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return settings.parse(defaults);
    throw error;
  }
  return settings.parse({ ...defaults, ...JSON.parse(raw) });
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function planningPreferences(config: NotionSettings) {
  return prefsFromSettings({
    timezone: config.timezone, workingHours: config.workingHours, bufferMinutes: config.bufferMinutes,
    focusTime: '10:00-12:00', sleep: '00:00-01:00', busyCalendars: [],
  });
}
