/**
 * Runtime configuration from environment variables (and `<repo>/.env`).
 *
 * Credentials are only ever taken from the variables documented in
 * `.env.example`. In particular ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL are
 * ignored: on developer machines they often belong to other tools.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { DEBOUNCE_MS } from './core/types.js';

export type LlmProvider = 'anthropic' | 'gemini' | 'heuristic';

export interface LlmConfig {
  provider: LlmProvider;
  /** Model id override (TEMPO_LLM_MODEL); adapters have sensible defaults. */
  model?: string;
  apiKey?: string;
  /** Anthropic only: TEMPO_ANTHROPIC_BASE_URL or https://api.anthropic.com. */
  baseURL?: string;
}

export interface TempoConfig {
  dataDir: string;
  /** User-editable settings (working hours, busy calendars): TEMPO_SETTINGS or `<repo>/tempo.json`. */
  settingsFile: string;
  llm: LlmConfig;
  horizonDays: number;
  pollIntervalSec: number;
  debounceMs: number;
  webhook?: { publicUrl: string; port: number };
  google?: { clientId: string; clientSecret: string };
  /** Non-fatal configuration problems (e.g. TEMPO_LLM=anthropic without a key). */
  warnings: string[];
}

export type Env = Record<string, string | undefined>;

export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';

/** Repository root (works from `src/` via tsx and from `dist/` after build). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface LoadConfigOptions {
  /** Environment to read; defaults to `process.env` (after loading `.env`). */
  env?: Env;
  /** Path of the .env file, or `false` to skip loading it. Default `<repo>/.env`. */
  dotenvPath?: string | false;
}

export function loadConfig(opts: LoadConfigOptions = {}): TempoConfig {
  const dotenvPath = opts.dotenvPath ?? path.join(REPO_ROOT, '.env');
  if (dotenvPath !== false && opts.env === undefined) {
    // Never overrides variables already set in the shell.
    dotenv.config({ path: dotenvPath, quiet: true });
  }
  const env: Env = opts.env ?? process.env;
  const warnings: string[] = [];

  const llm = resolveLlmConfig(env, warnings);
  const config: TempoConfig = {
    dataDir: path.resolve(nonEmpty(env.TEMPO_DATA_DIR) ?? path.join(REPO_ROOT, '.tempo')),
    settingsFile: path.resolve(nonEmpty(env.TEMPO_SETTINGS) ?? path.join(REPO_ROOT, 'tempo.json')),
    llm,
    horizonDays: positiveInt(env, 'TEMPO_HORIZON_DAYS', 14, warnings),
    pollIntervalSec: positiveInt(env, 'TEMPO_POLL_INTERVAL_SEC', 60, warnings),
    debounceMs: positiveInt(env, 'TEMPO_DEBOUNCE_MS', DEBOUNCE_MS, warnings),
    warnings,
  };

  const publicUrl = nonEmpty(env.TEMPO_WEBHOOK_URL);
  if (publicUrl) {
    config.webhook = { publicUrl, port: positiveInt(env, 'TEMPO_WEBHOOK_PORT', 8787, warnings) };
  }
  const clientId = nonEmpty(env.GOOGLE_CLIENT_ID);
  const clientSecret = nonEmpty(env.GOOGLE_CLIENT_SECRET);
  if (clientId && clientSecret) config.google = { clientId, clientSecret };
  return config;
}

/**
 * Provider selection: explicit TEMPO_LLM wins; else an Anthropic key
 * (TEMPO_ANTHROPIC_API_KEY, ANTHROPIC_API_KEY) selects anthropic; else a
 * Gemini key (GEMINI_API_KEY, GOOGLE_API_KEY) selects gemini; else heuristic.
 * An explicit provider without a key degrades to heuristic with a warning.
 */
export function resolveLlmConfig(env: Env, warnings: string[] = []): LlmConfig {
  const anthropicKey = nonEmpty(env.TEMPO_ANTHROPIC_API_KEY) ?? nonEmpty(env.ANTHROPIC_API_KEY);
  const geminiKey = nonEmpty(env.GEMINI_API_KEY) ?? nonEmpty(env.GOOGLE_API_KEY);
  const model = nonEmpty(env.TEMPO_LLM_MODEL);
  const explicit = nonEmpty(env.TEMPO_LLM)?.toLowerCase();

  const anthropic = (): LlmConfig => ({
    provider: 'anthropic',
    apiKey: anthropicKey,
    baseURL: nonEmpty(env.TEMPO_ANTHROPIC_BASE_URL) ?? DEFAULT_ANTHROPIC_BASE_URL,
    ...(model ? { model } : {}),
  });
  const gemini = (): LlmConfig => ({ provider: 'gemini', apiKey: geminiKey, ...(model ? { model } : {}) });
  const heuristic = (): LlmConfig => ({ provider: 'heuristic' });

  if (explicit) {
    switch (explicit) {
      case 'anthropic':
      case 'claude':
        if (anthropicKey) return anthropic();
        warnings.push('TEMPO_LLM=anthropic but no TEMPO_ANTHROPIC_API_KEY/ANTHROPIC_API_KEY set; using heuristic estimates.');
        return heuristic();
      case 'gemini':
      case 'google':
        if (geminiKey) return gemini();
        warnings.push('TEMPO_LLM=gemini but no GEMINI_API_KEY/GOOGLE_API_KEY set; using heuristic estimates.');
        return heuristic();
      case 'heuristic':
      case 'none':
      case 'off':
        return heuristic();
      default:
        warnings.push(`Unknown TEMPO_LLM="${explicit}" (expected anthropic | gemini | heuristic); using heuristic.`);
        return heuristic();
    }
  }
  if (anthropicKey) return anthropic();
  if (geminiKey) return gemini();
  return heuristic();
}

function nonEmpty(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function positiveInt(env: Env, name: string, fallback: number, warnings: string[]): number {
  const raw = nonEmpty(env[name]);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    warnings.push(`${name}="${raw}" is not a positive number; using ${fallback}.`);
    return fallback;
  }
  return Math.round(n);
}
