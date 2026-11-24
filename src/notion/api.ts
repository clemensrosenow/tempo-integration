import { setTimeout as wait } from 'node:timers/promises';

export interface RichText { plain_text?: string; text?: { content: string } }
interface Option { id?: string; name: string }
export interface NotionDate { start: string; end: string | null; time_zone?: string | null }
interface Value {
  type: string;
  title?: RichText[];
  rich_text?: RichText[];
  number?: number | null;
  string?: string | null;
  url?: string | null;
  date?: NotionDate | null;
  status?: Option | null;
  select?: Option | null;
  multi_select?: Option[];
  checkbox?: boolean;
  formula?: Value;
  rollup?: Value & { array?: Value[] };
  relation?: Array<{ id: string }>;
}
export interface Property extends Value { id: string }
export interface Field {
  id: string;
  name: string;
  type: string;
  status?: { options: Option[]; groups: Array<{ name: string; option_ids: string[] }> };
  select?: { options: Option[] };
}
export interface DataSource {
  id: string;
  parent: { database_id: string };
  title?: RichText[];
  properties: Record<string, Field>;
  archived?: boolean;
  in_trash?: boolean;
}
export interface Page {
  id: string;
  url: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  parent?: { data_source_id?: string };
  properties: Record<string, Property>;
}
export interface Database {
  id: string;
  url: string;
  title: RichText[];
  description?: RichText[];
  data_sources: Array<{ id: string; name: string }>;
  archived?: boolean;
  in_trash?: boolean;
}
interface Block {
  id: string;
  type: string;
  has_children: boolean;
  [name: string]: unknown;
}
interface List<T> { results: T[]; has_more: boolean; next_cursor: string | null }
type Body = Record<string, unknown>;
export type PageProperties = Record<string, unknown>;
export const rich = (content: string): RichText[] => content ? [{ text: { content: content.slice(0, 2000) } }] : [];
export const plain = (value?: RichText[]) => value?.map(t => t.plain_text ?? t.text?.content ?? '').join('') ?? '';
export const notionId = (value: string) => {
  const id = value.split('?')[0]?.split('#')[0]?.match(/([a-f\d]{32}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\/?$/i)?.[1];
  if (!id) throw new Error('Use a Notion URL or ID.');
  return id.toLowerCase().replace(/-/g, '').replace(/^(........)(....)(....)(....)/, '$1-$2-$3-$4-');
};
export const notionLink = (id: string) => 'https://www.notion.so/' + id.replace(/-/g, '');

export class NotionError extends Error {
  constructor(readonly status: number, readonly code: string, resource: string) {
    super(`Notion ${resource} failed (${status} ${code}).`);
  }
}

export class NotionApi {
  private availableAt = 0;
  constructor(private readonly token: string, private readonly fetcher = fetch, private readonly spacingMs = 340) {}

  private async request<T>(route: string, method = 'GET', body?: Body, safe = true, version = '2025-09-03'): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const delay = this.availableAt - Date.now();
      this.availableAt = Math.max(Date.now(), this.availableAt) + this.spacingMs;
      if (delay > 0) await wait(delay);
      const response = await this.fetcher('https://api.notion.com/v1/' + route, {
        method, redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: 'Bearer ' + this.token, 'Notion-Version': version, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (response.ok) return await response.json() as T;
      const problem = await response.json().catch(() => ({})) as { code?: string };
      if (attempt < 2 && (response.status === 429 || (safe && response.status >= 500))) {
        await wait(Math.min(10_000, (Number(response.headers.get('retry-after')) || attempt + 1) * 1000));
        continue;
      }
      throw new NotionError(response.status, problem.code ?? 'request_failed', route.split('/')[0]!);
    }
  }

  private async list<T>(request: (cursor?: string) => Promise<List<T>>): Promise<T[]> {
    const result: T[] = [];
    let cursor: string | undefined;
    do {
      const list = await request(cursor);
      result.push(...list.results);
      cursor = list.has_more ? list.next_cursor ?? undefined : undefined;
    } while (cursor);
    return result;
  }

  workspace() { return this.request<{ bot?: { workspace_name?: string } }>('users/me'); }
  searchSources() {
    return this.list<DataSource>(cursor => this.request('search', 'POST', {
      filter: { property: 'object', value: 'data_source' }, start_cursor: cursor,
    }));
  }
  source(id: string) { return this.request<DataSource>('data_sources/' + id); }
  database(id: string) { return this.request<Database>('databases/' + id); }
  page(id: string) { return this.request<Page>('pages/' + id); }
  pages(id: string, filter?: Body) {
    return this.list<Page>(cursor => this.request('data_sources/' + id + '/query', 'POST', {
      start_cursor: cursor, page_size: 100, filter,
    }));
  }
  children(id: string) {
    return this.list<Block>(cursor => this.request('blocks/' + id + '/children?page_size=100' +
      (cursor ? '&start_cursor=' + encodeURIComponent(cursor) : '')));
  }
  async pageText(id: string): Promise<string> {
    let text = '';
    async function visit(api: NotionApi, parent: string, depth: number): Promise<void> {
      for (const block of await api.children(parent)) {
        const data = block[block.type] as { rich_text?: RichText[] } | undefined;
        const line = plain(data?.rich_text);
        if (line) text += '\n' + line;
        if (text.length >= 2000) return;
        if (block.has_children && depth < 2 && !['child_page', 'child_database', 'synced_block'].includes(block.type)) {
          await visit(api, block.id, depth + 1);
        }
        if (text.length >= 2000) return;
      }
    }
    await visit(this, id, 0);
    return text.slice(0, 2000);
  }

  createDatabase(parent: string, name: string, properties: PageProperties, description: string) {
    return this.request<Database>('databases', 'POST', {
      parent: { type: 'page_id', page_id: parent }, title: rich(name), description: rich(description),
      initial_data_source: { properties },
    }, false);
  }
  views(database: string) {
    return this.list<{ id: string; name: string }>(cursor => this.request('views?' + new URLSearchParams({
      database_id: database, ...(cursor ? { start_cursor: cursor } : {}),
    }), 'GET', undefined, true, '2026-03-11'));
  }
  createView(database: string, source: string, body: Body) {
    return this.request('views', 'POST', { database_id: database, data_source_id: source, ...body }, false, '2026-03-11');
  }
  createSession(source: string, properties: PageProperties) {
    return this.request<Page>('pages', 'POST', { parent: { type: 'data_source_id', data_source_id: source }, properties }, false);
  }
  updateSession(id: string, properties: PageProperties) {
    return this.request<Page>('pages/' + id, 'PATCH', { properties }, false);
  }
}
