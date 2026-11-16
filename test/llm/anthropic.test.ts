import Anthropic from '@anthropic-ai/sdk';
import type { MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicLlm, type AnthropicLikeMessage, type AnthropicMessagesClient } from '../../src/llm/anthropic.js';
import { HeuristicLlm } from '../../src/llm/heuristic.js';
import {
  explainReq,
  goodExplainJson,
  goodPlaceJson,
  goodUnderstandJson,
  logSink,
  placeReq,
  understandReq,
} from './fixtures.js';

function textMessage(text: string, stop_reason = 'end_turn'): AnthropicLikeMessage {
  return { content: [{ type: 'text', text }], stop_reason };
}

function fakeClient(reply: (p: MessageCreateParamsNonStreaming) => AnthropicLikeMessage | Promise<AnthropicLikeMessage>) {
  const calls: MessageCreateParamsNonStreaming[] = [];
  const client: AnthropicMessagesClient = {
    beta: {
      messages: {
        create: async (p) => {
          calls.push(p);
          return reply(p);
        },
      },
    },
  };
  return { client, calls };
}

describe('AnthropicLlm', () => {
  it('parses and clamps structured estimates, dropping unknown ids', async () => {
    const { client, calls } = fakeClient(() => textMessage(goodUnderstandJson));
    const llm = new AnthropicLlm({ client, log: logSink().log });
    const out = await llm.understand(understandReq);
    expect(out.map((e) => e.taskId)).toEqual(['t1', 't2']);
    expect(out[0]).toMatchObject({ durationMin: 200, priority: 4, deepWork: true, confidence: 0.9 });
    expect(out[1]).toMatchObject({ durationMin: 10, minChunkMin: 10 });

    const p = calls[0];
    expect(p?.model).toBe('claude-sonnet-5-5');
    expect(p?.output_config?.format?.type).toBe('json_schema');
    expect(typeof p?.system).toBe('string');
    // Dates go into the prompt with the user's offset.
    expect(JSON.stringify(p?.messages)).toContain('2026-11-20T00:00:00+01:00');
  });

  it('honours a model override', async () => {
    const { client, calls } = fakeClient(() => textMessage(goodExplainJson));
    const llm = new AnthropicLlm({ client, model: 'claude-haiku-5-5', log: logSink().log });
    await llm.explain(explainReq);
    expect(calls[0]?.model).toBe('claude-haiku-5-5');
    expect(llm.name).toBe('anthropic:claude-haiku-5-5');
  });

  it('falls back to the heuristic on invalid JSON', async () => {
    const sink = logSink();
    const { client } = fakeClient(() => textMessage('{"estimates": [oops'));
    const out = await new AnthropicLlm({ client, log: sink.log }).understand(understandReq);
    expect(out).toEqual(await new HeuristicLlm().understand(understandReq));
    expect(sink.lines.join('\n')).toMatch(/understand failed/);
  });

  it('falls back to the heuristic on schema-invalid JSON', async () => {
    const { client } = fakeClient(() => textMessage(JSON.stringify({ estimates: [{ taskId: 't1', durationMin: 'long' }] })));
    const out = await new AnthropicLlm({ client, log: logSink().log }).understand(understandReq);
    expect(out).toEqual(await new HeuristicLlm().understand(understandReq));
  });

  it('falls back on network errors and refusals without throwing', async () => {
    const failing = fakeClient(() => {
      throw new Error('ECONNRESET');
    });
    await expect(new AnthropicLlm({ client: failing.client, log: logSink().log }).understand(understandReq)).resolves.toHaveLength(2);

    const refusing = fakeClient(() => textMessage('', 'refusal'));
    const reasons = await new AnthropicLlm({ client: refusing.client, log: logSink().log }).explain(explainReq);
    expect(reasons).toEqual(await new HeuristicLlm().explain(explainReq));
  });

  it('fills estimates the model forgot with heuristic ones', async () => {
    const partial = JSON.stringify({
      estimates: [{ taskId: 't1', durationMin: 90, priority: 3, urgency: 3, confidence: 0.7, minChunkMin: 30, deepWork: true, rationale: '' }],
    });
    const { client } = fakeClient(() => textMessage(partial));
    const out = await new AnthropicLlm({ client, log: logSink().log }).understand(understandReq);
    expect(out[0]?.durationMin).toBe(90);
    expect(out[1]?.rationale).toMatch(/^heuristic/);
  });

  it('returns placements with Date objects', async () => {
    const { client } = fakeClient(() => textMessage(goodPlaceJson));
    const out = await new AnthropicLlm({ client, log: logSink().log }).place(placeReq);
    expect(out).toHaveLength(1);
    expect(out?.[0]?.start).toBeInstanceOf(Date);
    expect(out?.[0]?.start.toISOString()).toBe('2026-11-16T09:00:00.000Z');
    expect(out?.[0]?.end.toISOString()).toBe('2026-11-16T11:00:00.000Z');
  });

  it('returns null from place on garbage so the core placer takes over', async () => {
    const { client } = fakeClient(() => textMessage(JSON.stringify({ placements: [{ taskId: 't1', start: 'soon', end: 'later' }] })));
    expect(await new AnthropicLlm({ client, log: logSink().log }).place(placeReq)).toBeNull();
  });

  it('passes previousErrors to the model', async () => {
    const { client, calls } = fakeClient(() => textMessage(goodPlaceJson));
    await new AnthropicLlm({ client, log: logSink().log }).place({ ...placeReq, previousErrors: ['t1 overlaps Lecture'] });
    expect(JSON.stringify(calls[0]?.messages)).toContain('t1 overlaps Lecture');
  });

  it('keeps reasons short and fills missing ones from templates', async () => {
    const long = JSON.stringify({ reasons: [{ taskId: 't1', reason: `🎉 ${'very '.repeat(40)}long` }] });
    const { client } = fakeClient(() => textMessage(long));
    const out = await new AnthropicLlm({ client, log: logSink().log }).explain(explainReq);
    expect(out.t1?.length).toBeLessThanOrEqual(90);
    expect(out.t1).not.toContain('🎉');
    expect(out.t2).toBeTruthy();
  });
});

describe('AnthropicLlm real client construction', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('ignores ANTHROPIC_AUTH_TOKEN and ANTHROPIC_BASE_URL from the environment', () => {
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'other-tool-token');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://proxy.other-tool.example');
    const llm = new AnthropicLlm({ apiKey: 'sk-ant-test' });
    const client = (llm as unknown as { client: Anthropic }).client;
    expect(client).toBeInstanceOf(Anthropic);
    expect(client.apiKey).toBe('sk-ant-test');
    expect(client.authToken).toBeNull();
    expect(client.baseURL).toBe('https://api.anthropic.com');
  });

  it('uses an explicit Tempo base URL', () => {
    const llm = new AnthropicLlm({ apiKey: 'sk-ant-test', baseURL: 'https://tempo-proxy.example' });
    expect((llm as unknown as { client: Anthropic }).client.baseURL).toBe('https://tempo-proxy.example');
  });

  it('refuses to construct without a key', () => {
    expect(() => new AnthropicLlm({})).toThrow(/apiKey/);
  });
});
