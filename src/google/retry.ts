/**
 * Error classification + exponential backoff for Google API calls.
 *
 * Google recommends exponential backoff for 429, 403 rateLimitExceeded /
 * userRateLimitExceeded and 5xx backend errors
 * (https://developers.google.com/workspace/calendar/api/guides/errors).
 */

const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** HTTP status of a gaxios/googleapis error (or `undefined` for non-HTTP errors). */
export function httpStatus(err: unknown): number | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  if (typeof e.status === 'number') return e.status;
  const response = asRecord(e.response);
  if (response && typeof response.status === 'number') return response.status;
  if (typeof e.code === 'number') return e.code;
  if (typeof e.code === 'string' && /^\d{3}$/.test(e.code)) return Number(e.code);
  return undefined;
}

/** Google error `reason`s, e.g. `["rateLimitExceeded"]`. */
export function errorReasons(err: unknown): string[] {
  const reasons: string[] = [];
  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const r = asRecord(item)?.reason;
      if (typeof r === 'string') reasons.push(r);
    }
  };
  const e = asRecord(err);
  if (!e) return reasons;
  collect(e.errors);
  const data = asRecord(asRecord(e.response)?.data);
  const apiError = asRecord(data?.error);
  collect(apiError?.errors);
  return reasons;
}

export function isRetryableError(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 429) return true;
  if (status !== undefined && status >= 500 && status <= 599) return true;
  if (status === 403) return errorReasons(err).some((r) => RATE_LIMIT_REASONS.has(r));
  return false;
}

export function isStatus(err: unknown, ...statuses: number[]): boolean {
  const s = httpStatus(err);
  return s !== undefined && statuses.includes(s);
}

export interface RetryOptions {
  /** Retries after the first attempt. Default 5. */
  retries?: number;
  /** First backoff in ms. Default 500. */
  baseDelayMs?: number;
  /** Cap per wait in ms. Default 16000. */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests (0..1). */
  random?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Run `fn`, retrying retryable Google errors with `min(2^n * base + jitter, max)` waits. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 16_000;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries || !isRetryableError(err)) throw err;
      const wait = Math.min(base * 2 ** attempt + Math.floor(random() * base), max);
      await sleep(wait);
    }
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
