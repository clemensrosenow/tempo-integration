import { OAuth2Client } from 'google-auth-library';
import { getAuthorizedClient, loadClientCredentials, readStoredToken } from '../google/auth.js';
import type { TimeRange } from '../core/types.js';

const CALENDAR = 'https://www.googleapis.com/calendar/v3';
interface CalendarList {
  items?: Array<{ id: string; summary: string; primary?: boolean; selected?: boolean }>;
  nextPageToken?: string;
}
interface FreeBusy {
  calendars?: Record<string, { errors?: unknown[]; busy?: Array<{ start: string; end: string }> }>;
}

export class Availability {
  constructor(private readonly client: Pick<OAuth2Client, 'request'>) {}
  static async connect(dir: string): Promise<Availability> {
    const refresh = process.env.GOOGLE_REFRESH_TOKEN?.trim();
    const access = process.env.GOOGLE_ACCESS_TOKEN?.trim();
    if (refresh || access) {
      const creds = refresh ? await loadClientCredentials(dir) : undefined;
      const client = new OAuth2Client({ clientId: creds?.clientId, clientSecret: creds?.clientSecret });
      client.setCredentials({ refresh_token: refresh, access_token: access });
      return new Availability(client);
    }
    const profile = await readStoredToken('notion', dir) ? 'notion' : 'user';
    try {
      return new Availability(await getAuthorizedClient(profile, dir));
    } catch {
      throw new Error('Google account authorization is missing. Run npm run notion -- login, or configure a Google refresh token.');
    }
  }

  async calendars(): Promise<NonNullable<CalendarList['items']>> {
    const result: NonNullable<CalendarList['items']> = [];
    let pageToken: string | undefined;
    do {
      const { data } = await this.client.request<CalendarList>({
        url: CALENDAR + '/users/me/calendarList', params: { pageToken }, timeout: 15_000,
      });
      result.push(...(data.items ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return result;
  }

  async busy(ids: string[], span: TimeRange): Promise<TimeRange[]> {
    let data: FreeBusy;
    try {
      ({ data } = await this.client.request<FreeBusy>({
        url: CALENDAR + '/freeBusy', method: 'POST', timeout: 15_000,
        data: { timeMin: span.start.toISOString(), timeMax: span.end.toISOString(), items: ids.map(id => ({ id })) },
      }));
    } catch {
      throw new Error('Google availability is unavailable. Check the connection or run npm run notion -- login. The published plan is preserved.');
    }
    const entries = Object.entries(data.calendars ?? {});
    const explicit = ids.filter(id => id !== 'primary');
    if (explicit.some(id => !data.calendars?.[id]) || (ids.includes('primary') &&
      !data.calendars?.primary && !entries.some(([id]) => !explicit.includes(id))) ||
      entries.some(([, calendar]) => calendar.errors?.length || !Array.isArray(calendar.busy))) {
      throw new Error('Google did not return availability for every selected calendar. Check calendar IDs and permissions.');
    }
    return entries.flatMap(([, calendar]) => calendar.busy!.map(item => {
      const start = new Date(item.start);
      const end = new Date(item.end);
      if (!Number.isFinite(+start) || !Number.isFinite(+end) || end <= start) {
        throw new Error('Google returned an invalid busy interval.');
      }
      return { start, end };
    }));
  }
}
