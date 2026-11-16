/**
 * TempoState helpers shared by the stores: defaults and a Date-preserving
 * JSON codec.
 *
 * Dates are written as tagged objects `{"$date": "<ISO>"}` and revived on
 * load. This is robust regardless of field names: Date-typed fields
 * (Question.slot/createdAt/answerBy, BlockDraft start/end, EventChange ranges,
 * ...) come back as Date, while string-typed timestamps (estimatedAt,
 * EventFingerprint start/end, lastPlanAt, ...) stay strings.
 */
import type { TempoState } from '../core/ports.js';

export const STATE_VERSION = 1 as const;

export function defaultState(): TempoState {
  return {
    version: STATE_VERSION,
    estimates: {},
    questions: [],
    handledEndedBlocks: [],
    syncTokens: {},
    channels: [],
  };
}

export class StateVersionError extends Error {
  constructor(found: unknown) {
    super(`Unsupported Tempo state version ${JSON.stringify(found)} (expected ${STATE_VERSION}). Upgrade Tempo or move the state file away.`);
    this.name = 'StateVersionError';
  }
}

const DATE_TAG = '$date';

export function serializeState(state: TempoState): string {
  return JSON.stringify(
    state,
    function replacer(this: Record<string, unknown>, key: string, value: unknown): unknown {
      // `value` is already the toJSON() string for Dates; inspect the raw holder value.
      const raw = this[key];
      if (raw instanceof Date) {
        return { [DATE_TAG]: Number.isNaN(raw.getTime()) ? null : raw.toISOString() };
      }
      return value;
    },
    2,
  );
}

export function deserializeState(json: string): TempoState {
  const parsed: unknown = JSON.parse(json, (_key, value: unknown) => {
    if (isDateTag(value)) return value[DATE_TAG] === null ? new Date(Number.NaN) : new Date(value[DATE_TAG]);
    return value;
  });
  return normalizeState(parsed);
}

/** Version check + fill fields added later with defaults. */
export function normalizeState(parsed: unknown): TempoState {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Tempo state file is not a JSON object');
  }
  const version = (parsed as { version?: unknown }).version;
  if (version !== STATE_VERSION) throw new StateVersionError(version);
  return { ...defaultState(), ...(parsed as Partial<TempoState>), version: STATE_VERSION };
}

function isDateTag(v: unknown): v is { [DATE_TAG]: string | null } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 1 || keys[0] !== DATE_TAG) return false;
  const tag = (v as Record<string, unknown>)[DATE_TAG];
  return typeof tag === 'string' || tag === null;
}
