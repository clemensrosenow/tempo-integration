/**
 * Base for LLM adapters that answer with schema-constrained JSON.
 *
 * Subclasses only implement `completeJson` (one model call returning the raw
 * JSON text). This class builds prompts, validates with zod and falls back to
 * the deterministic HeuristicLlm on any network / validation error, so an LLM
 * problem never throws into the planning pipeline.
 */
import type { ExplainRequest, LlmPort, PlaceRequest, Placement, UnderstandRequest } from '../core/ports.js';
import type { TaskEstimate } from '../core/types.js';
import { HeuristicLlm } from './heuristic.js';
import {
  explainPrompt,
  type JsonPrompt,
  parseExplain,
  parsePlace,
  parseUnderstand,
  placePrompt,
  understandPrompt,
} from './prompts.js';

export type LlmLogger = (message: string) => void;

export interface JsonLlmOptions {
  /** Where fallback warnings go. Default: console.warn. */
  log?: LlmLogger;
  /** Tasks per Understand call. Default 20. */
  understandBatchSize?: number;
}

export abstract class JsonLlm implements LlmPort {
  abstract readonly name: string;
  protected readonly fallback = new HeuristicLlm();
  protected readonly log: LlmLogger;
  private readonly batchSize: number;

  protected constructor(opts: JsonLlmOptions = {}) {
    this.log = opts.log ?? ((m) => console.warn(m));
    this.batchSize = Math.max(1, opts.understandBatchSize ?? 20);
  }

  /** One model call. Must resolve to the model's JSON text (or throw). */
  protected abstract completeJson(prompt: JsonPrompt): Promise<string>;

  async understand(req: UnderstandRequest): Promise<TaskEstimate[]> {
    if (req.tasks.length === 0) return [];
    const batches: UnderstandRequest[] = [];
    for (let i = 0; i < req.tasks.length; i += this.batchSize) {
      batches.push({ ...req, tasks: req.tasks.slice(i, i + this.batchSize) });
    }
    const results = await Promise.all(batches.map((b) => this.understandBatch(b)));
    return results.flat();
  }

  private async understandBatch(req: UnderstandRequest): Promise<TaskEstimate[]> {
    const fromModel = await this.tryCall('understand', understandPrompt(req), (raw) => parseUnderstand(raw, req));
    const heuristic = await this.fallback.understand(req);
    if (!fromModel) return heuristic;
    const missing = req.tasks.filter((t) => !fromModel.has(t.id)).map((t) => t.id);
    if (missing.length > 0) this.log(`[${this.name}] understand: no estimate for ${missing.join(', ')}; using heuristic`);
    return heuristic.map((h) => fromModel.get(h.taskId) ?? h);
  }

  async place(req: PlaceRequest): Promise<Placement[] | null> {
    if (req.tasks.length === 0) return [];
    if (req.gaps.length === 0) return [];
    const placements = await this.tryCall('place', placePrompt(req), (raw) => parsePlace(raw, req));
    // null = let the core's deterministic greedy placer take over.
    return placements ?? null;
  }

  async explain(req: ExplainRequest): Promise<Record<string, string>> {
    if (req.changes.length === 0) return {};
    const fromModel = await this.tryCall('explain', explainPrompt(req), (raw) => parseExplain(raw, req));
    const out = await this.fallback.explain(req);
    if (fromModel) for (const [taskId, reason] of fromModel) out[taskId] = reason;
    return out;
  }

  /** Call + JSON.parse + validate. Returns undefined (after logging) on any failure. */
  private async tryCall<T>(step: string, prompt: JsonPrompt, validate: (raw: unknown) => T): Promise<T | undefined> {
    try {
      const text = await this.completeJson(prompt);
      return validate(JSON.parse(stripFences(text)));
    } catch (err) {
      this.log(`[${this.name}] ${step} failed, falling back to heuristic: ${describe(err)}`);
      return undefined;
    }
  }
}

/** Tolerate ```json fences in case a model ignores the JSON mode. */
function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m?.[1] ?? t;
}

function describe(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return String(err).slice(0, 500);
}
