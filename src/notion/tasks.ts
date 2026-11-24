import { DateTime } from 'luxon';
import { dailyWindowOn } from '../core/time.js';
import { estimateTask } from '../llm/heuristic.js';
import { type DataSource, type Field, type NotionDate, type Page, type Property, NotionApi, NotionError, notionId, plain } from './api.js';
import type { NotionSettings, TaskMapping } from './settings.js';
import { WEEKDAYS, parseWindowString } from '../settings/settings.js';

export interface Task {
  id: string;
  title: string;
  url: string;
  duration: number;
  estimated: boolean;
  splittable?: boolean;
  priority: number;
  due?: Date;
  project?: string;
  area?: string;
}

type Mapped = TaskMapping & { title: string; completion: string; completionType: string; done: string[]; parked: string[] };
const normalize = (name: string) => name.normalize('NFKC').toLowerCase().trim();
const fieldKey = (name: string) => normalize(name).replace(/[^\p{L}\p{N}]/gu, '');
const doneNames = /^(done|complete[d]?|closed|finished|cancel[led]+|erledigt|abgeschlossen|fertig|storniert)$/i;
const parkedNames = /^(waiting|blocked|on hold|parked|someday(?:\/maybe)?|deferred|warten|wartend|blockiert|irgendwann|zurückgestellt)$/i;
const taskNames = /^(tasks?|my tasks|aufgaben|to[ -]?dos?|task list|action items|master tasks|tempo tasks|todo list)$/i;

function find(fields: Field[], configured: string | undefined, types: string[], aliases: string[]): Field | undefined {
  if (configured) {
    const result = fields.find(f => f.id === configured || f.name === configured);
    if (!result || !types.includes(result.type)) throw new Error(`The mapped Notion field "${configured}" changed or is missing. Review the task mapping.`);
    return result;
  }
  for (const alias of aliases) {
    const field = fields.find(f => types.includes(f.type) && fieldKey(f.name) === fieldKey(alias));
    if (field) return field;
  }
  return undefined;
}

export function mapFields(source: DataSource, config: TaskMapping): Mapped {
  const fields = Object.values(source.properties);
  const title = fields.find(f => f.type === 'title');
  const completion = find(fields, config.completion, ['status', 'select', 'checkbox'],
    ['Status', 'Task Status', 'State', 'Done', 'Completed', 'Complete', 'Erledigt']);
  if (!title || !completion) throw new Error('Tempo needs a title and a known completion field. Set notion.mapping.completion to the status, select, or checkbox field.');
  const options = completion.status?.options ?? completion.select?.options ?? [];
  const groups = completion.status?.groups ?? [];
  const doneGroup = groups.find(g => /^(complete[d]?|done|erledigt|abgeschlossen|fertig)$/i.test(g.name));
  const select = (values: string[]) => values.map(value => {
    const option = options.find(o => o.id === value || normalize(o.name) === normalize(value));
    if (!option) throw new Error(`Completion option "${value}" changed or is missing. Review the task mapping.`);
    return option.id ?? option.name;
  });
  const done = completion.type === 'checkbox' ? ['true'] : config.done ? select(config.done) :
    options.filter(o => doneGroup?.option_ids.includes(o.id ?? '') || doneNames.test(o.name)).map(o => o.id ?? o.name);
  if (!done.length) throw new Error('Tempo could not identify a completed status. Set notion.mapping.done to the finished options.');
  const parked = config.parked ? select(config.parked) : options.filter(o => parkedNames.test(o.name)).map(o => o.id ?? o.name);
  const due = find(fields, config.due, ['date', 'formula', 'rollup'], ['Due', 'Due Date', 'Deadline', 'Fällig', 'Fälligkeitsdatum']);
  const priority = find(fields, config.priority, ['select', 'status', 'number', 'rich_text', 'formula', 'rollup', 'multi_select'],
    ['Priority', 'Priorität', 'Importance']);
  const duration = find(fields, config.duration, ['number', 'select', 'rich_text', 'formula', 'rollup'],
    ['Estimated Minutes', 'Duration Minutes', 'Planned Minutes', 'Time Estimate', 'Estimated Time', 'Duration', 'Effort', 'Dauer', 'Aufwand']);
  const durationFallback = find(fields, config.durationFallback, ['number', 'select', 'rich_text', 'formula', 'rollup'],
    ['Duration', 'Dauer']);
  const notes = find(fields, config.notes, ['rich_text'], ['Notes', 'Description', 'Beschreibung', 'Notizen']);
  const project = find(fields, config.project, ['relation'], ['Project', 'Projects', 'Projekt', 'Projekte']);
  const area = find(fields, config.area, ['relation'], ['Area', 'Areas', 'Bereich', 'Bereiche']);
  return {
    title: title.id, completion: completion.id, completionType: completion.type, done, parked,
    due: due?.id, priority: priority?.id, duration: duration?.id, durationFallback: durationFallback?.id === duration?.id ? undefined : durationFallback?.id,
    durationUnit: config.durationUnit,
    notes: notes?.id, project: project?.id, area: area?.id,
  };
}

