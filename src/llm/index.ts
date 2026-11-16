import type { LlmConfig } from '../config.js';
import type { LlmPort } from '../core/ports.js';
import { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL } from './anthropic.js';
import { DEFAULT_GEMINI_MODEL, GeminiLlm } from './gemini.js';
import { HeuristicLlm } from './heuristic.js';
import type { LlmLogger } from './jsonLlm.js';

export { AnthropicLlm, DEFAULT_ANTHROPIC_MODEL, DEFAULT_GEMINI_MODEL, GeminiLlm, HeuristicLlm };

/** Build the configured LLM. A provider without an API key degrades to the heuristic. */
export function createLlm(config: LlmConfig, opts: { log?: LlmLogger } = {}): LlmPort {
  const log = opts.log ?? ((m: string) => console.warn(m));
  switch (config.provider) {
    case 'anthropic':
      if (config.apiKey) {
        return new AnthropicLlm({ apiKey: config.apiKey, model: config.model, baseURL: config.baseURL, log });
      }
      break;
    case 'gemini':
      if (config.apiKey) return new GeminiLlm({ apiKey: config.apiKey, model: config.model, log });
      break;
    case 'heuristic':
      return new HeuristicLlm();
  }
  log(`[llm] ${config.provider} selected but no API key configured; using heuristic`);
  return new HeuristicLlm();
}
