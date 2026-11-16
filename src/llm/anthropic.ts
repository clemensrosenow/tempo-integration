/**
 * Claude adapter (Anthropic Messages API, structured JSON outputs).
 *
 * The client is constructed explicitly from Tempo's own config: `apiKey`,
 * `authToken: null` and an explicit `baseURL`, so ANTHROPIC_AUTH_TOKEN /
 * ANTHROPIC_BASE_URL set for other tools are never picked up.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { DEFAULT_ANTHROPIC_BASE_URL } from '../config.js';
import { JsonLlm, type JsonLlmOptions } from './jsonLlm.js';
import type { JsonPrompt } from './prompts.js';

/** Current Sonnet-class model: cheap and good enough for estimation/placement. */
export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** Minimal message shape Tempo reads from a response (the SDK's BetaMessage satisfies it). */
export interface AnthropicLikeMessage {
  content: Array<{ type: string; text?: string }>;
  stop_reason: string | null;
}

/** The slice of the SDK client Tempo uses; inject a fake in tests. */
export interface AnthropicMessagesClient {
  beta: {
    messages: {
      create(params: MessageCreateParamsNonStreaming, options?: { timeout?: number }): PromiseLike<AnthropicLikeMessage>;
    };
  };
}

export interface AnthropicLlmOptions extends JsonLlmOptions {
  apiKey?: string;
  model?: string;
  baseURL?: string;
  /** Injected client (tests). When set, apiKey/baseURL are ignored. */
  client?: AnthropicMessagesClient;
  /** Per-request timeout in ms. Default 60 s. */
  timeoutMs?: number;
}

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
const SERVER_FALLBACK_MODELS = /^claude-(fable-5-[12]|mythos-5-[12]|opus-5|opus-5-5|sonnet-5-5)$/;
/** Models that accept `output_config.effort`. */
const EFFORT_MODELS = /^claude-(fable|mythos|opus-5|opus-4-[5-8]|sonnet-5|sonnet-4-6|haiku-5)/;

export class AnthropicLlm extends JsonLlm {
  readonly name: string;
  readonly model: string;
  private readonly client: AnthropicMessagesClient;
  private readonly timeoutMs: number;

  constructor(opts: AnthropicLlmOptions = {}) {
    super(opts);
    this.model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.name = `anthropic:${this.model}`;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) throw new Error('AnthropicLlm needs an apiKey (TEMPO_ANTHROPIC_API_KEY or ANTHROPIC_API_KEY)');
      this.client = new Anthropic({
        apiKey: opts.apiKey,
        authToken: null,
        baseURL: opts.baseURL ?? DEFAULT_ANTHROPIC_BASE_URL,
        maxRetries: 2,
        timeout: this.timeoutMs,
      });
    }
  }

  protected async completeJson(prompt: JsonPrompt): Promise<string> {
    const params: MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: prompt.maxTokens,
      system: prompt.system,
      messages: [{ role: 'user', content: prompt.user }],
      output_config: {
        format: { type: 'json_schema', schema: prompt.schema },
        // Estimation and one-liners are routine work: low effort keeps cost and latency down.
        ...(EFFORT_MODELS.test(this.model) ? { effort: prompt.step === 'place' ? 'medium' : 'low' } : {}),
      },
      ...(SERVER_FALLBACK_MODELS.test(this.model)
        ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
        : {}),
    };
    const msg = await this.client.beta.messages.create(params, { timeout: this.timeoutMs });
    if (msg.stop_reason === 'refusal') throw new Error('model refused the request');
    if (msg.stop_reason === 'max_tokens') throw new Error('response truncated (max_tokens)');
    const text = msg.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('');
    if (!text.trim()) throw new Error(`empty response (stop_reason=${msg.stop_reason ?? 'null'})`);
    return text;
  }
}