function sourceName(source: DataSource) {
  return plain(source.title) || 'Untitled database';
}
function score(source: DataSource) {
  const name = sourceName(source).trim();
  if (source.archived || source.in_trash || name === 'Tempo Sessions') return 0;
  const fields = Object.values(source.properties);
  const taskFields = fields.filter(f => /priority|priorität|due|deadline|estimate|duration|project|area/i.test(f.name));
  if (taskNames.test(name)) return 20 + taskFields.length;
  return fields.some(f => ['status', 'checkbox'].includes(f.type)) && taskFields.length >= 3 ? taskFields.length : 0;
}

export async function chooseSource(api: NotionApi, config: NotionSettings): Promise<DataSource | undefined> {
  if (config.notion.taskSource) {
    const id = notionId(config.notion.taskSource);
    let source: DataSource;
    try {
      source = await api.source(id);
    } catch (err) {
      if (!(err instanceof NotionError) || err.status !== 404) throw err;
      const db = await api.database(id);
      if (db.data_sources.length !== 1) throw new Error('This database has multiple data sources. Set notion.taskSource to the task data source URL.');
      source = await api.source(db.data_sources[0]!.id);
    }
    if (source.archived || source.in_trash) throw new Error('The selected task data source is archived.');
    return source;
  }
  const sources = (await api.searchSources()).filter(s => !s.archived && !s.in_trash && sourceName(s) !== 'Tempo Sessions');
  const candidates = sources.filter(s => score(s) > 0).sort((a, b) => score(b) - score(a));
  if (!candidates.length && sources.length) {
    throw new Error('No task database could be identified among the shared databases. Share your task database or set notion.taskSource explicitly.');
  }
  if (candidates.length > 1 && score(candidates[0]!) - score(candidates[1]!) < 2) {
    throw new Error('More than one shared task database looks suitable. Set notion.taskSource to the intended database URL and run setup again.');
  }
  return candidates[0] ? api.source(candidates[0].id) : undefined;
}

function property(page: Page, id?: string): Property | undefined {
  return id ? Object.values(page.properties).find(p => p.id === id) : undefined;
}

function unwrap(value?: Property | Property['formula']): unknown {
  if (!value) return undefined;
  switch (value.type) {
    case 'formula': return unwrap(value.formula);
    case 'rollup': return value.rollup?.type === 'array'
      ? value.rollup.array?.map(unwrap).find(v => v !== undefined && v !== null)
      : unwrap(value.rollup);
    case 'number': return value.number;
    case 'string': return value.string;
    case 'rich_text': return plain(value.rich_text);
    case 'status': return value.status?.name;
    case 'select': return value.select?.name;
    case 'multi_select': return value.multi_select?.map(item => item.name);
    case 'date': return value.date;
  }
  return undefined;
}

export function parseDuration(value: unknown, unit: TaskMapping['durationUnit'] = 'minutes'): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const str = String(value).trim().replace(/,/g, '.');
  const composite = /^(\d+(?:\.\d+)?)\s*(?:h|hrs?|hours?|std\.?|stunden?)\s*(\d+(?:\.\d+)?)\s*(?:m|mins?|minutes?|minuten)?$/i.exec(str);
  const single = /^(\d+(?:\.\d+)?)\s*(h|hrs?|hours?|std\.?|stunden?|m|mins?|minutes?|minuten)?$/i.exec(str);
  const amount = composite ? Number(composite[1]) * 60 + Number(composite[2]) : single
    ? Number(single[1]) * ((single[2] ? /^(h|std|stund)/i.test(single[2]) : unit === 'hours') ? 60 : 1)
    : 0;
  return amount >= 1 && amount <= 2400 ? Math.ceil(amount) : undefined;
}

function priority(value: unknown): number | undefined {
  if (Array.isArray(value)) {
    const values = value.map(priority).filter((n): n is number => n !== undefined);
    return values.length ? Math.max(...values) : undefined;
  }
  if (typeof value === 'number') return Number.isInteger(value) && value >= 1 && value <= 5 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const label = normalize(value);
  const p = /^(?:p|prio\s*)([0-4])\b/.exec(label);
  if (p) return 5 - Number(p[1]);
  const labels: Record<string, number> = {
    critical: 5, urgent: 5, kritisch: 5, dringend: 5, high: 4, hoch: 4, important: 4, wichtig: 4,
    medium: 3, normal: 3, mittel: 3, low: 2, niedrig: 2, 'very low': 1, 'sehr niedrig': 1, optional: 1,
  };
  return labels[label] ?? (/^[1-5]$/.test(label) ? Number(label) : undefined);
}

