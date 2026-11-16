/**
 * InvitePort implementation: questions are real Google Calendar invitations
 * sent from the separate Tempo organizer account (E9/E10). The user answers with
 * the native Yes / No / Maybe controls.
 *
 * sendUpdates choices (see docs/google-api-notes.md):
 *  - sendQuestion: 'all'  — the user must get the invitation (email + calendar).
 *  - annotate:     'none' — organizer changes propagate to the Google Calendar
 *                  attendee copy anyway; no "Updated invitation" email spam.
 *  - cancel:       'all' by default (port contract) so the attendee copy is
 *                  reliably removed; configurable via `cancelSendUpdates`.
 */
import type { OAuth2Client } from 'google-auth-library';
import type { Question, ResponseStatus } from '../core/types.js';
import type { InvitePort } from '../core/ports.js';
import { createCalendarApi, type CalendarApi } from './api.js';
import { toInviteEvent, toResponseStatus } from './mapping.js';
import { errorMessage, isStatus, withRetry, type RetryOptions } from './retry.js';

export type SendUpdates = 'all' | 'externalOnly' | 'none';

export interface GoogleInviteAdapterOptions {
  api?: CalendarApi;
  /** Organizer calendar to create invitations in. Default 'primary'. */
  calendarId?: string;
  /** IANA zone attached to start/end (display only). */
  timeZone?: string;
  /** Popup reminder on the organizer copy (attendees keep their own defaults). Default 10. */
  reminderMinutes?: number;
  annotateSendUpdates?: SendUpdates;
  cancelSendUpdates?: SendUpdates;
  log?: (line: string) => void;
  retry?: RetryOptions;
}

export class GoogleInviteAdapter implements InvitePort {
  private readonly api: CalendarApi;
  private readonly calendarId: string;
  private readonly opts: GoogleInviteAdapterOptions;
  private readonly log: (line: string) => void;

  /** @param organizerClient OAuth client of the Tempo ORGANIZER account (not the user). */
  constructor(organizerClient: OAuth2Client | null, opts: GoogleInviteAdapterOptions = {}) {
    if (opts.api) this.api = opts.api;
    else if (organizerClient) this.api = createCalendarApi(organizerClient);
    else throw new Error('GoogleInviteAdapter needs an OAuth2Client or an injected api');
    this.calendarId = opts.calendarId ?? 'primary';
    this.opts = opts;
    this.log = opts.log ?? (() => {});
  }

  private call<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, this.opts.retry ?? {});
  }

  async sendQuestion(question: Question, attendeeEmail: string): Promise<string> {
    const requestBody = toInviteEvent(question, attendeeEmail, {
      ...(this.opts.timeZone !== undefined ? { timeZone: this.opts.timeZone } : {}),
      ...(this.opts.reminderMinutes !== undefined ? { reminderMinutes: this.opts.reminderMinutes } : {}),
    });
    const { data } = await this.call(() =>
      this.api.events.insert({ calendarId: this.calendarId, sendUpdates: 'all', requestBody }),
    );
    if (!data.id) throw new Error('events.insert returned no id for the invitation');
    return data.id;
  }

  async getResponse(inviteEventId: string, attendeeEmail: string): Promise<ResponseStatus> {
    try {
      const { data } = await this.call(() =>
        this.api.events.get({ calendarId: this.calendarId, eventId: inviteEventId }),
      );
      const wanted = attendeeEmail.trim().toLowerCase();
      const attendee = data.attendees?.find((a) => a.email?.trim().toLowerCase() === wanted);
      return toResponseStatus(attendee?.responseStatus) ?? 'needsAction';
    } catch (err) {
      if (isStatus(err, 404, 410)) {
        this.log(`google: invitation ${inviteEventId} not found (${errorMessage(err)}); treating as no answer`);
        return 'needsAction';
      }
      throw err;
    }
  }

  async annotate(inviteEventId: string, description: string): Promise<void> {
    await this.call(() =>
      this.api.events.patch({
        calendarId: this.calendarId,
        eventId: inviteEventId,
        sendUpdates: this.opts.annotateSendUpdates ?? 'none',
        requestBody: { description },
      }),
    );
  }

  async cancel(inviteEventId: string): Promise<void> {
    try {
      await this.call(() =>
        this.api.events.delete({
          calendarId: this.calendarId,
          eventId: inviteEventId,
          sendUpdates: this.opts.cancelSendUpdates ?? 'all',
        }),
      );
    } catch (err) {
      if (isStatus(err, 404, 410)) {
        this.log(`google: invitation ${inviteEventId} already gone`);
        return;
      }
      throw err;
    }
  }
}
