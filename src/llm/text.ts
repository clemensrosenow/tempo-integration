/** Small helpers shared by all LLM adapters (no network, no SDKs). */
import { DateTime } from 'luxon';

export const MAX_REASON_CHARS = 90;

/** ISO string with the user's UTC offset, e.g. 2026-11-16T09:00:00+01:00. */
export function isoLocal(d: Date, timezone: string): string {
  const dt = DateTime.fromJSDate(d, { zone: timezone });
  return (dt.isValid ? dt : DateTime.fromJSDate(d, { zone: 'utc' })).toISO({ suppressMilliseconds: true }) ?? d.toISOString();
}

/** "Tue 14:00" in the user's timezone. */
export function shortLocal(d: Date, timezone: string): string {
  return DateTime.fromJSDate(d, { zone: timezone }).setLocale('en').toFormat('ccc HH:mm');
}

/** Parse an ISO date-time string; returns undefined if invalid. */
export function parseIso(s: string): Date | undefined {
  const dt = DateTime.fromISO(s, { setZone: true });
  return dt.isValid ? dt.toJSDate() : undefined;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function clampInt(n: number, min: number, max: number): number {
  return Math.round(clamp(n, min, max));
}

const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;

/** One plain line, no emoji, at most 90 characters. */
export function tidyReason(text: string): string {
  const line = text.replace(EMOJI, '').replace(/\s+/g, ' ').trim();
  if (line.length <= MAX_REASON_CHARS) return line;
  return `${line.slice(0, MAX_REASON_CHARS - 1).trimEnd()}…`;
}
