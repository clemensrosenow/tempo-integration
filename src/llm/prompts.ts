/**
 * Provider-neutral prompts, JSON schemas and response validation for the
 * three LLM steps (Understand, Place, Explain). Shared by the Anthropic and
 * Gemini adapters so both behave the same.
 *
 * Dates go into prompts as ISO strings with the user's UTC offset and are
 * parsed back into `Date`s here.
 */
import { z } from 'zod';
import type { ExplainRequest, PlaceRequest, Placement, UnderstandRequest } from '../core/ports.js';
import type { TaskEstimate } from '../core/types.js';
import { clamp, clampInt, isoLocal, parseIso, shortLocal, tidyReason } from './text.js';

/** A request to a JSON-producing model call. */
export interface JsonPrompt {
  /** Short step name for logs. */
  step: 'understand' | 'place' | 'explain';
  system: string;
  user: string;
  /** JSON schema (object at the top level, all properties required, no extras). */
  schema: Record<string, unknown>;
  maxTokens: number;
}

const MAX_NOTES_CHARS = 2000;

// ---------------------------------------------------------------------------
// Understand
// ---------------------------------------------------------------------------

export const UNDERSTAND_SYSTEM = `You are the task-understanding step of Tempo, an assistant that plans a university student's Google Tasks as time blocks in Google Calendar.

For every task, estimate:
- durationMin: total remaining focused work in minutes (integer, 5-2400). For a task with subtasks, estimate the whole task.
- priority: 1 (low) to 5 (critical: exams, graded or hard deadlines, things others depend on).
- urgency: 1 (can wait) to 5 (must happen today), mostly from the due date relative to now.
- confidence: 0 to 1, how sure you are about the priority. Go below 0.5 only if the title is too vague to judge importance; Tempo will then ask the user.
- minChunkMin: smallest sensible block if the task is split (integer, 15-120, at most durationMin).
- deepWork: true if the task needs uninterrupted concentration (studying, writing, coding).
- rationale: at most 15 words explaining the estimate.

Due dates are exclusive deadlines: the task must be done before that instant. Take the learned notes about this user into account. Return exactly one estimate per task id from the input and nothing else.`;

const EstimateItem = z.object({
  taskId: z.string(),
  durationMin: z.number(),
  priority: z.number(),
  urgency: z.number(),
  confidence: z.number(),
  minChunkMin: z.number(),
  deepWork: z.boolean(),
  rationale: z.string().optional(),
});
export const UnderstandResponse = z.object({ estimates: z.array(EstimateItem) });

export const UNDERSTAND_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    estimates: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          durationMin: { type: 'integer' },
          priority: { type: 'integer' },
          urgency: { type: 'integer' },
          confidence: { type: 'number' },
          minChunkMin: { type: 'integer' },
          deepWork: { type: 'boolean' },
          rationale: { type: 'string' },
        },
        required: ['taskId', 'durationMin', 'priority', 'urgency', 'confidence', 'minChunkMin', 'deepWork', 'rationale'],
        additionalProperties: false,
      },
    },
  },
  required: ['estimates'],
  additionalProperties: false,
};

export function understandPrompt(req: UnderstandRequest): JsonPrompt {
  const tz = req.timezone;
  const payload = {
    now: isoLocal(req.now, tz),
    timezone: tz,
    learnedNotes: req.learnedNotes,
    tasks: req.tasks.map((t) => ({
      id: t.id,
      title: t.title,
      ...(t.notes ? { notes: t.notes.slice(0, MAX_NOTES_CHARS) } : {}),
      ...(t.due ? { due: isoLocal(t.due, tz) } : {}),
      ...(t.parentId ? { subtaskOf: t.parentId } : {}),
      ...(t.subtaskTitles?.length ? { subtasks: t.subtaskTitles } : {}),
    })),
  };
  return {
    step: 'understand',
    system: UNDERSTAND_SYSTEM,
    user: `Estimate these tasks.\n\n${JSON.stringify(payload, null, 2)}`,
    schema: UNDERSTAND_SCHEMA,
    maxTokens: 16000,
  };
}

/** Validated + clamped estimates for the requested ids only. Unknown ids are dropped. */
export function parseUnderstand(raw: unknown, req: UnderstandRequest): Map<string, TaskEstimate> {
  const parsed = UnderstandResponse.parse(raw);
  const wanted = new Set(req.tasks.map((t) => t.id));
  const out = new Map<string, TaskEstimate>();
  for (const e of parsed.estimates) {
    if (!wanted.has(e.taskId) || out.has(e.taskId)) continue;
    if (![e.durationMin, e.priority, e.urgency, e.confidence, e.minChunkMin].every(Number.isFinite)) continue;
    const durationMin = clampInt(e.durationMin, 5, 40 * 60);
    out.set(e.taskId, {
      taskId: e.taskId,
      durationMin,
      priority: clampInt(e.priority, 1, 5),
      urgency: clampInt(e.urgency, 1, 5),
      confidence: clamp(e.confidence, 0, 1),
      minChunkMin: clampInt(e.minChunkMin, Math.min(15, durationMin), durationMin),
      deepWork: e.deepWork,
      ...(e.rationale ? { rationale: e.rationale.slice(0, 200) } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Place
// ---------------------------------------------------------------------------

export const PLACE_SYSTEM = `You are the placement step of Tempo. Tempo plans a university student's tasks as time blocks inside free gaps of their Google Calendar.

Rules (hard):
- Every placement lies completely inside one of the given gaps.
- Placements never overlap each other.
- A task may be split into several placements, each at least minChunkMin minutes; together they cover durationMin minutes. Do not place more than durationMin.
- Every placement of a task ends at or before the task's due instant.
- Tasks sharing an orderGroup are placed in ascending orderIndex (all of a lower index ends before a higher index starts).

Preferences (soft):
- Minimal change: if a task has a current block that still lies inside a gap and satisfies the rules, keep it exactly as it is.
- Higher priority and urgency first; urgency 5 means today if possible.
- Put deepWork tasks into the focus time window when possible.
- Respect the learned notes about the user.

If a task cannot fit before its due date, leave it out entirely; Tempo will ask the user. If previousErrors are given, your last answer broke these rules: fix every listed error.
Return start and end as ISO 8601 date-times with the same UTC offset as the input.`;

const PlacementItem = z.object({ taskId: z.string(), start: z.string(), end: z.string() });
export const PlaceResponse = z.object({ placements: z.array(PlacementItem) });

export const PLACE_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    placements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          taskId: { type: 'string' },
          start: { type: 'string', format: 'date-time' },
          end: { type: 'string', format: 'date-time' },
        },
        required: ['taskId', 'start', 'end'],
        additionalProperties: false,
      },
    },
  },
  required: ['placements'],
  additionalProperties: false,
};

