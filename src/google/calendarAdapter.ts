/**
 * CalendarPort implementation on the Google Calendar API (user account).
 *
 * - Reads every selected calendar (E13), writes ONLY to the Tempo calendar.
 * - Tempo blocks: no reminders, opaque, `sendUpdates: 'none'` (no attendees anyway).
 * - Incremental sync via sync tokens with 410 GONE → full resync.
 */
import type { OAuth2Client } from 'google-auth-library';
import type { BlockDraft, CalendarEvent, CalendarInfo, TimeRange } from '../core/types.js';
import type { CalendarPort, EventsDelta } from '../core/ports.js';
import { createCalendarApi, type CalendarApi, type calendar_v3 } from './api.js';
import {
  PROP,
  TEMPO_CALENDAR_COLOR,
  TEMPO_CALENDAR_DESCRIPTION,
  TEMPO_CALENDAR_SUMMARY,
  eventTime,
  fromCalendarListEntry,
  fromGoogleEvent,
  isTempoCalendarEntry,
  parseBlockDescription,
  renderBlockDescription,
  toGoogleEvent,
} from './mapping.js';
import { randomBytes } from 'node:crypto';
import { errorMessage, isStatus, withRetry, type RetryOptions } from './retry.js';

/** Where sync tokens live (e.g. `TempoState.syncTokens`). `undefined` clears the token. */
export interface SyncTokenStore {
  get(calendarId: string): string | undefined | Promise<string | undefined>;
  set(calendarId: string, token: string | undefined): void | Promise<void>;
}

/** SyncTokenStore backed by a plain record, mutated in place (pass `state.syncTokens`). */
export function recordSyncTokenStore(record: Record<string, string>): SyncTokenStore {
  return {
    get: (id) => record[id],
    set: (id, token) => {
      if (token === undefined) delete record[id];
      else record[id] = token;
    },
  };
}

export interface GoogleCalendarAdapterOptions {
  /** Inject an API object (tests). Defaults to googleapis Calendar v3 on the given client. */
  api?: CalendarApi;
  syncTokens?: SyncTokenStore;
  log?: (line: string) => void;
  retry?: RetryOptions;
  /** Email of the Tempo organizer account; tightens the "Tempo asks:" title fallback. */
  organizerEmail?: string;
  /** Initial full sync (no sync token) starts this many days before now. Default 7. */
  fullSyncLookbackDays?: number;
  /** Clock (tests). */
  now?: () => Date;
}

export class GoogleCalendarAdapter implements CalendarPort {
  private readonly api: CalendarApi;
  private readonly syncTokens: SyncTokenStore;
  private readonly log: (line: string) => void;
  private readonly retryOpts: RetryOptions;
  private readonly organizerEmail: string | undefined;
  private readonly lookbackDays: number;
  private readonly now: () => Date;
  private userEmail: string | undefined;

