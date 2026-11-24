import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { OAuth2Client } from 'google-auth-library';
import { NotionApi, plain, rich, type Page, type PageProperties } from '../../src/notion/api.js';
import { NotionPlanner } from '../../src/notion/app.js';
import { Availability } from '../../src/notion/google.js';
import { readSession } from '../../src/notion/sessions.js';
import { readNotionSettings } from '../../src/notion/settings.js';

const parent = '11111111-1111-1111-1111-111111111111';
const source = '22222222-2222-2222-2222-222222222222';
const db = '33333333-3333-3333-3333-333333333333';
const sessionSource = '44444444-4444-4444-4444-444444444444';
const sessionDb = '55555555-5555-5555-5555-555555555555';
const config = await readNotionSettings('/nonexistent-tempo-test-settings.json');
const at = new Date('2026-11-23T08:50:00Z');

function sourcePage(id: string, name: string): Page {
  return {
    id, url: 'https://www.notion.so/' + id, last_edited_time: '2026-11-20T12:00:00Z',
    properties: {
      Name: { id: 'title', type: 'title', title: rich(name) },
      State: { id: 'stat', type: 'status', status: { id: 'open', name: 'To do' } },
      'Estimated Minutes': { id: 'mins', type: 'number', number: null },
      Priority: { id: 'prio', type: 'select', select: null },
      Project: { id: 'proj', type: 'relation', relation: [{ id: 'project-id' }] },
      Area: { id: 'area', type: 'relation', relation: [{ id: 'area-id' }] },
    },
  };
}

