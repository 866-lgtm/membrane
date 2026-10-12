/**
 * OpenAI-compatible prompt-cache request and stream-usage regression tests.
 *
 * Two live fixes for Polaris on OpenAI direct (gpt-5.1 via openai-compatible):
 *
 *   1. `cacheTtl: '24h'` becomes `prompt_cache_retention: '24h'` on the wire,
 *      WITHOUT turning on `store` (extended prompt caching is independent of
 *      response-object storage).
 *   2. Streamed calls request `stream_options.include_usage` and capture
 *      `prompt_tokens_details.cached_tokens`.
 *
 * Usage convention (post upstream merge): the adapter reports OpenAI's wire
 * shape verbatim — `prompt_tokens` INCLUDES the cached span — and tags the
 * response `cacheConvention: 'cache-inclusive'`. Membrane then restates it in
 * its single cache-EXCLUDED convention (`normalizeUsageToCacheExcluded`):
 * `inputTokens = prompt_tokens - cached_tokens`, `cacheReadTokens =
 * cached_tokens`, so the two are disjoint and the cached span is no longer
 * counted (or priced) twice by anything downstream.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { resetUndeclaredConventionWarnings } from '../../src/utils/usage.js';
import type { NormalizedRequest } from '../../src/types/index.js';
import { sseResponse } from '../helpers/sse-fixtures.js';

const PROMPT_TOKENS = 2200;
const CACHED_TOKENS = 2048;

const CACHED_USAGE_FRAME = JSON.stringify({
  choices: [],
  usage: {
    prompt_tokens: PROMPT_TOKENS,
    completion_tokens: 1,
    total_tokens: PROMPT_TOKENS + 1,
    prompt_tokens_details: { cached_tokens: CACHED_TOKENS },
  },
});

/** Stub fetch with a streamed reply whose final frame reports a cache hit; captures the request body. */
function stubCachedStream(): { body: () => any } {
  let body: any;
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return sseResponse([
      '{"choices":[{"delta":{"content":"ok"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}]}',
      CACHED_USAGE_FRAME,
      '[DONE]',
    ]);
  }));
  return { body: () => body };
}

const adapter = () => new OpenAICompatibleAdapter({ apiKey: 'test-key', baseURL: 'https://api.openai.com/v1' });

beforeEach(() => resetUndeclaredConventionWarnings());
afterEach(() => vi.unstubAllGlobals());

describe('OpenAICompatibleAdapter prompt caching', () => {
  it('forwards 24h retention without enabling response storage', async () => {
    let body: any;
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        model: 'gpt-5.1',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: 1, total_tokens: PROMPT_TOKENS + 1,
          prompt_tokens_details: { cached_tokens: 0 } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await adapter().complete({
      model: 'gpt-5.1', maxTokens: 16, cacheTtl: '24h',
      messages: [{ role: 'user', content: 'stable prefix' }],
    } as any);

    expect(body.prompt_cache_retention).toBe('24h');
    expect(body).not.toHaveProperty('store');
  });

  it('does not leak Anthropic 5m/1h TTLs onto the OpenAI wire', async () => {
    const { body } = stubCachedStream();
    await adapter().stream(
      { model: 'gpt-5.1', maxTokens: 16, cacheTtl: '1h', messages: [{ role: 'user', content: 'stable prefix' }] } as any,
      { onChunk: () => {} } as any,
    );

    expect(body()).not.toHaveProperty('prompt_cache_retention');
    expect(body()).not.toHaveProperty('store');
  });

  it('requests streamed usage and reports the wire counts tagged cache-inclusive', async () => {
    const { body } = stubCachedStream();
    const response: any = await adapter().stream(
      { model: 'gpt-5.1', maxTokens: 16, cacheTtl: '24h', messages: [{ role: 'user', content: 'stable prefix' }] } as any,
      { onChunk: () => {} } as any,
    );

    expect(body().stream_options).toEqual({ include_usage: true });
    // Adapter layer: OpenAI's shape verbatim (cached ⊆ prompt), declared as such
    // so Membrane knows to subtract rather than pass through.
    expect(response.usage).toEqual({
      inputTokens: PROMPT_TOKENS,
      outputTokens: 1,
      cacheReadTokens: CACHED_TOKENS,
      cacheConvention: 'cache-inclusive',
    });
    expect(response.raw.usage.prompt_tokens_details.cached_tokens).toBe(CACHED_TOKENS);
  });
});

describe('Membrane over OpenAICompatibleAdapter: cache-excluded usage', () => {
  const request: NormalizedRequest = {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'stable prefix' }] }],
    config: { model: 'gpt-5.1', maxTokens: 16 },
    cacheTtl: '24h',
  };

  it('forwards 24h retention end to end and restates usage with the cached span subtracted', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { body } = stubCachedStream();
    const membrane = new Membrane(adapter(), { formatter: new NativeFormatter() });

    const response: any = await membrane.stream(request);

    expect(body().prompt_cache_retention).toBe('24h');
    expect(body()).not.toHaveProperty('store');
    expect(body().stream_options).toEqual({ include_usage: true });

    // inputTokens = prompt_tokens - cached_tokens; cacheReadTokens = cached_tokens.
    expect(response.usage.inputTokens).toBe(PROMPT_TOKENS - CACHED_TOKENS);
    expect(response.usage.cacheReadTokens).toBe(CACHED_TOKENS);
    expect(response.usage.outputTokens).toBe(1);
    // The full prompt stays recoverable as the disjoint sum — not 2200 + 2048.
    expect(response.usage.inputTokens + response.usage.cacheReadTokens).toBe(PROMPT_TOKENS);
    expect(response.details.cache.hitRatio).toBeCloseTo(CACHED_TOKENS / PROMPT_TOKENS, 10);

    // The per-response convention tag means the adapter-wide 'unknown' never
    // triggers the undeclared-convention warning.
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('[membrane:usage]'))).toBe(false);
    warn.mockRestore();
  });

  it('leaves usage untouched when the stream reports no cache hit', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => sseResponse([
      '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
      JSON.stringify({ choices: [], usage: { prompt_tokens: PROMPT_TOKENS, completion_tokens: 1,
        total_tokens: PROMPT_TOKENS + 1, prompt_tokens_details: { cached_tokens: 0 } } }),
      '[DONE]',
    ])));
    const membrane = new Membrane(adapter(), { formatter: new NativeFormatter() });

    const response: any = await membrane.stream(request);

    expect(response.usage.inputTokens).toBe(PROMPT_TOKENS);
    expect(response.usage.cacheReadTokens ?? 0).toBe(0);
  });
});