  constructor(client: OAuth2Client | null, opts: GoogleCalendarAdapterOptions = {}) {
    if (opts.api) this.api = opts.api;
    else if (client) this.api = createCalendarApi(client);
    else throw new Error('GoogleCalendarAdapter needs an OAuth2Client or an injected api');
    this.syncTokens = opts.syncTokens ?? recordSyncTokenStore({});
    this.log = opts.log ?? (() => {});
    this.retryOpts = opts.retry ?? {};
    this.organizerEmail = opts.organizerEmail;
    this.lookbackDays = opts.fullSyncLookbackDays ?? 7;
    this.now = opts.now ?? (() => new Date());
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, this.retryOpts);
  }

  private mapEvent(ev: calendar_v3.Schema$Event, calendarId: string, timeZone?: string | null): CalendarEvent | null {
    return fromGoogleEvent(ev, calendarId, {
      ...(timeZone ? { timeZone } : {}),
      ...(this.organizerEmail !== undefined ? { organizerEmail: this.organizerEmail } : {}),
    });
  }

  async getUserEmail(): Promise<string> {
    if (this.userEmail) return this.userEmail;
    const { data } = await this.call(() => this.api.calendars.get({ calendarId: 'primary' }));
    if (!data.id) throw new Error('Could not determine the user email from the primary calendar');
    this.userEmail = data.id;
    return data.id;
  }

  private async listCalendarEntries(): Promise<calendar_v3.Schema$CalendarListEntry[]> {
    const out: calendar_v3.Schema$CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const params: calendar_v3.Params$Resource$Calendarlist$List = { maxResults: 250 };
      if (pageToken) params.pageToken = pageToken;
      const { data } = await this.call(() => this.api.calendarList.list(params));
      out.push(...(data.items ?? []));
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    return out;
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const entries = await this.listCalendarEntries();
    return entries.map(fromCalendarListEntry).filter((c): c is CalendarInfo => c !== null);
  }

  async ensureTempoCalendar(timeZone: string): Promise<string> {
    const entries = await this.listCalendarEntries();
    const owned = entries.filter((e) => e.accessRole === 'owner');
    const existing =
      owned.find(isTempoCalendarEntry) ?? owned.find((e) => e.summary === TEMPO_CALENDAR_SUMMARY && !e.primary);
    if (existing?.id) {
      if (!isTempoCalendarEntry(existing)) {
        this.log(`google: adopting existing calendar "${TEMPO_CALENDAR_SUMMARY}" (${existing.id}) as Tempo calendar`);
      }
      return existing.id;
    }

    const { data } = await this.call(() =>
      this.api.calendars.insert({
        requestBody: { summary: TEMPO_CALENDAR_SUMMARY, description: TEMPO_CALENDAR_DESCRIPTION, timeZone },
      }),
    );
    const id = data.id;
    if (!id) throw new Error('calendars.insert returned no id');
    this.log(`google: created Tempo calendar ${id}`);

    const listBody: calendar_v3.Schema$CalendarListEntry = { ...TEMPO_CALENDAR_COLOR, selected: true };
    try {
      await this.call(() =>
        this.api.calendarList.patch({ calendarId: id, colorRgbFormat: true, requestBody: listBody }),
      );
    } catch (err) {
      if (!isStatus(err, 404)) {
        this.log(`google: could not colour the Tempo calendar: ${errorMessage(err)}`);
        return id;
      }
      // Not (yet) in the calendar list → add it with the colour.
      try {
        await this.call(() =>
          this.api.calendarList.insert({ colorRgbFormat: true, requestBody: { id, ...listBody } }),
        );
      } catch (err2) {
        this.log(`google: could not add the Tempo calendar to the calendar list: ${errorMessage(err2)}`);
      }
    }
    return id;
  }

  async listEvents(calendarIds: string[], range: TimeRange): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    for (const calendarId of new Set(calendarIds)) {
      try {
        let pageToken: string | undefined;
        do {
          const params: calendar_v3.Params$Resource$Events$List = {
            calendarId,
            timeMin: range.start.toISOString(),
            timeMax: range.end.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            showDeleted: false,
            maxResults: 2500,
          };
          if (pageToken) params.pageToken = pageToken;
          const { data } = await this.call(() => this.api.events.list(params));
          for (const item of data.items ?? []) {
            const ev = this.mapEvent(item, calendarId, data.timeZone);
            if (ev) out.push(ev);
          }
          pageToken = data.nextPageToken ?? undefined;
        } while (pageToken);
      } catch (err) {
        if (isStatus(err, 403, 404)) {
          this.log(`google: skipping calendar ${calendarId}: ${errorMessage(err)}`);
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /**
   * Incremental changes since the stored sync token. Without a token (first
   * call) or after 410 GONE a full sync from `now - fullSyncLookbackDays` runs;
   * then `fullResync` is true and `events` is the full set.
   */
  async listChanges(calendarId: string): Promise<EventsDelta> {
    const token = await this.syncTokens.get(calendarId);
    if (token) {
      try {
        const events = await this.syncPages(calendarId, token);
        return { events, fullResync: false };
      } catch (err) {
        if (!isStatus(err, 410)) throw err;
        this.log(`google: sync token for ${calendarId} expired (410), doing a full resync`);
        await this.syncTokens.set(calendarId, undefined);
      }
    }
    const events = await this.syncPages(calendarId, undefined);
    return { events, fullResync: true };
  }

  private async syncPages(calendarId: string, syncToken: string | undefined): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    const timeMin = new Date(this.now().getTime() - this.lookbackDays * 86_400_000).toISOString();
    do {
      // syncToken can't be combined with timeMin/timeMax/orderBy/q/updatedMin;
      // deleted events are always included in incremental results.
      const params: calendar_v3.Params$Resource$Events$List = { calendarId, singleEvents: true, maxResults: 2500 };
      if (syncToken) params.syncToken = syncToken;
      else params.timeMin = timeMin;
      if (pageToken) params.pageToken = pageToken;
      const { data } = await this.call(() => this.api.events.list(params));
      for (const item of data.items ?? []) {
        const ev = this.mapEvent(item, calendarId, data.timeZone);
        if (ev) out.push(ev);
      }
      pageToken = data.nextPageToken ?? undefined;
      nextSyncToken = data.nextSyncToken ?? nextSyncToken; // only present on the last page
    } while (pageToken);
    if (nextSyncToken) await this.syncTokens.set(calendarId, nextSyncToken);
    else this.log(`google: no nextSyncToken returned for ${calendarId}`);
    return out;
  }

  async createBlock(tempoCalendarId: string, block: BlockDraft): Promise<CalendarEvent> {
    // Client-generated id makes the insert idempotent under retries: if a retried
    // request already succeeded server-side, Google answers 409 and we read it back.
    const id = newEventId();
    const data = await insertIdempotent(
      () =>
        this.call(() =>
          this.api.events.insert({
            calendarId: tempoCalendarId,
            sendUpdates: 'none',
            requestBody: { ...toGoogleEvent(block), id },
          }),
        ),
      () => this.call(() => this.api.events.get({ calendarId: tempoCalendarId, eventId: id })),
    );
    return this.requireMapped(data, tempoCalendarId);
  }

  async updateBlock(
    tempoCalendarId: string,
    eventId: string,
    patch: { start?: Date; end?: Date; reason?: string; learned?: string[]; title?: string },
  ): Promise<CalendarEvent> {
    const { data: current } = await this.call(() => this.api.events.get({ calendarId: tempoCalendarId, eventId }));
    // events.get returns deleted events as 200 + status 'cancelled'; treat as gone (404-shaped).
    if (current.status === 'cancelled') {
      throw Object.assign(new Error(`Event ${eventId} was deleted`), { status: 404, code: 404 });
    }
    const priv = current.extendedProperties?.private ?? {};
    if (priv[PROP.tempo] === undefined) {
      throw new Error(`Refusing to modify event ${eventId}: it is not a Tempo block`);
    }
    const live = this.requireMapped(current, tempoCalendarId);
    const start = patch.start ?? live.start;
    const end = patch.end ?? live.end;

    const requestBody: calendar_v3.Schema$Event = {
      // Always record what Tempo wrote, so later user drags can be detected.
      extendedProperties: {
        private: {
          ...priv,
          [PROP.plannedStart]: start.toISOString(),
          [PROP.plannedEnd]: end.toISOString(),
        },
      },
    };
    if (patch.start) requestBody.start = eventTime(patch.start, current.start?.timeZone ?? undefined);
    if (patch.end) requestBody.end = eventTime(patch.end, current.end?.timeZone ?? undefined);
    if (patch.title !== undefined) requestBody.summary = patch.title;
    if (patch.reason !== undefined || patch.learned !== undefined) {
      const old = parseBlockDescription(current.description);
      requestBody.description = renderBlockDescription({
        reason: patch.reason ?? old.reason,
        learned: patch.learned ?? old.learned,
      });
    }

    const { data } = await this.call(() =>
      this.api.events.patch({ calendarId: tempoCalendarId, eventId, sendUpdates: 'none', requestBody }),
    );
    return this.requireMapped(data, tempoCalendarId);
  }

  async deleteBlock(tempoCalendarId: string, eventId: string): Promise<void> {
    try {
      await this.call(() => this.api.events.delete({ calendarId: tempoCalendarId, eventId, sendUpdates: 'none' }));
    } catch (err) {
      if (isStatus(err, 404, 410)) {
        this.log(`google: block ${eventId} already deleted`);
        return;
      }
      throw err;
    }
  }

  private requireMapped(ev: calendar_v3.Schema$Event, calendarId: string): CalendarEvent {
    const mapped = this.mapEvent(ev, calendarId);
    if (!mapped) throw new Error(`Google returned an event without id/start/end in ${calendarId}`);
    return mapped;
  }
}

/** Google event ids: 5–1024 chars of base32hex (a–v, 0–9). */
export function newEventId(): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuv';
  const bytes = randomBytes(26);
  let id = 't';
  for (const b of bytes) id += alphabet[b % 32];
  return id;
}

/** Run an insert with a client-chosen id; a 409 (already exists) means an earlier attempt succeeded. */
export async function insertIdempotent(
  insert: () => Promise<{ data: calendar_v3.Schema$Event }>,
  readBack: () => Promise<{ data: calendar_v3.Schema$Event }>,
): Promise<calendar_v3.Schema$Event> {
  try {
    return (await insert()).data;
  } catch (err) {
    if (isStatus(err, 409)) return (await readBack()).data;
    throw err;
  }
}
