/**
 * Gemini adapter (@google/genai, JSON mode with a response JSON schema).
 * Same prompts, validation and heuristic fallback as the Anthropic adapter.
 */
import { GoogleGenAI, type GenerateContentParameters, ThinkingLevel } from '@google/genai';
import { JsonLlm, type JsonLlmOptions } from './jsonLlm.js';
import type { JsonPrompt } from './prompts.js';

/** Current GA Flash model (ai.google.dev model page, Nov 2026). */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';

/** Minimal response shape Tempo reads (the SDK's GenerateContentResponse satisfies it). */
export interface GeminiLikeResponse {
  readonly text?: string | undefined;
  candidates?: Array<{ finishReason?: string }> | undefined;
}

/** The slice of the SDK client Tempo uses; inject a fake in tests. */
export interface GeminiModelsClient {
  models: { generateContent(params: GenerateContentParameters): Promise<GeminiLikeResponse> };
}

export interface GeminiLlmOptions extends JsonLlmOptions {
  apiKey?: string;
  model?: string;
  /** Injected client (tests). When set, apiKey is ignored. */
  client?: GeminiModelsClient;
  /** Per-request timeout in ms. Default 60 s. */
  timeoutMs?: number;
}

export class GeminiLlm extends JsonLlm {
  readonly name: string;
  readonly model: string;
  private readonly client: GeminiModelsClient;
  private readonly timeoutMs: number;

  constructor(opts: GeminiLlmOptions = {}) {
    super(opts);
    this.model = opts.model ?? DEFAULT_GEMINI_MODEL;
    this.name = `gemini:${this.model}`;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    if (opts.client) {
      this.client = opts.client;
    } else {
      if (!opts.apiKey) throw new Error('GeminiLlm needs an apiKey (GEMINI_API_KEY or GOOGLE_API_KEY)');
      // Explicit key + Gemini Developer API, never Vertex via ambient env vars.
      this.client = new GoogleGenAI({ apiKey: opts.apiKey, vertexai: false });
    }
  }

  protected async completeJson(prompt: JsonPrompt): Promise<string> {
    const res = await this.client.models.generateContent({
      model: this.model,
      contents: [{ role: 'user', parts: [{ text: prompt.user }] }],
      config: {
        systemInstruction: prompt.system,
        responseMimeType: 'application/json',
        responseJsonSchema: prompt.schema,
        maxOutputTokens: prompt.maxTokens,
        thinkingConfig: { thinkingLevel: prompt.step === 'place' ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW },
        httpOptions: { timeout: this.timeoutMs },
      },
    });
    const finish = res.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP') throw new Error(`generation stopped: ${finish}`);
    const text = res.text;
    if (!text?.trim()) throw new Error('empty response');
    return text;
  }
}
