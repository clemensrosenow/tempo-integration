/**
 * OAuth 2.0 for installed (desktop) apps: loopback redirect on
 * http://127.0.0.1:<random port> + PKCE (S256), via google-auth-library.
 *
 * Two profiles:
 *  - 'user'      — the student's Google account (reads calendars + tasks, writes the Tempo calendar)
 *  - 'organizer' — a separate "Tempo" Google account that sends question invitations
 *
 * Tokens live in `<dataDir>/tokens/<profile>.json` (mode 0600). Refreshed access
 * tokens are persisted via the client's `tokens` event.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { CodeChallengeMethod, OAuth2Client, type Credentials } from 'google-auth-library';

/**
 * - user: the student (reads all calendars, writes the Tempo calendar, reads Tasks)
 * - organizer: the separate account that sends question invitations
 * - sandbox: developer tool only (scripts/sandbox.ts) — full Calendar + Tasks
 *   access to a TEST account, to create sample events and tasks. Tempo itself
 *   never uses it.
 */
export type GoogleProfile = 'user' | 'organizer' | 'sandbox';

export const SCOPES: Record<GoogleProfile, readonly string[]> = {
  user: [
    'openid',
    'email',
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks.readonly',
  ],
  // calendar.events.owned is accepted by events.insert/get/patch/delete and only
  // covers calendars the organizer account owns (its primary) — the minimum needed.
  organizer: ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events.owned'],
  sandbox: ['openid', 'email', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/tasks'],
};

const IDENTITY_SCOPES = new Set(['openid', 'email', 'profile']);
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function loginCommand(profile: GoogleProfile): string {
  if (profile === 'sandbox') return 'npm run sandbox -- login';
  return profile === 'organizer' ? 'npm run tempo -- login --organizer' : 'npm run tempo -- login';
}

export class NotSignedInError extends Error {
  constructor(readonly profile: GoogleProfile, detail?: string) {
    super(
      `Not signed in to Google as the Tempo ${profile === 'organizer' ? 'organizer account' : profile === 'sandbox' ? 'sandbox (test data) account' : 'user'}` +
        `${detail ? ` (${detail})` : ''}. Run \`${loginCommand(profile)}\` first.`,
    );
    this.name = 'NotSignedInError';
  }
}

// ---------------------------------------------------------------------------
// Client credentials
// ---------------------------------------------------------------------------

export interface ClientCredentials {
  clientId: string;
  clientSecret?: string;
  source: 'env' | 'file';
}

/**
 * Client id/secret from env `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, else
 * from the downloaded OAuth client JSON `<dir>/credentials.json`
 * (`{"installed": {...}}` for Desktop clients, `{"web": {...}}` also accepted).
 */
export async function loadClientCredentials(
  dir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ClientCredentials> {
  const envId = env.GOOGLE_CLIENT_ID?.trim();
  if (envId) {
    const secret = env.GOOGLE_CLIENT_SECRET?.trim();
    return secret ? { clientId: envId, clientSecret: secret, source: 'env' } : { clientId: envId, source: 'env' };
  }
  const file = join(dir, 'credentials.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    throw new Error(
      `No Google OAuth client found. Set GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET or save the downloaded ` +
        `"Desktop app" client JSON as ${file} (see docs/google-setup.md).`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
  const root = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  const section = (root.installed ?? root.web ?? root) as Record<string, unknown>;
  const clientId = typeof section.client_id === 'string' ? section.client_id : undefined;
  const clientSecret = typeof section.client_secret === 'string' ? section.client_secret : undefined;
  if (!clientId) throw new Error(`${file} has no client_id (expected an "installed" or "web" section)`);
  return clientSecret ? { clientId, clientSecret, source: 'file' } : { clientId, source: 'file' };
}

// ---------------------------------------------------------------------------
// Token storage
// ---------------------------------------------------------------------------

export interface StoredToken {
  profile: GoogleProfile;
  email: string;
  scopes: string[];
  tokens: Credentials;
  savedAt: string;
}

export function tokenPath(dataDir: string, profile: GoogleProfile): string {
  return join(dataDir, 'tokens', `${profile}.json`);
}

export async function readStoredToken(profile: GoogleProfile, dataDir: string): Promise<StoredToken | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(tokenPath(dataDir, profile), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredToken>;
    if (!parsed.tokens || typeof parsed.tokens !== 'object') return undefined;
    return {
      profile,
      email: typeof parsed.email === 'string' ? parsed.email : '',
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((s): s is string => typeof s === 'string') : [],
      tokens: parsed.tokens,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    };
  } catch {
    return undefined;
  }
}

export async function hasStoredToken(profile: GoogleProfile, dataDir: string): Promise<boolean> {
  return (await readStoredToken(profile, dataDir)) !== undefined;
}

export async function writeStoredToken(dataDir: string, token: StoredToken): Promise<void> {
  const dir = join(dataDir, 'tokens');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = tokenPath(dataDir, token.profile);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(token, null, 2) + '\n', { mode: 0o600 });
  await fs.chmod(tmp, 0o600);
  await fs.rename(tmp, file);
}

// ---------------------------------------------------------------------------
// Loopback receiver
// ---------------------------------------------------------------------------

export interface LoopbackReceiver {
  /** e.g. http://127.0.0.1:53682 — must be used as redirect_uri. */
  redirectUri: string;
  /** Resolves with the authorization code of the first redirect carrying `state`. */
  waitForCode(state: string): Promise<string>;
  close(): Promise<void>;
}

const DONE_HTML =
  '<!doctype html><meta charset="utf-8"><title>Tempo</title>' +
  '<body style="font-family:system-ui;margin:4rem">' +
  '<h1>Tempo is connected</h1><p>You can close this tab and return to the terminal.</p></body>';

/** Local HTTP server on 127.0.0.1 (random free port) that receives the OAuth redirect. */
export async function startLoopbackReceiver(opts: { timeoutMs?: number } = {}): Promise<LoopbackReceiver> {
  type Result = { code: string; state: string | null } | { error: string };
  const waiters: Array<(r: Result) => void> = [];
  const pending: Result[] = [];
  const deliver = (r: Result): void => {
    const w = waiters.shift();
    if (w) w(r);
    else pending.push(r);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!code && !error) {
      res.writeHead(404).end();
      return;
    }
    if (error) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(`Sign-in failed: ${error}`);
      deliver({ error });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(DONE_HTML);
    deliver({ code: code ?? '', state: url.searchParams.get('state') });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

  const next = (): Promise<Result> => {
    const ready = pending.shift();
    return ready ? Promise.resolve(ready) : new Promise((resolve) => waiters.push(resolve));
  };

  return {
    redirectUri: `http://127.0.0.1:${port}`,
    async waitForCode(state: string): Promise<string> {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Timed out waiting for the Google sign-in redirect')), timeoutMs);
      });
      try {
        for (;;) {
          const r = await Promise.race([next(), timeout]);
          if ('error' in r) throw new Error(`Google sign-in was not completed: ${r.error}`);
          if (r.state === state) return r.code;
          // Wrong/missing state (stale tab, CSRF) — ignore and keep waiting.
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/** Read the `email` claim of an id_token (received directly from Google's token endpoint over TLS). */
export function emailFromIdToken(idToken: string | null | undefined): string | undefined {
  const payload = idToken?.split('.')[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: unknown };
    return typeof claims.email === 'string' ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

async function fetchEmail(client: OAuth2Client, tokens: Credentials): Promise<string> {
  const fromToken = emailFromIdToken(tokens.id_token);
  if (fromToken) return fromToken;
  const res = await client.request<{ email?: string }>({ url: USERINFO_URL });
  if (!res.data.email) throw new Error('Could not determine the Google account email');
  return res.data.email;
}

/** Granted scopes not covering the required (non-identity) ones. */
export function missingScopes(profile: GoogleProfile, grantedScope: string | undefined): string[] {
  if (!grantedScope) return [];
  const granted = new Set(grantedScope.split(/\s+/));
  return SCOPES[profile].filter((s) => !IDENTITY_SCOPES.has(s) && !granted.has(s));
}

/** True for refresh failures that need a new `tempo login` (revoked / 7-day testing expiry). */
export function isInvalidGrant(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  const data = (err as { response?: { data?: { error?: unknown } } } | undefined)?.response?.data?.error;
  return text.includes('invalid_grant') || data === 'invalid_grant';
}

export function openInBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is printed anyway.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface SignInOptions {
  dataDir: string;
  /** Try to open the system browser (default true). The URL is always logged. */
  openBrowser?: boolean;
  log?: (line: string) => void;
  /** Pre-select an account in Google's chooser. */
  loginHint?: string;
  timeoutMs?: number;
}

export async function signIn(profile: GoogleProfile, opts: SignInOptions): Promise<{ email: string }> {
  const log = opts.log ?? ((s: string) => console.log(s));
  const creds = await loadClientCredentials(opts.dataDir);
  const receiver = await startLoopbackReceiver(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {});
  try {
    const client = new OAuth2Client({
      clientId: creds.clientId,
      ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}),
      redirectUri: receiver.redirectUri,
    });
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
    const state = randomBytes(16).toString('hex');
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [...SCOPES[profile]],
      state,
      code_challenge_method: CodeChallengeMethod.S256,
      ...(codeChallenge ? { code_challenge: codeChallenge } : {}),
      ...(opts.loginHint ? { login_hint: opts.loginHint } : {}),
    });

    const who =
      profile === 'organizer'
        ? 'the separate Tempo ORGANIZER Google account'
        : profile === 'sandbox'
          ? 'the TEST Google account that sample data may be written to'
          : 'YOUR Google account';
    log(`Sign in with ${who} in the browser:\n\n  ${url}\n`);
    if (opts.openBrowser !== false) openInBrowser(url);

    const code = await receiver.waitForCode(state);
    const { tokens } = await client.getToken({ code, codeVerifier });
    client.setCredentials(tokens);

    const missing = missingScopes(profile, tokens.scope);
    if (missing.length > 0) {
      throw new Error(
        `Google did not grant all permissions Tempo needs (missing: ${missing.join(', ')}). ` +
          `Run \`${loginCommand(profile)}\` again and tick every checkbox on the consent screen.`,
      );
    }
    const email = await fetchEmail(client, tokens);

    const other = profile === 'sandbox' ? undefined : await readStoredToken(profile === 'user' ? 'organizer' : 'user', opts.dataDir);
    if (other?.email && other.email.toLowerCase() === email.toLowerCase()) {
      throw new Error(
        `${email} is already connected as the Tempo ${other.profile}. The organizer must be a different ` +
          `Google account than the user (an invitation needs an organizer other than the attendee).`,
      );
    }
    if (!tokens.refresh_token) {
      log('Warning: Google returned no refresh token; you will have to log in again in about an hour.');
    }

    await writeStoredToken(opts.dataDir, {
      profile,
      email,
      scopes: tokens.scope ? tokens.scope.split(/\s+/) : [...SCOPES[profile]],
      tokens,
      savedAt: new Date().toISOString(),
    });
    log(`Connected ${email} as Tempo ${profile}.`);
    return { email };
  } finally {
    await receiver.close();
  }
}

/**
 * OAuth2Client with stored credentials; refreshed tokens are persisted
 * automatically. Throws NotSignedInError if `tempo login` was not run.
 */
export async function getAuthorizedClient(profile: GoogleProfile, dataDir: string): Promise<OAuth2Client> {
  const stored = await readStoredToken(profile, dataDir);
  if (!stored) throw new NotSignedInError(profile);
  if (!stored.tokens.refresh_token && !stored.tokens.access_token) {
    throw new NotSignedInError(profile, 'stored token is empty');
  }
  const creds = await loadClientCredentials(dataDir);
  const client = new OAuth2Client({
    clientId: creds.clientId,
    ...(creds.clientSecret ? { clientSecret: creds.clientSecret } : {}),
  });
  client.setCredentials(stored.tokens);

  let current = stored;
  let writes: Promise<void> = Promise.resolve();
  client.on('tokens', (fresh: Credentials) => {
    current = {
      ...current,
      tokens: {
        ...current.tokens,
        ...fresh,
        // Refresh responses usually omit refresh_token — keep the old one.
        refresh_token: fresh.refresh_token ?? current.tokens.refresh_token ?? null,
      },
      savedAt: new Date().toISOString(),
    };
    const snapshot = current;
    writes = writes.then(() => writeStoredToken(dataDir, snapshot)).catch(() => {});
  });
  return client;
}

/** Revoke the grant at Google (best effort) and delete the local token file. */
export async function signOut(
  profile: GoogleProfile,
  dataDir: string,
  opts: { log?: (line: string) => void } = {},
): Promise<void> {
  const log = opts.log ?? (() => {});
  const stored = await readStoredToken(profile, dataDir);
  if (stored) {
    const token = stored.tokens.refresh_token ?? stored.tokens.access_token;
    if (token) {
      try {
        await new OAuth2Client().revokeToken(token);
        log(`Revoked Tempo's access for ${stored.email || profile}.`);
      } catch (err) {
        log(`Could not revoke the token at Google (${err instanceof Error ? err.message : String(err)}); deleting it locally.`);
      }
    }
  }
  await fs.rm(tokenPath(dataDir, profile), { force: true });
}
