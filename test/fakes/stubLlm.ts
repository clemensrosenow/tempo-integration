/**
 * Deterministic LlmPort stub for core tests.
 * - understand: fixed estimates per task title (fallback: `defaultEstimate`).
 * - place: returns null by default (→ greedy placer); configurable with a list
 *   of placement attempts (consumed one per call) or a function.
 * - explain: returns `explanations` (per task id), default {} (→ template reasons).
 * All requests are recorded in `calls` for assertions on the seam's behaviour.
 */
import type {
  ExplainRequest,
  LlmPort,
  Placement,
  PlaceRequest,
  UnderstandRequest,
} from '../../src/core/ports.js';
import type { TaskEstimate } from '../../src/core/types.js';

export type EstimateSpec = Partial<Omit<TaskEstimate, 'taskId'>>;

export interface StubLlmOptions {
  /** Estimates keyed by task title. */
  estimates?: Record<string, EstimateSpec>;
  defaultEstimate?: EstimateSpec;
  /** Placement answers, one per `place` call (then null), or a function. */
  placements?: Array<Placement[] | null> | ((req: PlaceRequest, call: number) => Placement[] | null);
  explanations?: Record<string, string>;
}

const BASE: Omit<TaskEstimate, 'taskId'> = {
  durationMin: 60,
  priority: 3,
  urgency: 2,
  confidence: 0.9,
  minChunkMin: 30,
  deepWork: false,
};

export class StubLlm implements LlmPort {
  readonly name = 'stub';
  readonly calls: { understand: UnderstandRequest[]; place: PlaceRequest[]; explain: ExplainRequest[] } = {
    understand: [],
    place: [],
    explain: [],
  };

  constructor(private readonly opts: StubLlmOptions = {}) {}

  async understand(req: UnderstandRequest): Promise<TaskEstimate[]> {
    this.calls.understand.push(req);
    return req.tasks.map((t) => ({
      taskId: t.id,
      ...BASE,
      ...this.opts.defaultEstimate,
      ...this.opts.estimates?.[t.title],
    }));
  }

  async place(req: PlaceRequest): Promise<Placement[] | null> {
    const call = this.calls.place.length;
    this.calls.place.push(req);
    const p = this.opts.placements;
    if (!p) return null;
    if (typeof p === 'function') return p(req, call);
    return p[call] ?? null;
  }

  async explain(req: ExplainRequest): Promise<Record<string, string>> {
    this.calls.explain.push(req);
    return { ...this.opts.explanations };
  }
}

export function stubLlm(opts: StubLlmOptions = {}): StubLlm {
  return new StubLlm(opts);
}
