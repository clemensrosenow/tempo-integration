/** In-memory StateStore for tests. Stores deep copies so callers can't mutate it by accident. */
import type { StateStore, TempoState } from '../core/ports.js';
import { defaultState } from './state.js';

export class MemoryStateStore implements StateStore {
  private state: TempoState;
  saves = 0;

  constructor(initial: TempoState = defaultState()) {
    this.state = structuredClone(initial);
  }

  async load(): Promise<TempoState> {
    return structuredClone(this.state);
  }

  async save(state: TempoState): Promise<void> {
    this.state = structuredClone(state);
    this.saves += 1;
  }

  /** Synchronous peek for assertions. */
  snapshot(): TempoState {
    return structuredClone(this.state);
  }
}
