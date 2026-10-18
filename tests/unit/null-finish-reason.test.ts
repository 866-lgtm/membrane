/**
 * A server that ends a choice or candidate with `finish_reason: null` (or
 * Gemini's `finishReason: null`) gave no reason, which is a plain end of turn.
 * The OpenAI-completions and Gemini adapters returned the null as their stop
 * reason, and membrane's log line for an unmapped token read its `length`, so
 * the first such complete() in a process failed. Each file runs in a module of
 * its own, so these are the first stop reasons this process logs; the adapter
 * tests also check each adapter's own reading, which a stop reason already in
 * membrane's logged set can't hide.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, NormalizedResponse } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';

const zzRequest: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz-prompt' }] }],
  config: { model: 'zz-model-1', maxTokens: 64 },
};

const adapterRequest: ProviderRequest = { model: 'zz-model-1', messages: [{ role: 'user', content: 'zz-prompt' }], maxTokens: 16 };

function json(body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
}

function sse(frames: unknown[]) {
  return vi.fn(async () => new Response(
    frames.map(frame => 'data: ' + (typeof frame === 'string' ? frame : JSON.stringify(frame)) + '\n\n').join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  ));
}

async function streamed(membrane: Membrane): Promise<NormalizedResponse> {
  const result = await membrane.stream(zzRequest);
  if (isAbortedResponse(result)) throw new Error('aborted');
  return result;
}

/** The console.warn lines membrane printed for an unmapped stop reason. */
function unmappedWarnings(warn: ReturnType<typeof vi.spyOn>): string[] {
  return warn.mock.calls.map(args => String(args[0])).filter(line => line.includes('Unmapped adapter stop reason'));
}

const completions = () => new OpenAICompletionsAdapter({ apiKey: 'zz-key-completions', baseURL: 'https://zz-completions.invalid/v1' });
const gemini = () => new GeminiAdapter({ apiKey: 'zz-key-gemini' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a null finish reason is a plain end of turn', () => {
  it('openai-completions complete()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', json({
      id: 'zz-cmpl-1',
      model: 'zz-model-1',
      choices: [{ text: 'zz-done', finish_reason: null, index: 0 }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }));
    const adapter = completions();
    // The adapter's own reading, which no other test's logged set can hide.
    expect((await adapter.complete(adapterRequest)).stopReason).toBe('end_turn');
    const response = await new Membrane(adapter).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBeUndefined();
    expect(unmappedWarnings(warn)).toEqual([]);
  });

  it('gemini complete()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', json({
      candidates: [{ content: { parts: [{ text: 'zz-done' }] }, finishReason: null }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2 },
    }));
    const adapter = gemini();
    expect((await adapter.complete(adapterRequest)).stopReason).toBe('end_turn');
    const response = await new Membrane(adapter).complete(zzRequest);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.stop.providerReason).toBeUndefined();
    expect(unmappedWarnings(warn)).toEqual([]);
  });

  // A control: the stream reads a finish reason only when it's truthy, so a
  // null one was already no reason there. (Gemini's stream does the same, and
  // a stream that ends with no finish reason is a dropped connection there.)
  it('openai-completions stream()', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', sse([
      { id: 'zz-cmpl-1', choices: [{ text: 'zz-done', finish_reason: null, index: 0 }] },
      '[DONE]',
    ]));
    const response = await streamed(new Membrane(completions()));
    expect(response.stopReason).toBe('end_turn');
    expect(unmappedWarnings(warn)).toEqual([]);
  });
});

/** A JavaScript adapter whose stop reason is null, outside its type. */
class NullStopReasonAdapter extends MockAdapter {
  override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    return { ...(await super.complete(request, options)), stopReason: null as unknown as string };
  }
}

describe("membrane's log of an unmapped stop reason", () => {
  it('names a token that is not a string rather than failing the call, once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const membrane = new Membrane(new NullStopReasonAdapter());
    const first = await membrane.complete(zzRequest);
    const second = await membrane.complete(zzRequest);
    expect(first.stopReason).toBe('end_turn');
    expect(second.stopReason).toBe('end_turn');
    expect(first.details.stop.providerReason).toBeUndefined();
    const lines = unmappedWarnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Unmapped adapter stop reason null (not a string) normalized to end_turn');
  });
});
