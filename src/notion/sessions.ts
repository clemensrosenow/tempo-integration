import { DateTime } from 'luxon';
import { NotionApi, NotionError, notionId, plain, rich, type NotionDate, type DataSource, type Page, type PageProperties } from './api.js';
import { actions, controls, type Action, type Control, type Session, type SessionState } from './planner.js';
import type { TimeRange } from '../core/types.js';

const DATABASE = 'Tempo Sessions';
const statuses: SessionState[] = ['Planned', 'Needs review', 'Needs time', 'Skipped', 'History', 'Closed'];
const selectOptions = (values: readonly string[]) => ({ select: { options: values.map(name => ({ name })) } });
const sessionSchema = {
  Name: { title: {} },
  'Scheduled time': { date: {} },
  'Original task': { url: {} },
  Status: selectOptions(statuses),
  Control: selectOptions(controls),
  Decision: selectOptions(actions),
  'Why this time': { rich_text: {} },
  Duration: { rich_text: {} },
  'Review by': { date: {} },
  'Last moved': { date: {} },
  'Tempo ID': { rich_text: {} },
  'Tempo state': { rich_text: {} },
};

const description = 'Open this database in Notion Calendar using Scheduled time. ' +
  'Filter Status to Needs review, Needs time, or Skipped for work needing attention, then sort by Review by. ' +
  'Use Control or Decision to guide Tempo. Sort Last moved newest first to review repairs.';

export async function sessionsDatabase(api: NotionApi, parent: string, create: boolean) {
  const id = notionId(parent);
  const page = await api.page(id);
  if (page.archived || page.in_trash || page.parent?.data_source_id) {
    throw new Error('Choose an active private Notion page to hold Tempo Sessions.');
  }
  const existing = (await api.children(id)).filter(b => b.type === 'child_database' &&
    (b.child_database as { title?: string }).title === DATABASE);
  if (existing.length > 1) throw new Error('More than one Tempo Sessions database exists under the setup page.');
  const db = existing[0] ? await api.database(existing[0].id) :
    create ? await api.createDatabase(id, DATABASE, sessionSchema, description) : undefined;
  if (!db) return undefined;
  if (db.data_sources.length !== 1 || db.archived || db.in_trash) throw new Error('Tempo Sessions needs one active data source.');
  const source = await api.source(db.data_sources[0]!.id);
  for (const [name, field] of Object.entries(sessionSchema)) {
    if (source.properties[name]?.type !== Object.keys(field)[0]) throw new Error(`Tempo Sessions is missing its "${name}" field.`);
  }
  return { id: source.id, url: db.url, database: db.id };
}

export async function sessionViews(api: NotionApi, database: string, source: DataSource,
  ensure: (name: string, exists: boolean, create: () => Promise<unknown>) => Promise<unknown>) {
  const existing = new Set((await api.views(database)).map(view => view.name));
  const field = (name: string) => source.properties[name]!.id;
  const table = (visible: string[]) => ({
    type: 'table',
    properties: Object.keys(sessionSchema).map(name => ({ property_id: field(name), visible: visible.includes(name) })),
  });
  const views = [
    {
      name: 'Calendar', type: 'calendar', configuration: { type: 'calendar', date_property_id: field('Scheduled time') },
    },
    {
      name: 'Needs attention', type: 'table',
      filter: { or: ['Needs review', 'Needs time', 'Skipped'].map(equals => ({ property: field('Status'), select: { equals } })) },
      sorts: [{ property: field('Review by'), direction: 'ascending' }],
      configuration: table(['Name', 'Status', 'Review by', 'Why this time', 'Duration', 'Decision', 'Original task']),
    },
    {
      name: 'Recent changes', type: 'table', filter: { property: field('Last moved'), date: { is_not_empty: true } },
      sorts: [{ property: field('Last moved'), direction: 'descending' }],
      configuration: table(['Name', 'Scheduled time', 'Why this time', 'Last moved', 'Decision', 'Original task']),
    },
  ];
  for (const view of views) {
    await ensure(view.name, existing.has(view.name), () => api.createView(database, source.id, view));
  }
}

type StoredRange = { start: string; end: string };
type Stored = {
  published?: StoredRange; previous?: StoredRange; proposal?: StoredRange;
  override?: number; control: Control; acceptedDeadline?: string; deadline?: string; parts: number; approvalRequired?: boolean;
};
const pack = (r?: TimeRange): StoredRange | undefined => r && ({ start: r.start.toISOString(), end: r.end.toISOString() });
function unpack(range: NotionDate | StoredRange | undefined | null, timezone = 'UTC'): TimeRange | undefined {
  if (!range?.end || !range.start.includes('T') || !range.end.includes('T')) return undefined;
  const zone = 'time_zone' in range ? range.time_zone ?? timezone : timezone;
  const start = DateTime.fromISO(range.start, { zone }).toJSDate();
  const end = DateTime.fromISO(range.end, { zone }).toJSDate();
  return end > start ? { start, end } : undefined;
}