it('previews without writes, publishes only in Notion, recovers a lost response and reconciles a user drag', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tempo-notion-'));
  const task = sourcePage('task-1', 'Review client proposal');
  const second = sourcePage('task-2', 'Process bills for 30 min');
  const status = { options: [{ id: 'open', name: 'To do' }, { id: 'done', name: 'Delivered' }],
    groups: [{ name: 'Complete', option_ids: ['done'] }] };
  const sourceData = {
    id: source, parent: { database_id: db }, title: rich('Tasks'), properties: {
      Name: { id: 'title', name: 'Name', type: 'title' },
      State: { id: 'stat', name: 'State', type: 'status', status },
      'Estimated Minutes': { id: 'mins', name: 'Estimated Minutes', type: 'number' },
      Priority: { id: 'prio', name: 'Priority', type: 'select' },
      Project: { id: 'proj', name: 'Project', type: 'relation' },
      Area: { id: 'area', name: 'Area', type: 'relation' },
    },
  };
  const sessionPages: Page[] = [];
  const views: Array<{ name: string; id: string }> = [];
  const writes: string[] = [];
  const logs: string[] = [];
  let created = false;
  let lost = true;
  let busy = [{ start: '2026-11-23T09:00:00Z', end: '2026-11-23T10:00:00Z' }];
  let unavailable = false;
  let sessionFields: PageProperties = {};
  let edited = 0;
  const list = (results: unknown[]) => ({ results, has_more: false, next_cursor: null });
  const database = () => ({ id: sessionDb, url: 'https://www.notion.so/' + sessionDb, data_sources: [{ id: sessionSource }] });
  const merged = (page: Page, props: PageProperties) => {
    for (const [name, value] of Object.entries(props)) {
      const field = value as Record<string, unknown>;
      page.properties[name] = { id: name, type: Object.keys(field)[0]!, ...field };
    }
    page.last_edited_time = new Date(+at + ++edited * 1000).toISOString();
    return page;
  };
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(input as string);
    const route = url.pathname.slice(4);
    const method = init?.method;
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const respond = (value: unknown) => Response.json(value);
    if (route === 'search') return respond(list([sourceData]));
    if (route === 'users/me') return respond({ bot: { workspace_name: 'Test workspace' } });
    if (route === 'data_sources/' + source) return respond(sourceData);
    if (route === 'data_sources/' + source + '/query') return respond(list([task, second]));
    if (route === 'data_sources/' + sessionSource + '/query') return respond(list(sessionPages));
    if (route === 'data_sources/' + sessionSource) return respond({ id: sessionSource,
      properties: Object.fromEntries(Object.entries(sessionFields).map(([name, schema]) =>
        [name, { id: name, name, type: Object.keys(schema as object)[0] }])) });
    if (route === 'pages/' + parent) return respond({ id: parent, properties: {} });
    if (route === 'blocks/' + parent + '/children') return respond(list(created ?
      [{ id: sessionDb, type: 'child_database', child_database: { title: 'Tempo Sessions' } }] : []));
    if (route === 'blocks/task-1/children') return respond(list([{ type: 'paragraph',
      paragraph: { rich_text: rich('Duration 1h 15m\nPriority: High') } }]));
    if (route === 'blocks/task-2/children') return respond(list([]));
    if (route === 'databases' && method === 'POST') {
      writes.push('database');
      expect(plain(body.title)).toBe('Tempo Sessions');
      sessionFields = body.initial_data_source.properties;
      created = true;
      return respond(database());
    }
    if (route === 'databases/' + sessionDb) return respond(database());
    if (route === 'views' && method === 'GET') return respond(list(views));
    if (route === 'views' && method === 'POST') {
      writes.push('view');
      expect(body.database_id).toBe(sessionDb);
      if (body.type === 'calendar') expect(body.configuration.date_property_id).toBe('Scheduled time');
      const view = { name: body.name, id: 'view-' + views.length };
      views.push(view);
      return respond(view);
    }
    if (route === 'pages' && method === 'POST') {
      expect(body.parent.data_source_id).toBe(sessionSource);
      writes.push('session');
      const page = merged({ id: 'session-' + sessionPages.length, url: '', last_edited_time: '', properties: {},
        parent: { data_source_id: sessionSource } }, body.properties);
      sessionPages.push(page);
      if (lost) {
        lost = false;
        throw new Error('Connection dropped after the create reached Notion');
      }
      return respond(page);
    }
    const page = sessionPages.find(p => route === 'pages/' + p.id);
    if (page) {
      if (method === 'PATCH') {
        writes.push('session update');
        return respond(merged(page, body.properties));
      }
      return respond(page);
    }
    throw new Error('Unexpected request ' + method + ' ' + route);
  };
  const google = new Availability({ request: async (req: { method: string; url: string }) => {
    expect(req.url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
    expect(req.method).toBe('POST');
    if (unavailable) throw Error('Google credentials expired');
    return { data: { calendars: { primary: { busy } } } };
  } } as Pick<OAuth2Client, 'request'>);

  try {
    const settings = { ...config, notion: { ...config.notion, sessionsParent: parent } };
    const app = new NotionPlanner(new NotionApi('simulated-token', transport, 0), async () => google, dir, () => at, line => logs.push(line));
    await app.preview(settings, true);
    expect(writes).toEqual([]);
    await expect(app.start(settings)).rejects.toThrow('preview');
    await app.preview(settings);
    expect(writes).toEqual([]);
    expect(logs.join('\n')).toContain('priority 4/5 · 75 min estimated');
    await expect(app.start(settings)).rejects.toThrow('Connection dropped');
    await app.start(settings);
    expect(writes.filter(write => write === 'database')).toHaveLength(1);
    expect(writes.filter(write => write === 'view')).toHaveLength(3);
    expect(sessionPages).toHaveLength(2);
    await expect(app.update(settings)).rejects.toThrow('visible');
    await app.setFlag('visible');
    const noOp = writes.length;
    await app.update(settings);
    expect(writes).toHaveLength(noOp);
    const proposal = sessionPages.find(page => readSession(page, settings.timezone)?.key === task.id)!;
    busy = [...busy, { start: '2026-11-23T10:05:00Z', end: '2026-11-23T12:00:00Z' }];
    await app.update(settings);
    expect(readSession(proposal, settings.timezone)?.range?.start.toISOString()).not.toBe('2026-11-23T10:05:00.000Z');
    const pinned = { start: '2026-11-23T13:00:00Z', end: '2026-11-23T14:15:00Z' };
    merged(proposal, { 'Scheduled time': { date: pinned } });
    await app.update(settings);
    expect(readSession(proposal, settings.timezone)?.control).toBe('Pinned');
    const beforeFailure = writes.length;
    unavailable = true;
    await expect(app.update(settings)).rejects.toThrow('availability is unavailable');
    expect(writes).toHaveLength(beforeFailure);
    unavailable = false;
    task.properties.State!.status = { id: 'done', name: 'Delivered' };
    await app.update(settings);
    expect(readSession(proposal, settings.timezone)).toMatchObject({ state: 'Closed', range: undefined });
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
});