export function placePrompt(req: PlaceRequest): JsonPrompt {
  const tz = req.timezone;
  const iso = (d: Date): string => isoLocal(d, tz);
  const payload = {
    now: iso(req.now),
    timezone: tz,
    focusTime: req.focusTime,
    learnedNotes: req.learnedNotes,
    gaps: req.gaps.map((g) => ({ start: iso(g.start), end: iso(g.end), day: shortLocal(g.start, tz).slice(0, 3) })),
    tasks: req.tasks.map((t) => ({
      taskId: t.taskId,
      title: t.title,
      durationMin: t.durationMin,
      minChunkMin: t.minChunkMin,
      priority: t.priority,
      urgency: t.urgency,
      deepWork: t.deepWork,
      ...(t.due ? { due: iso(t.due) } : {}),
      ...(t.orderGroup !== undefined ? { orderGroup: t.orderGroup, orderIndex: t.orderIndex ?? 0 } : {}),
    })),
    currentBlocks: req.currentBlocks.map((b) => ({ taskId: b.taskId, start: iso(b.start), end: iso(b.end) })),
    ...(req.previousErrors?.length ? { previousErrors: req.previousErrors } : {}),
  };
  return {
    step: 'place',
    system: PLACE_SYSTEM,
    user: `Place these tasks.\n\n${JSON.stringify(payload, null, 2)}`,
    schema: PLACE_SCHEMA,
    maxTokens: 16000,
  };
}

/**
 * Structural validation only (known task id, valid dates, start < end). The
 * core's Check step validates gaps/overlaps/deadlines and feeds errors back.
 * Throws if the response has entries but none of them is usable.
 */
export function parsePlace(raw: unknown, req: PlaceRequest): Placement[] {
  const parsed = PlaceResponse.parse(raw);
  const known = new Set(req.tasks.map((t) => t.taskId));
  const out: Placement[] = [];
  for (const p of parsed.placements) {
    const start = parseIso(p.start);
    const end = parseIso(p.end);
    if (!known.has(p.taskId) || !start || !end || start >= end) continue;
    out.push({ taskId: p.taskId, start, end });
  }
  if (parsed.placements.length > 0 && out.length === 0) {
    throw new Error('no usable placement in model response');
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

// ---------------------------------------------------------------------------
// Explain
// ---------------------------------------------------------------------------

export const EXPLAIN_SYSTEM = `You write the one-line reason Tempo puts into the description of a calendar block it created, moved or removed.

For each change write one line in plain, friendly language:
- at most 90 characters,
- name the concrete cause (which meeting ran over, which deadline, what the user changed),
- no emoji, no markdown, do not start with "Tempo".
Return exactly one reason per taskId from the input.`;

const ReasonItem = z.object({ taskId: z.string(), reason: z.string() });
export const ExplainResponse = z.object({ reasons: z.array(ReasonItem) });

export const EXPLAIN_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reasons: {
      type: 'array',
      items: {
        type: 'object',
        properties: { taskId: { type: 'string' }, reason: { type: 'string' } },
        required: ['taskId', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['reasons'],
  additionalProperties: false,
};

export function explainPrompt(req: ExplainRequest): JsonPrompt {
  const tz = req.timezone;
  const range = (r: { start: Date; end: Date } | undefined): string | undefined =>
    r ? `${shortLocal(r.start, tz)}-${shortLocal(r.end, tz).slice(4)} (${isoLocal(r.start, tz)})` : undefined;
  const payload = {
    now: isoLocal(req.now, tz),
    changes: req.changes.map((c) => ({
      taskId: c.taskId,
      title: c.title,
      kind: c.kind,
      ...(c.from ? { from: range(c.from) } : {}),
      ...(c.to ? { to: range(c.to) } : {}),
      cause: c.cause,
    })),
  };
  return {
    step: 'explain',
    system: EXPLAIN_SYSTEM,
    user: `Write the reasons.\n\n${JSON.stringify(payload, null, 2)}`,
    schema: EXPLAIN_SCHEMA,
    maxTokens: 4000,
  };
}

export function parseExplain(raw: unknown, req: ExplainRequest): Map<string, string> {
  const parsed = ExplainResponse.parse(raw);
  const wanted = new Set(req.changes.map((c) => c.taskId));
  const out = new Map<string, string>();
  for (const r of parsed.reasons) {
    const reason = tidyReason(r.reason.replace(/^["']|["']$/g, ''));
    if (wanted.has(r.taskId) && reason && !out.has(r.taskId)) out.set(r.taskId, reason);
  }
  return out;
}
