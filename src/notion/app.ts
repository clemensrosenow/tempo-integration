import { promises as fs } from 'node:fs';
import path from 'node:path';
import { formatLocal, overlaps, sameRange } from '../core/time.js';
import type { TimeRange } from '../core/types.js';
import { NotionApi, NotionError, notionId, notionLink, plain, type DataSource } from './api.js';
import { Availability } from './google.js';
import { horizon, plan, type Session } from './planner.js';
import { readSession, readSessions, sessionsDatabase, sessionViews, sessionProperties, type Snapshot } from './sessions.js';
import { type NotionSettings, type TaskMapping, writePrivateJson } from './settings.js';
import { chooseSource, mapFields, TaskReader } from './tasks.js';

interface SourceBinding { id: string; mapping: TaskMapping }
interface State {
  tasks?: SourceBinding;
  sessions?: { id: string; url: string; database: string };
  parent?: string;
  activated?: boolean;
  visible?: boolean;
  paused?: boolean;
  lastSuccess?: string;
  problem?: string;
  sessionIds: Record<string, string>;
  creating: Record<string, number>;
}
interface Preview {
  source?: SourceBinding;
  fingerprint: string;
  configured: string;
}
type BusyProvider = Pick<Availability, 'busy'>;
const taskSchema = {
  Name: { title: {} }, Done: { checkbox: {} }, Due: { date: {} }, 'Estimated Minutes': { number: { format: 'number' } },
  Priority: { select: { options: ['Critical', 'High', 'Medium', 'Low', 'Very Low'].map(name => ({ name })) } },
};
const CREATION_SETTLE_MS = 90_000;
const NO_PARENT = 'Set notion.sessionsParent to the URL of a private page shared with the Notion integration.';

async function jsonFile<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export async function exclusive<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = path.join(dir, 'planning.lock');
  const candidate = path.join(dir, `planning.${process.pid}.lock`);
  await fs.writeFile(candidate, String(process.pid), { mode: 0o600 });
  try {
    try {
      await fs.link(candidate, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      throw new Error(`Another Tempo command is running. If it exited unexpectedly, clear the stale lock at ${lock} before retrying.`);
    }
    try {
      return await fn();
    } finally {
      await fs.unlink(lock);
    }
  } finally {
    await fs.rm(candidate, { force: true });
  }
}

const comparable = (session: Session) => JSON.stringify(sessionProperties(session));
const timestamp = (date?: Date) => date?.toISOString();
const selectedCalendars = (config: NotionSettings) => [...new Set(config.google.calendars)];
const fingerprint = (rows: Session[]) => JSON.stringify(rows.map(r =>
  [r.key, r.state, timestamp(r.range?.start), timestamp(r.range?.end), r.deadline, r.estimate, r.control]).sort());
function relevant(rows: Session[], now: Date, config: NotionSettings) {
  const through = horizon(now, { ...config, horizonDays: 2 }).end;
  return rows.filter(r => r.range && r.range.start < through && r.range.end > now);
}
const definiteRejection = (error: unknown) => error instanceof NotionError && error.status < 500;

export class NotionPlanner {
  private readonly reader: TaskReader;
  private readonly stateFile: string;
  private readonly previewFile: string;

  constructor(private readonly api: NotionApi, private readonly google: () => Promise<BusyProvider>,
    dir: string, private readonly now: () => Date = () => new Date(),
    private readonly log: (text: string) => void = console.log) {
    this.reader = new TaskReader(api);
    this.stateFile = path.join(dir, 'state.json');
    this.previewFile = path.join(dir, 'preview.json');
  }

  async state(): Promise<State> {
    return await jsonFile<State>(this.stateFile) ?? { sessionIds: {}, creating: {} };
  }
  private save(state: State) { return writePrivateJson(this.stateFile, state); }

  private sourceBinding(source: DataSource, config: NotionSettings): SourceBinding {
    const { title: _title, completionType: _completionType, ...mapping } = mapFields(source, config.notion.mapping);
    return { id: source.id, mapping };
  }

  private async calculate(state: State, source: SourceBinding | undefined, config: NotionSettings, hoursOnly = false) {
    const now = this.now();
    const span = horizon(now, config);
    const availability = hoursOnly ? undefined : await this.google();
    const snapshots = state.sessions ? await readSessions(this.api, state.sessions.id, state.sessionIds, config.timezone) : new Map<string, Snapshot>();
    const taskSource = source ? await this.api.source(source.id) : undefined;
    const tasks = taskSource && source ? await this.reader.read(taskSource, mapFields(taskSource, source.mapping), config, now) : [];
    const busy = availability ? await availability.busy(selectedCalendars(config), span) : [];
    const rows = plan(tasks, [...snapshots.values()].map(s => s.row), busy, now, config);
    return { now, span, availability, busy, snapshots, rows, tasks };
  }

