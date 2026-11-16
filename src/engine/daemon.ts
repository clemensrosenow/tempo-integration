/**
 * Continuous planning (E5): poll on an interval (Google Tasks has no push
 * notifications, so polling is always needed), and — if a public webhook URL
 * is configured — also react immediately to Google Calendar push
 * notifications. The engine itself debounces bursts (E8).
 */
import type { StateStore } from '../core/ports.js';
import { errorMessage, type TempoEngine } from './engine.js';

export interface WatchApi {
  start(calendarId: string, address: string, channelId: string): Promise<{ id: string; resourceId: string; expiration: string }>;
  stop(channelId: string, resourceId: string): Promise<void>;
  createServer(opts: { port: number; onNotification: (channelId: string) => void }): { close(): void };
}

export interface DaemonOptions {
  engine: Pick<TempoEngine, 'tick'>;
  pollIntervalSec: number;
  webhook?: { publicUrl: string; port: number };
  calendarIds: string[];
  watch?: WatchApi;
  store: StateStore;
  log: (line: string) => void;
  /** Resolves when the daemon should stop (default: SIGINT/SIGTERM). */
  until?: Promise<void>;
}

export async function startDaemon(opts: DaemonOptions): Promise<void> {
  const { engine, log } = opts;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const runTick = async (why: string) => {
    try {
      const r = await engine.tick();
      if (r.outcome !== 'idle') log(`${why}: ${r.outcome}, ${r.applied.length} change(s)`);
    } catch (err) {
      log(`${why}: tick failed: ${errorMessage(err)}`);
    }
  };

  // Calendar push notifications (optional).
  let server: { close(): void } | undefined;
  const channels: Array<{ id: string; resourceId: string; expiration: string }> = [];
  if (opts.webhook && opts.watch) {
    const watch = opts.watch;
    let pending: NodeJS.Timeout | undefined;
    server = watch.createServer({
      port: opts.webhook.port,
      onNotification: () => {
        // Coalesce notification storms; the engine debounces user bursts on top.
        if (pending) clearTimeout(pending);
        pending = setTimeout(() => void runTick('push'), 2_000);
      },
    });
    const publicUrl = opts.webhook.publicUrl;
    // Channels expire (Google sets the TTL); renew each one an hour before it does.
    const startChannel = async (calendarId: string): Promise<void> => {
      try {
        const ch = await watch.start(calendarId, publicUrl, `tempo-${randomId()}`);
        channels.push(ch);
        log(`watching ${calendarId} until ${ch.expiration || 'unknown'}`);
        const expiresAt = ch.expiration ? new Date(ch.expiration).getTime() : NaN;
        if (Number.isFinite(expiresAt)) {
          const renewIn = Math.max(60_000, expiresAt - Date.now() - 3_600_000);
          const t = setTimeout(async () => {
            if (stopped) return;
            await startChannel(calendarId);
            await watch.stop(ch.id, ch.resourceId).catch(() => undefined);
            channels.splice(channels.indexOf(ch), 1);
          }, Math.min(renewIn, 2_147_000_000));
          t.unref();
        }
      } catch (err) {
        log(`could not watch ${calendarId} (polling still active): ${errorMessage(err)}`);
      }
    };
    for (const calendarId of opts.calendarIds) await startChannel(calendarId);
    const state = await opts.store.load();
    state.channels = channels.map((c, i) => ({ ...c, calendarId: opts.calendarIds[i] ?? '' }));
    await opts.store.save(state);
  }

  log(`Tempo is running — polling every ${opts.pollIntervalSec}s${server ? ' + calendar push' : ''}. Ctrl-C to stop.`);
  await runTick('start');
  const loop = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runTick('poll');
      loop();
    }, opts.pollIntervalSec * 1000);
  };
  loop();

  const until =
    opts.until ??
    new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
  await until;
  stopped = true;
  if (timer) clearTimeout(timer);
  server?.close();
  for (const ch of channels) await opts.watch?.stop(ch.id, ch.resourceId).catch(() => undefined);
  log('stopped');
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}
