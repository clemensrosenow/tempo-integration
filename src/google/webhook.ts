/**
 * OPTIONAL push mode for Google Calendar (events.watch).
 *
 * Google only delivers notifications to a public HTTPS address with a valid
 * (CA-signed, hostname-matching) certificate, so a local machine needs a tunnel
 * (e.g. cloudflared / ngrok) in front of `createWebhookServer`. Channels expire
 * and are not renewed automatically. The default change-detection mode is
 * therefore polling with sync tokens (GoogleCalendarAdapter.listChanges); a
 * notification only tells "something changed in calendar X" — the engine then
 * calls listChanges(X).
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { OAuth2Client } from 'google-auth-library';
import { createCalendarApi, type CalendarApi, type calendar_v3 } from './api.js';
import { withRetry } from './retry.js';

export interface WatchChannel {
  id: string;
  resourceId: string;
  calendarId: string;
  /** Absent if Google did not report one. */
  expiration?: Date;
}

export interface StartWatchOptions {
  /** Echoed in X-Goog-Channel-Token; used to reject forged notifications. */
  token?: string;
  /** Requested channel lifetime in seconds (Google may cap it). */
  ttlSeconds?: number;
  api?: CalendarApi;
}

function apiFor(client: OAuth2Client | null, api: CalendarApi | undefined): CalendarApi {
  if (api) return api;
  if (!client) throw new Error('webhook: need an OAuth2Client or an injected api');
  return createCalendarApi(client);
}

/** Register a push channel for events in `calendarId`. `address` must be public HTTPS. */
export async function startWatch(
  client: OAuth2Client | null,
  calendarId: string,
  address: string,
  channelId: string,
  opts: StartWatchOptions = {},
): Promise<WatchChannel> {
  if (!address.startsWith('https://')) {
    throw new Error(`Google push notifications require a public HTTPS address (got ${address})`);
  }
  const requestBody: calendar_v3.Schema$Channel = { id: channelId, type: 'web_hook', address };
  if (opts.token) requestBody.token = opts.token;
  if (opts.ttlSeconds !== undefined) requestBody.params = { ttl: String(opts.ttlSeconds) };
  const api = apiFor(client, opts.api);
  const { data } = await withRetry(() => api.events.watch({ calendarId, requestBody }));
  if (!data.id || !data.resourceId) throw new Error('events.watch returned no channel id/resourceId');
  const channel: WatchChannel = { id: data.id, resourceId: data.resourceId, calendarId };
  const exp = data.expiration ? Number(data.expiration) : NaN;
  if (Number.isFinite(exp)) channel.expiration = new Date(exp);
  return channel;
}

/** Stop a channel (needs both id and resourceId). */
export async function stopWatch(
  client: OAuth2Client | null,
  channel: Pick<WatchChannel, 'id' | 'resourceId'>,
  opts: { api?: CalendarApi } = {},
): Promise<void> {
  const api = apiFor(client, opts.api);
  await withRetry(() => api.channels.stop({ requestBody: { id: channel.id, resourceId: channel.resourceId } }));
}

// ---------------------------------------------------------------------------
// Receiver
// ---------------------------------------------------------------------------

const RESOURCE_STATES = new Set(['sync', 'exists', 'not_exists']);

export interface WebhookServerOptions {
  port: number;
  host?: string;
  /** Called (asynchronously, after the 200 response) for 'exists'/'not_exists' notifications. */
  onNotification(calendarId: string): void | Promise<void>;
  /** Map channel id → calendar id. Fallback: parse X-Goog-Resource-URI. */
  resolveChannel?: (channelId: string) => string | undefined;
  /** If set, X-Goog-Channel-Token must equal it. */
  token?: string;
  log?: (line: string) => void;
}

export interface WebhookServer {
  server: Server;
  /** Resolves with the bound port once listening. */
  ready: Promise<number>;
  close(): Promise<void>;
}

function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** Calendar id from ".../calendar/v3/calendars/<id>/events?..." */
export function calendarIdFromResourceUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const m = /\/calendars\/([^/?]+)\/events/.exec(uri);
  if (!m?.[1]) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return undefined;
  }
}

export function createWebhookServer(opts: WebhookServerOptions): WebhookServer {
  const log = opts.log ?? (() => {});
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume(); // body is empty for Calendar notifications; drain anyway
    const channelId = header(req, 'x-goog-channel-id');
    const state = header(req, 'x-goog-resource-state');
    if (req.method !== 'POST' || !channelId || !state || !RESOURCE_STATES.has(state)) {
      res.writeHead(400).end();
      return;
    }
    if (opts.token !== undefined && header(req, 'x-goog-channel-token') !== opts.token) {
      res.writeHead(403).end();
      return;
    }
    // Acknowledge immediately; Google retries on 5xx with backoff.
    res.writeHead(200).end();
    if (state === 'sync') return; // handshake after events.watch, no change yet

    const calendarId =
      opts.resolveChannel?.(channelId) ?? calendarIdFromResourceUri(header(req, 'x-goog-resource-uri'));
    if (!calendarId) {
      log(`webhook: notification for unknown channel ${channelId}`);
      return;
    }
    setImmediate(() => {
      Promise.resolve()
        .then(() => opts.onNotification(calendarId))
        .catch((err: unknown) => log(`webhook: handler failed: ${err instanceof Error ? err.message : String(err)}`));
    });
  });

  const ready = new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });

  return {
    server,
    ready,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