  async preview(config: NotionSettings, hoursOnly = false) {
    const state = await this.state();
    const source = state.tasks && !config.notion.taskSource ? await this.api.source(state.tasks.id) : await chooseSource(this.api, config);
    if (state.tasks && source?.id !== state.tasks.id) throw new Error('This Tempo installation is already bound to a different task database.');
    if (!source && !config.notion.createTasksIfMissing) {
      throw new Error('No database is visible to the Notion token. Share the existing task database, or set createTasksIfMissing only for a workspace with no task database.');
    }
    const binding = source && this.sourceBinding(source, config);
    const parent = config.notion.sessionsParent ? notionId(config.notion.sessionsParent) : state.parent;
    if (state.parent && parent !== state.parent) throw new Error('This Tempo installation is already bound to a different Sessions page.');
    if (parent) await this.api.page(parent);
    const { now, rows, tasks } = await this.calculate(state, binding, config, hoursOnly);
    const name = source ? plain(source.title) || 'Tasks' : 'New Tasks database';
    const workspace = (await this.api.workspace()).bot?.workspace_name;
    this.log(`${hoursOnly ? 'Working-hours preview · Google availability is not connected' : 'Conflict-aware preview'} · ${workspace ?? 'Notion'} · ${name} · ${config.timezone}`);
    if (source) this.log(notionLink(source.parent.database_id));
    const completion = source && Object.values(source.properties).find(field => field.id === binding?.mapping.completion);
    if (completion) {
      const finished = (completion.status?.options ?? completion.select?.options ?? [])
        .filter(option => binding?.mapping.done?.includes(option.id ?? option.name)).map(option => option.name);
      this.log(`Completion rule · ${completion.name}: ${finished.join(', ') || 'checked'}`);
    }
    const sample = [...tasks].sort((a, b) => b.priority - a.priority).slice(0, 3);
    for (const task of sample) this.log(`  ${task.title} · priority ${task.priority}/5 · ${task.duration} min${task.estimated ? ' estimated' : ''}`);
    for (const row of relevant(rows, now, config).sort((a, b) => +a.range!.start - +b.range!.start)) {
      this.log(`  ${formatLocal(row.range!.start, config.timezone)}–${formatLocal(row.range!.end, config.timezone, 'HH:mm')} · ${row.title}`);
    }
    const planned = rows.filter(r => r.range && r.range.end > now).length;
    const needsTime = rows.filter(r => ['Needs time', 'Needs review', 'Skipped'].includes(r.state)).length;
    this.log(`${planned} upcoming sessions · ${needsTime} need attention`);
    if (!tasks.length) this.log('Nothing to plan yet. Add an open task with a title to the selected database.');
    if (!parent) this.log(NO_PARENT);
    if (!hoursOnly) {
      await writePrivateJson(this.previewFile, { source: binding,
        fingerprint: fingerprint(relevant(rows, now, config)), configured: fingerprintConfig(config) } satisfies Preview);
      this.log(state.activated ? 'Run npm run notion -- resume to apply this plan and resume automation.' :
        'Run npm run notion -- start to approve this preview.');
    }
  }

  private async createOnce<T>(state: State, key: string, create: () => Promise<T>, record: (value: T) => void) {
    if (Date.now() - (state.creating[key] ?? 0) < CREATION_SETTLE_MS) {
      throw new Error('A previous Notion creation might still be settling. Tempo will check again before retrying.');
    }
    state.creating[key] = Date.now();
    await this.save(state);
    try {
      const value = await create();
      record(value);
      delete state.creating[key];
      await this.save(state);
      return value;
    } catch (error) {
      if (definiteRejection(error)) {
        delete state.creating[key];
        await this.save(state);
      }
      throw error;
    }
  }

