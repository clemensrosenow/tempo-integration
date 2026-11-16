/**
 * TasksPort implementation on the Google Tasks API (read-only, polled — the
 * Tasks API has no push notifications).
 *
 * Per task list two queries are made:
 *  1. open tasks: showCompleted=false
 *  2. recently completed: showCompleted=true, showHidden=true, completedMin=now-N days
 * because `completedMin` filters on the completion date, which open tasks do not
 * have, and tasks completed in Google's own apps are flagged `hidden`.
 * Results are merged by id; deleted tasks are skipped.
 */
import type { OAuth2Client } from 'google-auth-library';
import type { Task } from '../core/types.js';
import type { TasksPort } from '../core/ports.js';
import { createTasksApi, type TasksApi, type tasks_v1 } from './api.js';
import { fromGoogleTask } from './mapping.js';
import { withRetry, type RetryOptions } from './retry.js';

export interface GoogleTasksAdapterOptions {
  api?: TasksApi;
  retry?: RetryOptions;
  now?: () => Date;
}

export const DEFAULT_COMPLETED_SINCE_DAYS = 7;

export class GoogleTasksAdapter implements TasksPort {
  private readonly api: TasksApi;
  private readonly getTimezone: () => string;
  private readonly retryOpts: RetryOptions;
  private readonly now: () => Date;

  constructor(client: OAuth2Client | null, getTimezone: () => string, opts: GoogleTasksAdapterOptions = {}) {
    if (opts.api) this.api = opts.api;
    else if (client) this.api = createTasksApi(client);
    else throw new Error('GoogleTasksAdapter needs an OAuth2Client or an injected api');
    this.getTimezone = getTimezone;
    this.retryOpts = opts.retry ?? {};
    this.now = opts.now ?? (() => new Date());
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, this.retryOpts);
  }

  async listTaskLists(): Promise<tasks_v1.Schema$TaskList[]> {
    const out: tasks_v1.Schema$TaskList[] = [];
    let pageToken: string | undefined;
    do {
      const params: tasks_v1.Params$Resource$Tasklists$List = { maxResults: 100 };
      if (pageToken) params.pageToken = pageToken;
      const { data } = await this.call(() => this.api.tasklists.list(params));
      out.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async listTasks(opts: { completedSinceDays?: number } = {}): Promise<Task[]> {
    const days = opts.completedSinceDays ?? DEFAULT_COMPLETED_SINCE_DAYS;
    const completedMin = new Date(this.now().getTime() - days * 86_400_000);
    const tz = this.getTimezone();
    const out: Task[] = [];

    for (const list of await this.listTaskLists()) {
      if (!list.id) continue;
      const listId = list.id;
      const byId = new Map<string, Task>();
      const add = (items: tasks_v1.Schema$Task[]): void => {
        for (const item of items) {
          const task = fromGoogleTask(item, listId, tz);
          if (!task) continue;
          if (task.status === 'completed' && (!task.completedAt || task.completedAt < completedMin)) continue;
          byId.set(task.id, task);
        }
      };
      add(await this.listPages({ tasklist: listId, showCompleted: false, showHidden: true }));
      if (days > 0) {
        add(
          await this.listPages({
            tasklist: listId,
            showCompleted: true,
            showHidden: true,
            completedMin: completedMin.toISOString(),
          }),
        );
      }
      out.push(...byId.values());
    }
    return out;
  }

  private async listPages(base: tasks_v1.Params$Resource$Tasks$List): Promise<tasks_v1.Schema$Task[]> {
    const out: tasks_v1.Schema$Task[] = [];
    let pageToken: string | undefined;
    do {
      const params: tasks_v1.Params$Resource$Tasks$List = { ...base, showDeleted: false, maxResults: 100 };
      if (pageToken) params.pageToken = pageToken;
      const { data } = await this.call(() => this.api.tasks.list(params));
      out.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }
}
