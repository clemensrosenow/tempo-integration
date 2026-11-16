import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NotSignedInError,
  SCOPES,
  emailFromIdToken,
  getAuthorizedClient,
  loadClientCredentials,
  missingScopes,
  readStoredToken,
  signOut,
  startLoopbackReceiver,
  tokenPath,
  writeStoredToken,
} from '../../src/google/auth.js';
import { calendarIdFromResourceUri, createWebhookServer, startWatch } from '../../src/google/webhook.js';
import { asCalendarApi, fakeCalendarApi } from './fakes.js';

let dir: string;
const savedEnv = { id: process.env.GOOGLE_CLIENT_ID, secret: process.env.GOOGLE_CLIENT_SECRET };

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'tempo-google-'));
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
  if (savedEnv.id !== undefined) process.env.GOOGLE_CLIENT_ID = savedEnv.id;
  if (savedEnv.secret !== undefined) process.env.GOOGLE_CLIENT_SECRET = savedEnv.secret;
});

describe('client credentials', () => {
  it('prefers env vars', async () => {
    await expect(loadClientCredentials(dir, { GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 's' })).resolves.toEqual({
      clientId: 'id',
      clientSecret: 's',
      source: 'env',
    });
  });

  it('reads "installed" and "web" client JSON', async () => {
    await fs.writeFile(join(dir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'i', client_secret: 'x' } }));
    await expect(loadClientCredentials(dir, {})).resolves.toEqual({ clientId: 'i', clientSecret: 'x', source: 'file' });
    await fs.writeFile(join(dir, 'credentials.json'), JSON.stringify({ web: { client_id: 'w' } }));
    await expect(loadClientCredentials(dir, {})).resolves.toEqual({ clientId: 'w', source: 'file' });
  });

  it('explains what to do when nothing is configured', async () => {
    await expect(loadClientCredentials(dir, {})).rejects.toThrow(/credentials\.json/);
  });
});

describe('token storage', () => {
  it('requests the documented scopes', () => {
    expect(SCOPES.user).toContain('https://www.googleapis.com/auth/calendar');
    expect(SCOPES.user).toContain('https://www.googleapis.com/auth/tasks.readonly');
    expect(SCOPES.organizer).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.owned']);
    expect(missingScopes('user', 'openid https://www.googleapis.com/auth/calendar')).toEqual([
      'https://www.googleapis.com/auth/tasks.readonly',
    ]);
  });

  it('throws NotSignedInError with the login command when no token exists', async () => {
    const err = await getAuthorizedClient('organizer', dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotSignedInError);
    expect((err as Error).message).toContain('npm run tempo -- login --organizer');
  });

  it('writes tokens with mode 0600 and persists refreshed tokens, keeping the refresh token', async () => {
    await fs.writeFile(join(dir, 'credentials.json'), JSON.stringify({ installed: { client_id: 'i', client_secret: 'x' } }));
    await writeStoredToken(dir, {
      profile: 'user',
      email: 'me@gmail.com',
      scopes: [...SCOPES.user],
      tokens: { access_token: 'old', refresh_token: 'R', expiry_date: 1 },
      savedAt: '2026-11-16T00:00:00.000Z',
    });
    const stat = await fs.stat(tokenPath(dir, 'user'));
    expect(stat.mode & 0o777).toBe(0o600);

    const client = await getAuthorizedClient('user', dir);
    expect(client.credentials.refresh_token).toBe('R');
    client.emit('tokens', { access_token: 'new', expiry_date: 2 });
    await vi.waitFor(async () => {
      const stored = await readStoredToken('user', dir);
      expect(stored?.tokens).toMatchObject({ access_token: 'new', refresh_token: 'R', expiry_date: 2 });
    });
  });

  it('signOut deletes the local token file', async () => {
    await writeStoredToken(dir, {
      profile: 'organizer',
      email: 'tempo@gmail.com',
      scopes: [],
      tokens: {},
      savedAt: '',
    });
    await signOut('organizer', dir);
    await expect(readStoredToken('organizer', dir)).resolves.toBeUndefined();
  });

  it('extracts the email claim from an id_token', () => {
    const payload = Buffer.from(JSON.stringify({ email: 'me@gmail.com' })).toString('base64url');
    expect(emailFromIdToken(`h.${payload}.s`)).toBe('me@gmail.com');
    expect(emailFromIdToken('garbage')).toBeUndefined();
    expect(emailFromIdToken(undefined)).toBeUndefined();
  });
});

