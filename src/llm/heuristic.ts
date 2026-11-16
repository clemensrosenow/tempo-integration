/**
 * Deterministic, offline LlmPort. Default when no API key is configured and
 * the per-call fallback of the real LLM adapters.
 *
 * - understand: keyword + length rules, urgency from due distance.
 * - place: always `null` (the core's greedy placer takes over).
 * - explain: template one-liners from the machine `cause`.
 */
import type { ExplainRequest, LlmPort, Placement, UnderstandRequest } from '../core/ports.js';
import type { TaskEstimate } from '../core/types.js';
import { clampInt, shortLocal, tidyReason } from './text.js';

type UnderstandTask = UnderstandRequest['tasks'][number];

interface Category {
  name: string;
  pattern: RegExp;
  durationMin: number;
  deepWork: boolean;
}

/** The first four (deep-work) categories win in order; errand vs. reading: earliest keyword wins. */
const CATEGORIES: Category[] = [
  { name: 'exam prep', pattern: w('exams?|klausur|prüfung|midterms?|finals?|stud(y|ying|ies)|learn(ing)?|lernen|revis(e|ion|ing)|quiz'), durationMin: 180, deepWork: true },
  { name: 'writing', pattern: w('essays?|papers?|reports?|thesis|theses|hausarbeit|bachelorarbeit|masterarbeit|dissertation|write|writing|draft'), durationMin: 150, deepWork: true },
  { name: 'presentation', pattern: w('slides?|presentations?|präsentation|referat|pitch|deck|poster'), durationMin: 120, deepWork: true },
  { name: 'assignment', pattern: w('assignments?|homework|hausaufgabe|exercise sheet|übungsblatt|problem set|project|implement|code|coding|programming|analy[sz]e|analysis'), durationMin: 120, deepWork: true },
  { name: 'errand', pattern: w('e-?mails?|mail|call|phone|ring|buy|book|pay|submit|print|send|reply|text|message|order|register|sign up|sign|cancel|renew|upload|download|schedule|remind|ask|pick up|return'), durationMin: 20, deepWork: false },
  { name: 'reading', pattern: w('read|reading|lesen|review|prepare|preparation|practice|watch|lecture notes|recap|summar(y|ize|ise)'), durationMin: 60, deepWork: false },
];

const HIGH_PRIORITY = w('exams?|klausur|prüfung|deadline|due|submit|abgabe|urgent|asap|important|wichtig|thesis|final');
const LOW_PRIORITY = w('maybe|someday|optional|idea|nice to have|if time|eventually');
const URGENT_WORDS = w('urgent|asap|today|heute|sofort|now');
const EXPLICIT_DURATION = /(\d+(?:[.,]\d+)?)\s*(h|hrs?|hours?|std|stunden?|m|mins?|minutes?|minuten)\b/;

const DAY_MS = 86_400_000;

