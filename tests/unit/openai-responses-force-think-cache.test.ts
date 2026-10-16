/**
 * Ports of two Chat Completions request features to the Responses adapter:
 * 24h extended prompt-cache retention, and round-0 think forcing via the
 * `force_think_first` control flag.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import type { ProviderRequest } from '../../src/types/index.js';

const thinkTool = { name: 'think', description: 'Think first.', inputSchema: { type: 'object', properties: { thought: { type: 'string' } } } };
const otherTool = { name: 'look', description: 'Look around.', inputSchema: { type: 'object', properties: {} } };

const userTail = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }];
const toolRoundTail = [
  ...userTail,
  { type: 'function_call', call_id: 'call_1', name: 'think', arguments: '{}' },
  { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
];

function okResponse(): Response {
  return new Response(JSON.stringify({ id: 'r', model: 'gpt-5.1', status: 'completed', output: [] }), { status: 200 });
}

async function sentBody(request: Partial<ProviderRequest>, mode?: 'subscription'): Promise<Record<string, any>> {
  const fetchMock = vi.fn().mockResolvedValue(okResponse());
  vi.stubGlobal('fetch', fetchMock);
  const adapter = mode
    ? new OpenAIResponsesAPIAdapter({ mode, credentials: async () => ({ token: 't' }) } as any)
    : new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
  await adapter.complete({ model: 'gpt-5.1', maxTokens: 100, messages: userTail, ...request } as ProviderRequest).catch(() => {});
  return JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Responses 24h cache retention', () => {
  it('maps cacheTtl 24h to prompt_cache_retention', async () => {
    const body = await sentBody({ cacheTtl: '24h' });
    expect(body.prompt_cache_retention).toBe('24h');
  });

  it('never leaks Anthropic 5m/1h TTLs', async () => {
    expect((await sentBody({ cacheTtl: '1h' })).prompt_cache_retention).toBeUndefined();
    expect((await sentBody({ cacheTtl: '5m' })).prompt_cache_retention).toBeUndefined();
    expect((await sentBody({})).prompt_cache_retention).toBeUndefined();
  });

  it('lets an explicit provider param win', async () => {
    const body = await sentBody({ cacheTtl: '24h', extra: { prompt_cache_retention: 'in_memory' } });
    expect(body.prompt_cache_retention).toBe('in_memory');
  });

  it('keeps prompt_cache_key from provider params beside the retention', async () => {
    const body = await sentBody({ cacheTtl: '24h', extra: { prompt_cache_key: 'agent-main' } });
    expect(body).toMatchObject({ prompt_cache_retention: '24h', prompt_cache_key: 'agent-main' });
  });
});

describe('Responses round-0 think forcing', () => {
  it('names think on the first round and never forwards the flag', async () => {
    const body = await sentBody({ tools: [otherTool, thinkTool], extra: { force_think_first: true } });
    expect(body.tool_choice).toEqual({ type: 'function', name: 'think' });
    expect(body).not.toHaveProperty('force_think_first');
  });

  it('leaves tool_choice alone on resumed tool rounds', async () => {
    const body = await sentBody({ messages: toolRoundTail, tools: [thinkTool], extra: { force_think_first: true } });
    expect(body).not.toHaveProperty('tool_choice');
    expect(body).not.toHaveProperty('force_think_first');
  });

  it('is a no-op without a think tool, without the flag, or with an explicit tool_choice', async () => {
    expect(await sentBody({ tools: [otherTool], extra: { force_think_first: true } })).not.toHaveProperty('tool_choice');
    expect(await sentBody({ tools: [thinkTool] })).not.toHaveProperty('tool_choice');
    expect(await sentBody({ tools: [thinkTool], extra: { force_think_first: false } })).not.toHaveProperty('force_think_first');
    const explicit = await sentBody({ tools: [thinkTool], extra: { force_think_first: true, tool_choice: 'none' } });
    expect(explicit.tool_choice).toBe('none');
  });

  it('coexists with reasoning params and keeps tools non-strict', async () => {
    const body = await sentBody({
      tools: [thinkTool],
      cacheTtl: '24h',
      extra: { force_think_first: true, reasoning: { effort: 'high', summary: 'detailed', context: 'current_turn' } },
    });
    expect(body.reasoning).toEqual({ effort: 'high', summary: 'detailed', context: 'current_turn' });
    expect(body.tool_choice).toEqual({ type: 'function', name: 'think' });
    expect(body.tools[0]).toMatchObject({ type: 'function', name: 'think', strict: false });
    expect(body.include).toContain('reasoning.encrypted_content');
  });
});