  async start(config: NotionSettings) {
    const state = await this.state();
    if (state.activated) throw new Error('Tempo has already started. Use resume or watch.');
    const preview = await this.approvedPreview(config);
    const parent = config.notion.sessionsParent ? notionId(config.notion.sessionsParent) : state.parent;
    if (!parent) throw new Error(NO_PARENT);
    const source = state.tasks ?? preview.source;
    const calculation = await this.calculate(state, source, config);
    this.checkPreview(calculation, preview, config, state);
    state.parent = parent;
    if (!source) {
      // Repeat full discovery after approval and before creating any tasks database.
      const newlyVisible = await chooseSource(this.api, config);
      if (newlyVisible && !state.creating['task-database']) {
        throw new Error('A task database is now visible. Run setup again to preview it.');
      }
      if (newlyVisible) {
        const db = await this.api.database(newlyVisible.parent.database_id);
        const matches = (await this.api.children(parent)).some(b => b.id === db.id);
        if (!matches || plain(db.title) !== 'Tempo Tasks' || plain(db.description) !== taskDescription) {
          throw new Error('A task database is now visible. Run setup again to preview it.');
        }
        state.tasks = this.sourceBinding(newlyVisible, config);
        delete state.creating['task-database'];
        await this.save(state);
      } else {
        await this.createOnce(state, 'task-database', () => this.api.createDatabase(parent, 'Tempo Tasks', taskSchema, taskDescription),
          db => { state.tasks = { id: db.data_sources[0]!.id, mapping: config.notion.mapping }; });
      }
      this.log(`Task database ready · ${notionLink(state.tasks!.id)}`);
      this.log('Add an open task, then run setup to preview its first session.');
      return;
    }
    state.tasks = source;
    if (!calculation.tasks.length) {
      await this.save(state);
      this.log('Nothing to plan yet. Add an open task, then run setup and start.');
      return;
    }
    state.sessions ??= await sessionsDatabase(this.api, parent, false);
    if (state.sessions) delete state.creating['sessions-database'];
    else {
      await this.createOnce(state, 'sessions-database', async () => {
        const db = await sessionsDatabase(this.api, parent, true);
        if (!db) throw new Error('Tempo Sessions could not be created.');
        return db;
      }, db => { state.sessions = db; });
    }
    await this.save(state);
    await sessionViews(this.api, state.sessions!.database, await this.api.source(state.sessions!.id),
      async (name, exists, create) => {
        const key = 'view:' + name;
        if (!exists) return this.createOnce(state, key, create, () => {});
        delete state.creating[key];
      });
    await this.save(state);
    const result = await this.calculate(state, source, config);
    this.checkPreview(result, preview, config, state);
    await this.publish(state, result, config);
    state.activated = true;
    await this.save(state);
    this.log(`Tempo Sessions · ${state.sessions!.url}`);
    const sample = result.rows.filter(row => row.range && row.range.start >= result.now)
      .sort((a, b) => +a.range!.start - +b.range!.start)[0];
    if (sample) {
      this.log(`Open in Notion Calendar on desktop or web using Scheduled time. Look for “${sample.title}”.`);
      this.log('Once you can see the session, run npm run notion -- visible to enable rolling scheduling.');
    } else {
      state.visible = true;
      await this.save(state);
      this.log('No session fits right now. Review Needs attention in Tempo Sessions. Rolling scheduling is enabled.');
    }
  }

  private async approvedPreview(config: NotionSettings) {
    const preview = await jsonFile<Preview>(this.previewFile);
    if (!preview || preview.configured !== fingerprintConfig(config)) throw new Error('Run npm run notion -- setup to preview the current settings first.');
    return preview;
  }

  private checkPreview(result: Awaited<ReturnType<NotionPlanner['calculate']>>, preview: Preview, config: NotionSettings, state: State) {
    const current = fingerprint(relevant(result.rows, result.now, config));
    if (preview.fingerprint !== current && !Object.keys(state.sessionIds).length) {
      throw new Error('The next two days changed since the preview. Run setup again to review the updated plan.');
    }
  }

  async recordFailure(problem: string) {
    const state = await this.state();
    if (!state.activated || state.paused || state.problem === problem) return;
    state.problem = problem;
    await this.save(state);
  }

  async update(config: NotionSettings, resume = false) {
    const state = await this.state();
    if (!state.activated || !state.tasks || !state.sessions) throw new Error('Run setup and start first.');
    if (config.notion.taskSource && ![state.tasks.id, (await this.api.source(state.tasks.id)).parent.database_id].includes(notionId(config.notion.taskSource))) {
      throw new Error('The configured source differs from the active task database.');
    }
    if (config.notion.sessionsParent && notionId(config.notion.sessionsParent) !== state.parent) throw new Error('The configured Sessions page differs from the active one.');
    if (resume) {
      const preview = await this.approvedPreview(config);
      if (preview.source?.id !== state.tasks.id) throw new Error('The approved preview uses a different task database.');
      state.tasks = preview.source;
    }
    if (!state.visible) throw new Error('Run npm run notion -- visible after checking Tempo Sessions in Notion Calendar.');
    if (state.paused && !resume) return;
    const result = await this.calculate(state, state.tasks, config);
    if (resume) this.checkPreview(result, await this.approvedPreview(config), config, { ...state, sessionIds: {} });
    await this.publish(state, result, config);
    if (resume) state.paused = false;
    delete state.problem;
    await this.save(state);
  }

  async setFlag(flag: 'paused' | 'visible') {
    const state = await this.state();
    if (!state.activated) throw new Error('Run setup and start first.');
    state[flag] = true;
    await this.save(state);
    this.log(flag === 'visible' ? 'Calendar visibility confirmed. Run npm run notion -- watch to keep the plan current.' :
      'Planning is paused. The published sessions stay visible. Run setup and resume when ready.');
  }

