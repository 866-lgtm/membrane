/**
 * Membrane reads Gemini's `promptTokenCount` as counting the cached span that
 * `cachedContentTokenCount` reports, and subtracts it, so every consumer that
 * sums fresh input, cache reads and cache writes as one convention counts a
 * hit once. The basis is Google's UsageMetadata definition ("this is still
 * the total effective prompt size meaning this includes the number of tokens
 * in the cached content"), which it states for explicit cached content; for
 * an implicit hit it is inferred, and no hit has been measured (see
 * GeminiAdapter.usageCacheConvention). A response the inclusive reading
 * can't explain, with more cached tokens than prompt tokens, is read as
 * cache-excluded. The usage below is constructed, not a captured hit.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { GeminiAdapter, resetPromptExcludesCacheWarning } from '../../src/providers/gemini.js';
import { Membrane } from '../../src/membrane.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';

const HIT = { promptTokenCount: 10_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 10_005 };

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function stubComplete(usageMetadata: unknown): void {
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }], usageMetadata, modelVersion: 'gemini-3.5-flash-lite' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )) as typeof globalThis.fetch;
}

function stubStream(usageMetadata: unknown): void {
  const frames = [
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata, modelVersion: 'gemini-3.5-flash-lite' })}\n\n`,
  ];
  globalThis.fetch = (async () => new Response(
    new ReadableStream({ start(controller) { for (const f of frames) controller.enqueue(new TextEncoder().encode(f)); controller.close(); } }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )) as typeof globalThis.fetch;
}

const REQUEST = {
  config: { model: 'gemini-3.5-flash-lite', maxTokens: 64 },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'zz-prompt' }] }],
} as unknown as NormalizedRequest;

describe('Gemini usage is cache-inclusive', () => {
  it('declares it', () => {
    expect(new GeminiAdapter({ apiKey: 'zz-key-not-used' }).usageCacheConvention).toBe('cache-inclusive');
  });

  it('reads a hit as fresh input plus cache reads, on complete()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubComplete(HIT);
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(response.usage.inputTokens).toBe(2_000);
    expect(response.details.usage.cacheReadTokens).toBe(8_000);
    expect(response.details.cache.hitRatio).toBeCloseTo(0.8);
    expect(warn).not.toHaveBeenCalled();
  });

  it('and on stream()', async () => {
    stubStream(HIT);
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(REQUEST) as NormalizedResponse;
    expect(response.usage.inputTokens).toBe(2_000);
    expect(response.details.usage.cacheReadTokens).toBe(8_000);
  });

  it('leaves a response without a cache read as it was, its cache read a reported 0, on complete() and stream()', async () => {
    // proto3 omits a zero count, so an omitted cachedContentTokenCount and an explicit 0 both report 0.
    for (const usage of [
      { promptTokenCount: 10_000, candidatesTokenCount: 5, totalTokenCount: 10_005 },
      { promptTokenCount: 10_000, cachedContentTokenCount: 0, candidatesTokenCount: 5, totalTokenCount: 10_005 },
    ]) {
      stubComplete(usage);
      const completed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
      expect(completed.usage.inputTokens).toBe(10_000);
      expect(completed.details.usage.cacheReadTokens).toBe(0);
      stubStream(usage);
      const streamed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(REQUEST) as NormalizedResponse;
      expect(streamed.usage.inputTokens).toBe(10_000);
      expect(streamed.details.usage.cacheReadTokens).toBe(0);
    }
  });

  it('prices a hit once: the fresh span at the input rate, the cached span at the cache-read rate', async () => {
    // gemini-3.5-flash-lite in the default table: $0.30 input, $0.03 cache read, $2.50 output per million.
    const expected = { input: 2_000 * 0.30 / 1e6, cacheRead: 8_000 * 0.03 / 1e6, output: 5 * 2.50 / 1e6 };
    for (const run of ['complete', 'stream'] as const) {
      if (run === 'complete') stubComplete(HIT); else stubStream(HIT);
      const membrane = new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }));
      const response = run === 'complete' ? await membrane.complete(REQUEST) : await membrane.stream(REQUEST) as NormalizedResponse;
      const cost = response.usage.estimatedCost!;
      expect(cost.input, run).toBeCloseTo(expected.input, 12);
      expect(cost.cacheRead, run).toBeCloseTo(expected.cacheRead, 12);
      expect(cost.total, run).toBeCloseTo(expected.input + expected.cacheRead + expected.output, 12);
    }
  });
});

describe('a pricing row without a cache-read rate', () => {
  it('leaves the cached span unpriced, as for every provider, where it used to ride in inputTokens', async () => {
    const row = { inputPerMillion: 1000, outputPerMillion: 1000, currency: 'USD' };
    const registry = {
      getPricing: () => row,
      getCapabilities: () => undefined,
      getQuirks: () => undefined,
      getModel: () => undefined,
      resolveAlias: (id: string) => id,
      listModels: () => [],
    } as any;
    stubComplete(HIT);
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' }), { registry }).complete(REQUEST);
    const cost = response.usage.estimatedCost!;
    expect(cost.input).toBeCloseTo(2_000 * 1000 / 1e6, 12);
    expect(cost.cacheRead).toBeUndefined();
    expect(cost.total).toBeCloseTo((2_000 + 5) * 1000 / 1e6, 12);
  });
});

describe('a response the inclusive reading cannot explain', () => {
  it('a cached span equal to the whole prompt is still inside it: no fresh input', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stubComplete({ promptTokenCount: 8_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 8_005 });
    const response = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(response.usage.inputTokens).toBe(0);
    expect(response.details.usage.cacheReadTokens).toBe(8_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a cached span above the prompt count is read as cache-excluded, with one warning', async () => {
    resetPromptExcludesCacheWarning(); // the latch is process-wide: this test doesn't depend on order
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const usage = { promptTokenCount: 2_000, cachedContentTokenCount: 8_000, candidatesTokenCount: 5, totalTokenCount: 2_005 };
    const exceeding = (): string[] =>
      warn.mock.calls.map((call) => String(call[0])).filter((line) => line.includes('exceeds promptTokenCount'));
    stubComplete(usage);
    const completed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).complete(REQUEST);
    expect(completed.usage.inputTokens).toBe(2_000);
    expect(completed.details.usage.cacheReadTokens).toBe(8_000);
    expect(exceeding()).toHaveLength(1);
    stubStream(usage);
    const streamed = await new Membrane(new GeminiAdapter({ apiKey: 'zz-key-not-used' })).stream(REQUEST) as NormalizedResponse;
    expect(streamed.usage.inputTokens).toBe(2_000);
    // Once per process, though two responses exceeded.
    expect(exceeding()).toHaveLength(1);
  });
});
