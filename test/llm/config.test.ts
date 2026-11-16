import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEBOUNCE_MS } from '../../src/core/types.js';
import { loadConfig, REPO_ROOT, resolveLlmConfig } from '../../src/config.js';
import { AnthropicLlm } from '../../src/llm/anthropic.js';
import { GeminiLlm } from '../../src/llm/gemini.js';
import { HeuristicLlm } from '../../src/llm/heuristic.js';
import { createLlm } from '../../src/llm/index.js';

describe('LLM provider selection', () => {
  it('defaults to heuristic without keys', () => {
    expect(resolveLlmConfig({})).toEqual({ provider: 'heuristic' });
  });

  it('does NOT select anthropic from ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL alone', () => {
    const llm = resolveLlmConfig({ ANTHROPIC_AUTH_TOKEN: 'tok', ANTHROPIC_BASE_URL: 'https://proxy.example' });
    expect(llm.provider).toBe('heuristic');
  });

  it('selects anthropic from TEMPO_ANTHROPIC_API_KEY, preferring it over ANTHROPIC_API_KEY', () => {
    const llm = resolveLlmConfig({
      TEMPO_ANTHROPIC_API_KEY: 'tempo-key',
      ANTHROPIC_API_KEY: 'generic-key',
      ANTHROPIC_BASE_URL: 'https://proxy.example',
    });
    expect(llm).toEqual({ provider: 'anthropic', apiKey: 'tempo-key', baseURL: 'https://api.anthropic.com' });
    expect(resolveLlmConfig({ ANTHROPIC_API_KEY: 'generic-key' }).apiKey).toBe('generic-key');
  });

  it('uses TEMPO_ANTHROPIC_BASE_URL and TEMPO_LLM_MODEL', () => {
    const llm = resolveLlmConfig({
      ANTHROPIC_API_KEY: 'k',
      TEMPO_ANTHROPIC_BASE_URL: 'https://tempo.example',
      TEMPO_LLM_MODEL: 'claude-opus-5-5',
    });
    expect(llm).toMatchObject({ baseURL: 'https://tempo.example', model: 'claude-opus-5-5' });
  });

  it('selects gemini from GEMINI_API_KEY or GOOGLE_API_KEY when no Anthropic key', () => {
    expect(resolveLlmConfig({ GEMINI_API_KEY: 'g' })).toEqual({ provider: 'gemini', apiKey: 'g' });
    expect(resolveLlmConfig({ GOOGLE_API_KEY: 'g2' }).provider).toBe('gemini');
    expect(resolveLlmConfig({ GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).provider).toBe('anthropic');
  });

  it('lets TEMPO_LLM win', () => {
    expect(resolveLlmConfig({ TEMPO_LLM: 'gemini', GEMINI_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' }).provider).toBe('gemini');
    expect(resolveLlmConfig({ TEMPO_LLM: 'heuristic', ANTHROPIC_API_KEY: 'a' }).provider).toBe('heuristic');
  });

  it('degrades an explicit provider without a key to heuristic with a warning', () => {
    const warnings: string[] = [];
    expect(resolveLlmConfig({ TEMPO_LLM: 'anthropic', ANTHROPIC_AUTH_TOKEN: 'tok' }, warnings).provider).toBe('heuristic');
    expect(warnings[0]).toMatch(/no TEMPO_ANTHROPIC_API_KEY/);
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig({ env: {} });
    expect(c.dataDir).toBe(path.join(REPO_ROOT, '.tempo'));
    expect(c.horizonDays).toBe(14);
    expect(c.pollIntervalSec).toBe(60);
    expect(c.debounceMs).toBe(DEBOUNCE_MS);
    expect(c.webhook).toBeUndefined();
    expect(c.llm.provider).toBe('heuristic');
    expect(c.warnings).toEqual([]);
  });

  it('reads overrides and the webhook', () => {
    const c = loadConfig({
      env: {
        TEMPO_DATA_DIR: '/tmp/tempo-test',
        TEMPO_HORIZON_DAYS: '7',
        TEMPO_POLL_INTERVAL_SEC: '30',
        TEMPO_DEBOUNCE_MS: '1000',
        TEMPO_WEBHOOK_URL: 'https://hook.example/tempo',
        TEMPO_WEBHOOK_PORT: '9000',
        GOOGLE_CLIENT_ID: 'id',
        GOOGLE_CLIENT_SECRET: 'secret',
      },
    });
    expect(c).toMatchObject({
      dataDir: '/tmp/tempo-test',
      horizonDays: 7,
      pollIntervalSec: 30,
      debounceMs: 1000,
      webhook: { publicUrl: 'https://hook.example/tempo', port: 9000 },
      google: { clientId: 'id', clientSecret: 'secret' },
    });
  });

  it('warns about invalid numbers', () => {
    const c = loadConfig({ env: { TEMPO_HORIZON_DAYS: 'two weeks' } });
    expect(c.horizonDays).toBe(14);
    expect(c.warnings).toHaveLength(1);
  });
});

describe('createLlm', () => {
  it('builds the configured adapter', () => {
    const log = () => undefined;
    expect(createLlm({ provider: 'heuristic' }, { log })).toBeInstanceOf(HeuristicLlm);
    expect(createLlm({ provider: 'anthropic', apiKey: 'k', baseURL: 'https://api.anthropic.com' }, { log })).toBeInstanceOf(AnthropicLlm);
    expect(createLlm({ provider: 'gemini', apiKey: 'k' }, { log })).toBeInstanceOf(GeminiLlm);
    expect(createLlm({ provider: 'anthropic' }, { log })).toBeInstanceOf(HeuristicLlm);
  });
});