/** Whole-word alternation that also works for umlauts (\b does not). */
function w(alternatives: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives})(?![\\p{L}\\p{N}])`, 'u');
}

export class HeuristicLlm implements LlmPort {
  readonly name = 'heuristic';

  async understand(req: UnderstandRequest): Promise<TaskEstimate[]> {
    return req.tasks.map((t) => estimateTask(t, req.now));
  }

  async place(): Promise<Placement[] | null> {
    return null;
  }

  async explain(req: ExplainRequest): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const c of req.changes) out[c.taskId] = templateReason(c, req.timezone);
    return out;
  }
}

/** Exported for reuse by adapters when the model omits a task. */
export function estimateTask(t: UnderstandTask, now: Date): TaskEstimate {
  const title = t.title.trim();
  const notes = (t.notes ?? '').trim();
  const text = `${title}\n${notes}`.toLowerCase();
  const category = pickCategory(text);
  const explicit = explicitDuration(text);
  const why: string[] = [];

  let durationMin: number;
  if (explicit !== undefined) {
    durationMin = explicit;
    why.push(`stated ${explicit} min`);
  } else {
    durationMin = category?.durationMin ?? 45;
    why.push(category ? category.name : 'generic task');
    // Long notes usually mean more work.
    const extra = Math.min(60, Math.floor(notes.length / 200) * 15);
    if (extra > 0) {
      durationMin += extra;
      why.push(`+${extra} min for detailed notes`);
    }
    const subtasks = t.subtaskTitles?.length ?? 0;
    if (subtasks > 0) {
      durationMin = Math.max(durationMin, subtasks * 30);
      why.push(`${subtasks} subtasks`);
    }
    // A subtask is one atomic step of a bigger task.
    if (t.parentId) durationMin = Math.min(durationMin, 90);
  }
  durationMin = clampInt(Math.round(durationMin / 5) * 5, 5, 8 * 60);

  const deepWork = category?.deepWork ?? false;
  const minChunkMin = durationMin <= 60 ? durationMin : Math.min(durationMin, deepWork ? 60 : 30);

  const urgency = urgencyFor(t.due, now, text);
  const bangs = (title.match(/!/g) ?? []).length;
  let priority = 3;
  if (HIGH_PRIORITY.test(text)) priority += 1;
  if (w('exams?|klausur|prüfung|thesis').test(text)) priority += 1;
  if (LOW_PRIORITY.test(text)) priority -= 1;
  priority = clampInt(priority + bangs, 1, 5);

  const words = title.split(/\s+/).filter(Boolean).length;
  const recognised = category !== undefined || HIGH_PRIORITY.test(text) || explicit !== undefined;
  let confidence: number;
  if (!recognised && !t.due && words <= 2) confidence = 0.35;
  else if (recognised && t.due) confidence = 0.8;
  else if (recognised || t.due || notes.length > 0) confidence = 0.7;
  else confidence = 0.55;

  return {
    taskId: t.id,
    durationMin,
    priority,
    urgency,
    confidence,
    minChunkMin,
    deepWork,
    rationale: `heuristic: ${why.join(', ')}`,
  };
}

function pickCategory(text: string): Category | undefined {
  const deep = CATEGORIES.slice(0, 4).find((c) => c.pattern.test(text));
  if (deep) return deep;
  let best: { c: Category; at: number } | undefined;
  for (const c of CATEGORIES.slice(4)) {
    const m = c.pattern.exec(text);
    if (m && (best === undefined || m.index < best.at)) best = { c, at: m.index };
  }
  return best?.c;
}

function explicitDuration(text: string): number | undefined {
  const m = EXPLICIT_DURATION.exec(text);
  if (!m?.[1] || !m[2]) return undefined;
  const value = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const minutes = /^(h|hr|hrs|hour|hours|std|stunde|stunden)$/.test(m[2]) ? value * 60 : value;
  return minutes >= 5 && minutes <= 8 * 60 ? minutes : undefined;
}

function urgencyFor(due: Date | undefined, now: Date, text: string): number {
  let urgency = 2;
  if (due) {
    const days = (due.getTime() - now.getTime()) / DAY_MS;
    if (days <= 1) urgency = 5;
    else if (days <= 2) urgency = 4;
    else if (days <= 4) urgency = 3;
    else if (days <= 10) urgency = 2;
    else urgency = 1;
  }
  if (URGENT_WORDS.test(text)) urgency = Math.max(urgency, 4);
  return urgency;
}

export function templateReason(c: ExplainRequest['changes'][number], timezone: string): string {
  const cause = c.cause.trim().replace(/\.$/, '');
  switch (c.kind) {
    case 'moved':
      if (cause) return tidyReason(`Moved because ${lowerFirst(cause)}`);
      return tidyReason(c.to ? `Moved to ${shortLocal(c.to.start, timezone)} to fit your day` : 'Moved to fit your day');
    case 'dropped':
      return tidyReason(cause ? `Removed because ${lowerFirst(cause)}` : 'Removed: no time left before the due date');
    case 'created':
    default:
      return tidyReason(cause ? `Planned here: ${lowerFirst(cause)}` : 'Planned in a free slot before the due date');
  }
}

function lowerFirst(s: string): string {
  // Keep acronyms / proper nouns ("Tempo", "LMU") as they are.
  if (s.length > 1 && s[1] === s[1]?.toUpperCase() && /[A-Z]/.test(s[1] ?? '')) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}