export function readSession(page: Page, timezone: string): Session | undefined {
  const p = page.properties;
  const key = plain(p['Tempo ID']?.rich_text);
  if (!key) return undefined;
  let meta: Stored;
  try {
    meta = JSON.parse(plain(p['Tempo state']?.rich_text)) as Stored;
    if (!meta || !controls.includes(meta.control)) throw new Error();
  } catch {
    throw new Error('A Tempo session has invalid integration metadata. Restore its Tempo state before planning.');
  }
  const date = p['Scheduled time']?.date;
  const range = unpack(date, timezone);
  const control = p.Control?.select?.name as Control;
  const action = p.Decision?.select?.name as Action;
  const state = p.Status?.select?.name as SessionState;
  return {
    key, taskId: key.split(':')[0]!, parts: meta.parts ?? 1, title: plain(p.Name?.title), url: p['Original task']?.url ?? '',
    state: statuses.includes(state) ? state : 'Needs review',
    range, published: unpack(meta.published), previous: unpack(meta.previous), proposal: unpack(meta.proposal),
    override: meta.override, approvalRequired: meta.approvalRequired, acceptedDeadline: meta.acceptedDeadline, deadline: meta.deadline,
    control: controls.includes(control) ? control : 'Flexible', publishedControl: meta.control,
    action: actions.includes(action) ? action : undefined,
    reason: plain(p['Why this time']?.rich_text), estimate: plain(p.Duration?.rich_text),
    reviewBy: p['Review by']?.date?.start ? new Date(p['Review by'].date.start).toISOString() : undefined,
    recentMove: p['Last moved']?.date?.start ? new Date(p['Last moved'].date.start).toISOString() : undefined,
    archived: Boolean(page.archived || page.in_trash), unreadableRange: Boolean(date && !range),
  };
}

export function sessionProperties(row: Session): PageProperties {
  const meta: Stored = {
    published: pack(row.published), previous: pack(row.previous), proposal: pack(row.proposal),
    override: row.override, control: row.publishedControl, acceptedDeadline: row.acceptedDeadline, deadline: row.deadline,
    parts: row.parts ?? 1, approvalRequired: row.approvalRequired,
  };
  return {
    Name: { title: rich(row.title) },
    ...(!row.unreadableRange ? { 'Scheduled time': { date: pack(row.range) ?? null } } : {}),
    'Original task': { url: row.url || null },
    Status: { select: { name: row.state } },
    Control: { select: { name: row.control } },
    Decision: { select: row.action ? { name: row.action } : null },
    'Why this time': { rich_text: rich(row.reason) },
    Duration: { rich_text: rich(row.estimate) },
    'Review by': { date: row.reviewBy ? { start: row.reviewBy } : null },
    'Last moved': { date: row.recentMove ? { start: row.recentMove } : null },
    'Tempo ID': { rich_text: rich(row.key) },
    'Tempo state': { rich_text: rich(JSON.stringify(meta)) },
  };
}

export interface Snapshot { page?: Page; row: Session }
export async function readSessions(api: NotionApi, source: string, ids: Record<string, string>, timezone: string) {
  const snapshots = new Map<string, Snapshot>();
  for (const page of await api.pages(source)) {
    const row = readSession(page, timezone);
    if (!row || row.archived) continue;
    if (snapshots.has(row.key)) throw new Error('Duplicate Tempo IDs exist. Keep one active session for each ID before retrying.');
    snapshots.set(row.key, { page, row });
  }
  for (const [key, id] of Object.entries(ids)) {
    if (snapshots.has(key)) continue;
    try {
      const page = await api.page(id);
      const row = readSession(page, timezone);
      if (row?.archived) snapshots.set(key, { row });
      else if (row?.key === key && page.parent?.data_source_id === source) snapshots.set(key, { page, row });
      else throw new Error('A managed session was edited or moved to another database. Restore its Tempo ID and location.');
    } catch (error) {
      if (!(error instanceof NotionError) || error.status !== 404) throw error;
      snapshots.set(key, { row: { key, taskId: key.split(':')[0]!, title: '', url: '', state: 'Skipped',
        reason: '', estimate: '', control: 'Skip session', publishedControl: 'Skip session', archived: true } });
    }
  }
  return snapshots;
}
