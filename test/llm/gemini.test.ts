import type { GenerateContentParameters } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { GeminiLlm, type GeminiLikeResponse, type GeminiModelsClient } from '../../src/llm/gemini.js';
import { HeuristicLlm } from '../../src/llm/heuristic.js';
import { UNDERSTAND_SCHEMA } from '../../src/llm/prompts.js';
import {
  explainReq,
  goodExplainJson,
  goodPlaceJson,
  goodUnderstandJson,
  logSink,
  placeReq,
  understandReq,
} from './fixtures.js';

function fakeClient(reply: () => GeminiLikeResponse) {
  const calls: GenerateContentParameters[] = [];
  const client: GeminiModelsClient = {
    models: {
      generateContent: async (p) => {
        calls.push(p);
        return reply();
      },
    },
  };
  return { client, calls };
}

const ok = (text: string): GeminiLikeResponse => ({ text, candidates: [{ finishReason: 'STOP' }] });

describe('GeminiLlm', () => {
  it('requests JSON mode with the shared schema and parses estimates', async () => {
    const { client, calls } = fakeClient(() => ok(goodUnderstandJson));
    const llm = new GeminiLlm({ client, log: logSink().log });
    const out = await llm.understand(understandReq);
    expect(out.map((e) => e.durationMin)).toEqual([200, 10]);
    const cfg = calls[0]?.config;
    expect(calls[0]?.model).toBe('gemini-3.8-flash');
    expect(cfg?.responseMimeType).toBe('application/json');
    expect(cfg?.responseJsonSchema).toEqual(UNDERSTAND_SCHEMA);
    expect(typeof cfg?.systemInstruction).toBe('string');
  });

  it('falls back to the heuristic on invalid JSON', async () => {
    const sink = logSink();
    const { client } = fakeClient(() => ok('not json at all'));
    const out = await new GeminiLlm({ client, log: sink.log }).understand(understandReq);
    expect(out).toEqual(await new HeuristicLlm().understand(understandReq));
    expect(sink.lines).toHaveLength(1);
  });

  it('falls back when generation is truncated or the call throws', async () => {
    const truncated = fakeClient(() => ({ text: '{"reasons": [', candidates: [{ finishReason: 'MAX_TOKENS' }] }));
    expect(await new GeminiLlm({ client: truncated.client, log: logSink().log }).explain(explainReq)).toEqual(
      await new HeuristicLlm().explain(explainReq),
    );
    const failing = fakeClient(() => {
      throw new Error('429 quota');
    });
    expect(await new GeminiLlm({ client: failing.client, log: logSink().log }).place(placeReq)).toBeNull();
  });

  it('parses placements and explanations', async () => {
    const place = fakeClient(() => ok(goodPlaceJson));
    const placements = await new GeminiLlm({ client: place.client, log: logSink().log }).place(placeReq);
    expect(placements?.[0]?.start.toISOString()).toBe('2026-11-16T09:00:00.000Z');

    const explain = fakeClient(() => ok(goodExplainJson));
    const reasons = await new GeminiLlm({ client: explain.client, log: logSink().log }).explain(explainReq);
    expect(reasons.t1).toMatch(/project meeting/);
    expect(reasons.t2).toBeTruthy();
  });

  it('honours a model override and needs a key without a client', () => {
    expect(new GeminiLlm({ client: fakeClient(() => ok('{}')).client, model: 'gemini-3.6-flash' }).name).toBe('gemini:gemini-3.6-flash');
    expect(() => new GeminiLlm({})).toThrow(/apiKey/);
  });
});
