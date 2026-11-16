/**
 * Google integration layer (Calendar, Tasks, invitations, OAuth).
 */
import type { CalendarPort, InvitePort, TasksPort } from '../core/ports.js';
import { getAuthorizedClient, readStoredToken } from './auth.js';
import { GoogleCalendarAdapter, recordSyncTokenStore, type SyncTokenStore } from './calendarAdapter.js';
import { GoogleInviteAdapter } from './inviteAdapter.js';
import { errorMessage } from './retry.js';
import { GoogleTasksAdapter } from './tasksAdapter.js';
import { createWebhookServer, startWatch, stopWatch } from './webhook.js';

export * from './auth.js';
export * from './api.js';
export * from './calendarAdapter.js';
export * from './inviteAdapter.js';
export * from './mapping.js';
export * from './retry.js';
export * from './tasksAdapter.js';
export * from './webhook.js';

export interface CreateGoogleAdaptersOptions {
  dataDir: string;
  /** IANA zone or a getter (preferences may change after onboarding). */
  timezone: string | (() => string);
  /** A SyncTokenStore, or a record mutated in place (e.g. `state.syncTokens`). */
  syncTokens?: SyncTokenStore | Record<string, string>;
  log?: (line: string) => void;
}

export interface GoogleAdapters {
  calendar: GoogleCalendarAdapter & CalendarPort;
  tasks: GoogleTasksAdapter & TasksPort;
  /** Undefined if the organizer account is not connected (`tempo login --organizer`). */
  invites?: GoogleInviteAdapter & InvitePort;
  /** Optional push mode (events.watch); needs a public HTTPS URL. Shape used by the engine daemon. */
  watch: GoogleWatchApi;
  userEmail: string;
  organizerEmail?: string;
}

export interface GoogleWatchApi {
  /** Register a push channel; `expiration` is ISO ('' if Google reported none). */
  start(calendarId: string, address: string, channelId: string): Promise<{ id: string; resourceId: string; expiration: string }>;
  stop(channelId: string, resourceId: string): Promise<void>;
  /** `onNotification` receives the calendar id (or the channel id if it cannot be resolved). */
  createServer(opts: { port: number; onNotification: (calendarOrChannelId: string) => void }): { close(): void };
}

function isTokenStore(v: SyncTokenStore | Record<string, string>): v is SyncTokenStore {
  return typeof (v as SyncTokenStore).get === 'function' && typeof (v as SyncTokenStore).set === 'function';
}

/**
 * Build all adapters from stored tokens. Throws NotSignedInError if the user
 * is not signed in; never throws because of the organizer account.
 */
export async function createGoogleAdapters(opts: CreateGoogleAdaptersOptions): Promise<GoogleAdapters> {
  const log = opts.log ?? (() => {});
  const tz = typeof opts.timezone === 'function' ? opts.timezone : (): string => opts.timezone as string;
  const syncTokens = opts.syncTokens
    ? isTokenStore(opts.syncTokens)
      ? opts.syncTokens
      : recordSyncTokenStore(opts.syncTokens)
    : undefined;

  const userClient = await getAuthorizedClient('user', opts.dataDir);
  const userToken = await readStoredToken('user', opts.dataDir);

  let invites: GoogleInviteAdapter | undefined;
  let organizerEmail: string | undefined;
  try {
    const orgToken = await readStoredToken('organizer', opts.dataDir);
    if (orgToken) {
      const orgClient = await getAuthorizedClient('organizer', opts.dataDir);
      invites = new GoogleInviteAdapter(orgClient, { timeZone: tz(), log, cancelSendUpdates: 'none' });
      if (orgToken.email) organizerEmail = orgToken.email;
    }
  } catch (err) {
    log(`google: organizer account unavailable (${errorMessage(err)}); questions disabled`);
  }

  const calendar = new GoogleCalendarAdapter(userClient, {
    log,
    ...(syncTokens ? { syncTokens } : {}),
    ...(organizerEmail ? { organizerEmail } : {}),
  });
  const tasks = new GoogleTasksAdapter(userClient, tz);
  const channelCalendars = new Map<string, string>();
  const watch: GoogleWatchApi = {
    async start(calendarId, address, channelId) {
      const ch = await startWatch(userClient, calendarId, address, channelId);
      channelCalendars.set(ch.id, calendarId);
      return { id: ch.id, resourceId: ch.resourceId, expiration: ch.expiration?.toISOString() ?? '' };
    },
    stop: (channelId, resourceId) => stopWatch(userClient, { id: channelId, resourceId }),
    createServer({ port, onNotification }) {
      const ws = createWebhookServer({
        port,
        log,
        resolveChannel: (channelId) => channelCalendars.get(channelId),
        onNotification,
      });
      ws.ready.then(
        (p) => log(`webhook: listening on 127.0.0.1:${p}`),
        (err: unknown) => log(`webhook: could not listen on port ${port}: ${errorMessage(err)}`),
      );
      return { close: () => void ws.close() };
    },
  };
  const result: GoogleAdapters = { calendar, tasks, watch, userEmail: userToken?.email ?? '' };
  if (invites) result.invites = invites;
  if (organizerEmail) result.organizerEmail = organizerEmail;
  return result;
}