export function deadline(value: unknown, config: NotionSettings): Date | undefined {
  if (typeof value !== 'object' || !value || !('start' in value)) return undefined;
  const date = value as NotionDate;
  const raw = date.end ?? date.start;
  const local = DateTime.fromISO(raw, { zone: date.time_zone ?? config.timezone });
  if (!local.isValid) return undefined;
  if (raw.includes('T')) return local.toJSDate();
  const hours = config.workingHours[WEEKDAYS[local.weekday - 1]!];
  if (hours === 'off') return local.plus({ days: 1 }).startOf('day').toJSDate();
  // The end of the user's working window is the deadline for an all-day due value.
  return dailyWindowOn(local.startOf('day'), parseWindowString(hours)).end;
}

function textDuration(text: string): number | undefined {
  const match = /(?:^|[^\p{L}\p{N}])(\d+(?:[.,]\d+)?\s*(?:hours?|hrs?|stunden?|std\.?|h)(?:\s*\d+(?:[.,]\d+)?\s*(?:minutes?|minuten|mins?|m))?|\d+(?:[.,]\d+)?\s*(?:minutes?|minuten|mins?|m))(?![\p{L}\p{N}])/iu.exec(text);
  return match?.[1] ? parseDuration(match[1]) : undefined;
}

function textPriority(text: string) {
  const label = /(?:\bpriority|\bpriorität|\bprio)\s*[:=]\s*([^\n,;.!]+)/iu.exec(text)?.[1];
  const shorthand = /\bP[0-4]\b/i.exec(text)?.[0];
  return priority(label) ?? priority(shorthand);
}

export class TaskReader {
  private readonly textCache = new Map<string, { revision: string; text: string }>();
  constructor(private readonly api: NotionApi) {}

  async read(source: DataSource, mapping: Mapped, config: NotionSettings, now: Date): Promise<Task[]> {
    const pages = await this.api.pages(source.id);
    const current = new Set(pages.map(page => page.id));
    for (const id of this.textCache.keys()) if (!current.has(id)) this.textCache.delete(id);
    const tasks: Task[] = [];
    for (const page of pages) {
      if (page.archived || page.in_trash) continue;
      const state = property(page, mapping.completion);
      if (!state || state.type !== mapping.completionType) throw new Error('The task completion field changed. Review the task mapping.');
      const option = state.status ?? state.select;
      const status = state.type === 'checkbox' ? String(state.checkbox) : option?.id ?? option?.name;
      if (status && (mapping.done.includes(status) || mapping.parked.includes(status))) continue;
      const title = plain(property(page, mapping.title)?.title).trim();
      if (!title) continue;
      const due = deadline(unwrap(property(page, mapping.due)), config);
      const explicitDuration = parseDuration(unwrap(property(page, mapping.duration)), mapping.durationUnit) ??
        parseDuration(unwrap(property(page, mapping.durationFallback)), mapping.durationUnit);
      const explicitPriority = priority(unwrap(property(page, mapping.priority)));
      const notes = plain(property(page, mapping.notes)?.rich_text);
      let body = '';
      if ((explicitDuration ?? textDuration(title + '\n' + notes)) === undefined ||
          (explicitPriority ?? textPriority(title + '\n' + notes)) === undefined) {
        const cached = this.textCache.get(page.id);
        if (cached?.revision === page.last_edited_time) body = cached.text;
        else {
          try {
            body = await this.api.pageText(page.id);
          } catch (error) {
            if (error instanceof NotionError && error.status === 404) continue;
            throw error;
          }
          this.textCache.set(page.id, { revision: page.last_edited_time, text: body });
        }
      }
      const context = title + '\n' + notes + '\n' + body;
      const heuristic = estimateTask({ id: page.id, title, notes: notes + body, due }, now);
      const firstProject = property(page, mapping.project)?.relation?.[0]?.id;
      const firstArea = property(page, mapping.area)?.relation?.[0]?.id;
      tasks.push({
        id: page.id, title, url: page.url,
        duration: explicitDuration ?? textDuration(context) ?? heuristic.durationMin,
        estimated: explicitDuration === undefined,
        priority: explicitPriority ?? textPriority(context) ?? heuristic.priority,
        due, project: firstProject, area: firstArea, splittable: heuristic.deepWork,
      });
    }
    return tasks;
  }
}