describe('loopback receiver', () => {
  it('returns the code for the matching state and ignores others', async () => {
    const r = await startLoopbackReceiver({ timeoutMs: 5_000 });
    try {
      expect(r.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const pending = r.waitForCode('good');
      expect((await fetch(`${r.redirectUri}/favicon.ico`)).status).toBe(404);
      expect((await fetch(`${r.redirectUri}/?code=evil&state=bad`)).status).toBe(200);
      const res = await fetch(`${r.redirectUri}/?code=abc&state=good`);
      expect(await res.text()).toContain('Tempo is connected');
      await expect(pending).resolves.toBe('abc');
    } finally {
      await r.close();
    }
  });

  it('rejects when the user denies consent', async () => {
    const r = await startLoopbackReceiver({ timeoutMs: 5_000 });
    try {
      const assertion = expect(r.waitForCode('s')).rejects.toThrow(/access_denied/);
      await fetch(`${r.redirectUri}/?error=access_denied&state=s`);
      await assertion;
    } finally {
      await r.close();
    }
  });
});

describe('webhook', () => {
  it('requires HTTPS and returns the channel', async () => {
    const api = fakeCalendarApi();
    api.events.watch.mockResolvedValue({ data: { id: 'ch1', resourceId: 'res1', expiration: '1795000000000' } });
    await expect(startWatch(null, 'primary', 'http://insecure', 'ch1', { api: asCalendarApi(api) })).rejects.toThrow(
      /HTTPS/,
    );
    const ch = await startWatch(null, 'primary', 'https://x.example/hook', 'ch1', {
      api: asCalendarApi(api),
      token: 'secret',
      ttlSeconds: 3600,
    });
    expect(ch).toEqual({ id: 'ch1', resourceId: 'res1', calendarId: 'primary', expiration: new Date(1795000000000) });
    expect(api.events.watch.mock.calls[0]![0]).toEqual({
      calendarId: 'primary',
      requestBody: {
        id: 'ch1',
        type: 'web_hook',
        address: 'https://x.example/hook',
        token: 'secret',
        params: { ttl: '3600' },
      },
    });
  });

  it('parses the calendar id from the resource URI', () => {
    expect(
      calendarIdFromResourceUri(
        'https://www.googleapis.com/calendar/v3/calendars/abc%40group.calendar.google.com/events?alt=json',
      ),
    ).toBe('abc@group.calendar.google.com');
    expect(calendarIdFromResourceUri(undefined)).toBeUndefined();
  });

  it('validates headers, acks fast and notifies for changes only', async () => {
    const seen: string[] = [];
    const ws = createWebhookServer({
      port: 0,
      token: 'secret',
      resolveChannel: (id) => (id === 'ch1' ? 'primary' : undefined),
      onNotification: (cal) => {
        seen.push(cal);
      },
    });
    const port = await ws.ready;
    const url = `http://127.0.0.1:${port}/`;
    const post = (headers: Record<string, string>) => fetch(url, { method: 'POST', headers });
    try {
      expect((await post({})).status).toBe(400);
      expect((await post({ 'X-Goog-Channel-ID': 'ch1', 'X-Goog-Resource-State': 'exists' })).status).toBe(403);
      const ok = { 'X-Goog-Channel-ID': 'ch1', 'X-Goog-Channel-Token': 'secret' };
      expect((await post({ ...ok, 'X-Goog-Resource-State': 'sync' })).status).toBe(200);
      expect((await post({ ...ok, 'X-Goog-Resource-State': 'exists' })).status).toBe(200);
      await vi.waitFor(() => expect(seen).toEqual(['primary']));
    } finally {
      await ws.close();
    }
  });
});