  async disconnect(config: NotionSettings, clear: boolean) {
    const state = await this.state();
    if (clear && state.sessions) {
      const now = this.now();
      const snapshots = await readSessions(this.api, state.sessions.id, state.sessionIds, config.timezone);
      for (const { page, row } of snapshots.values()) {
        if (!page || (!row.unreadableRange && (!row.range || row.range.start < now))) continue;
        const newest = await this.api.page(page.id);
        if (newest.last_edited_time !== page.last_edited_time) throw new Error('A session changed during cleanup. Retry to finish.');
        await this.api.updateSession(page.id, { 'Scheduled time': { date: null } });
      }
    }
    await fs.rm(this.previewFile, { force: true });
    await fs.rm(this.stateFile, { force: true });
  }

  private async publish(state: State, calculated: Awaited<ReturnType<NotionPlanner['calculate']>>, config: NotionSettings) {
    const { rows, snapshots, availability, span, busy } = calculated;
    const source = state.sessions!.id;
    if (!availability) throw new Error('Connect Google availability before publishing.');
    for (const [key, snap] of snapshots) {
      if (!snap.page) continue;
      state.sessionIds[key] = snap.page.id;
      delete state.creating[key];
    }
    if (Object.values(state.creating).some(when => Date.now() - when < CREATION_SETTLE_MS)) {
      throw new Error('A previous Notion creation might still be settling. Tempo will recheck before retrying.');
    }
    const changes = rows.filter(row => !snapshots.get(row.key)?.page || comparable(row) !== comparable(snapshots.get(row.key)!.row));
    if (!changes.length) {
      state.lastSuccess = this.now().toISOString();
      return;
    }
    const latest = await readSessions(this.api, source, state.sessionIds, config.timezone);
    if (latest.size !== snapshots.size || [...latest].some(([key, snap]) => !matches(snap, snapshots.get(key)))) {
      throw new Error('A Notion session changed during planning. Retry to use the newest edits.');
    }
    const fresh = await availability.busy(selectedCalendars(config), span);
    const ranges = (list: TimeRange[]) => list.map(r => +r.start + ':' + +r.end).sort().join('|');
    if (ranges(fresh) !== ranges(busy)) throw new Error('Calendar availability changed during planning. Retry to repair around the new busy times.');

    const occupied = new Map([...snapshots.values()].flatMap(s => s.row.range ? [[s.row.key, s.row.range] as const] : []));
    const remaining = [...changes];
    let written = 0;
    while (remaining.length) {
      const index = remaining.findIndex(row => !row.range || unchangedTime(row, snapshots.get(row.key)?.row) ||
        ![...occupied].some(([key, r]) => key !== row.key && overlaps(r, row.range!)));
      if (index < 0) throw new Error('A group of session moves could not be applied safely. Retry after reviewing conflicting sessions.');
      const [row] = remaining.splice(index, 1) as [Session];
      const prior = snapshots.get(row.key);
      const oldPage = prior?.page;
      if (row.range && !unchangedTime(row, prior?.row) && row.range.start < this.now()) {
        throw new Error('A planned opening has passed. Retry for a current plan.');
      }
      const props = sessionProperties(row);
      if (oldPage) {
        const newest = await this.api.page(oldPage.id);
        const liveRow = readSession(newest, config.timezone);
        if (!liveRow || liveRow.archived || newest.last_edited_time !== oldPage.last_edited_time || comparable(liveRow) !== comparable(prior.row)) {
          throw new Error('A Notion session changed before publishing. Retry to keep the newest edit.');
        }
        await this.api.updateSession(oldPage.id, props);
      } else {
        await this.createOnce(state, row.key, () => this.api.createSession(source, props),
          page => { state.sessionIds[row.key] = page.id; });
      }
      if (row.range) occupied.set(row.key, row.range);
      else occupied.delete(row.key);
      written++;
    }
    state.lastSuccess = this.now().toISOString();
    this.log(`Updated ${written} Tempo Sessions row${written === 1 ? '' : 's'}.`);
  }
}

const taskDescription = 'Tempo starter task database. Add work here and mark its Done checkbox when complete.';
const fingerprintConfig = (config: NotionSettings) => JSON.stringify({ ...config,
  notion: { ...config.notion, sessionsParent: undefined } });
const matches = (a: Snapshot, b?: Snapshot) => b && a.page?.id === b.page?.id &&
  a.page?.last_edited_time === b.page?.last_edited_time && comparable(a.row) === comparable(b.row);
const unchangedTime = (a: Session, b?: Session) => a.range && b?.range && sameRange(a.range, b.range);
