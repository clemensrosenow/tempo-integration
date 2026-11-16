/**
 * StateStore persisted as `<dataDir>/state.json`.
 *
 * - atomic: write a temp file in the same directory, fsync, rename
 * - private: directory 0700, file 0600 (the state holds the user's e-mail,
 *   preferences and question queue)
 * - Dates survive the round trip (see ./state.ts)
 */
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { StateStore, TempoState } from '../core/ports.js';
import { defaultState, deserializeState, serializeState } from './state.js';

export { defaultState } from './state.js';

export const STATE_FILE = 'state.json';

export class FileStateStore implements StateStore {
  readonly file: string;
  /** Serialises concurrent saves so the last call wins deterministically. */
  private queue: Promise<void> = Promise.resolve();

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, STATE_FILE);
  }

  async load(): Promise<TempoState> {
    let json: string;
    try {
      json = await fs.readFile(this.file, 'utf8');
    } catch (err) {
      if (isNotFound(err)) return defaultState();
      throw err;
    }
    try {
      return deserializeState(json);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot read ${this.file}: ${msg}`, { cause: err });
    }
  }

  save(state: TempoState): Promise<void> {
    const json = serializeState(state);
    const run = this.queue.then(() => this.writeAtomic(json));
    // Keep the chain alive even if one write fails.
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async writeAtomic(json: string): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = path.join(this.dataDir, `.${STATE_FILE}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(tmp, 'w', 0o600);
      await handle.writeFile(json, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await fs.rename(tmp, this.file);
      // The mode on open() is masked by umask; enforce 0600 explicitly.
      await fs.chmod(this.file, 0o600);
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}
