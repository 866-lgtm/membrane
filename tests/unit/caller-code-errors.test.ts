/**
 * An error the caller's own code throws is never resent (#160).
 *
 * Membrane runs the caller's code that observes or shapes a request or a
 * response: hooks, request and stream callbacks, receipt consumers and header
 * stamps. Before, what that code threw was classified by its wording like a
 * provider's error, so "rate limit" in a callback's message made membrane send
 * the request again, up to five times, paying for each response that had
 * already arrived or running the caller's code again. Now it leaves membrane
 * as the same classification with `retryable: false`, and with the original
 * as `cause` when it wasn't a MembraneError, so membrane's own retries stop,
 * and so does a caller's policy that reads `retryable`. A provider's own
 * error keeps its classification, before and after the caller's code runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { MembraneError, callerCodeError, rateLimitError } from '../../src/types/errors.js';
import type { NormalizedRequest } from '../../src/types/index.js';

const text = (t: string) => ({ type: 'text' as const, text: t });
const tool = { name: 'lookup', description: 'look up a record', inputSchema: { type: 'object' as const, properties: {} } };
const request = (extra: Record<string, unknown> = {}): NormalizedRequest => ({
  assistantParticipant: 'Agent', config: { model: 'claude-sonnet-4-6', maxTokens: 32 },
  messages: [{ participant: 'User', content: [text('hello')] }],
  ...extra,
}) as NormalizedRequest;
/** A history whose build makes NativeFormatter report a repair to onNormalize. */
const repairedHistory = () => request({ tools: [tool], messages: [
  { participant: 'User', content: [text('hello')] },
  { participant: 'Agent', content: [{ type: 'tool_use', id: 't1', name: 'lookup', input: {} }] },
  { participant: 'User', content: [
    { type: 'tool_result', toolUseId: 't1', content: 'first' },
    { type: 'tool_result', toolUseId: 't1', content: 'again' },
  ] },
] });
const noDelay = { retry: { maxRetries: 0, retryDelayMs: 1, maxRetryDelayMs: 2 } };
/** Worded as a rate limit, which classifies as retryable when a provider says it. */
const callerError = () => new Error('zz rate limit exceeded in the caller');

class CountingAdapter extends MockAdapter {
  completeCalls = 0;
  streamCalls = 0;
  constructor() { super({ defaultResponse: 'done and done', completeDelayMs: 0, streamChunkDelayMs: 0, streamChunkSize: 4 }); }
  override async complete(...args: Parameters<MockAdapter['complete']>) { this.completeCalls++; return super.complete(...args); }
  override async stream(...args: Parameters<MockAdapter['stream']>) { this.streamCalls++; return super.stream(...args); }
}

/** An Anthropic adapter whose SDK client is a stub, so nothing leaves the test. */
function anthropic(config: Record<string, unknown> = {}) {
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, ...config });
  const create = vi.fn().mockResolvedValue({
    id: 'msg', model: 'claude-sonnet-4-6', role: 'assistant', content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 },
  });
  const client: any = { messages: { create, stream: create } };
  client.withOptions = () => client;
  (adapter as any).client = client;
  return { adapter, create };
}

async function rejection(promise: Promise<unknown>): Promise<MembraneError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(MembraneError);
    return error as MembraneError;
  }
  throw new Error('expected a rejection');
}

/** The error a yielding stream's error event carries, or a failure if none came. */
async function yieldingError(membrane: Membrane, req: NormalizedRequest): Promise<MembraneError> {
  for await (const event of membrane.streamYielding(req, {})) {
    if (event.type === 'error') {
      expect(event.error).toBeInstanceOf(MembraneError);
      return event.error as MembraneError;
    }
  }
  throw new Error('expected an error event');
}

const call = (path: 'complete' | 'stream', membrane: Membrane, req: NormalizedRequest, options: Record<string, unknown> = {}) =>
  path === 'complete' ? membrane.complete(req, options) : membrane.stream(req, { onChunk: () => {}, ...options });

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('callerCodeError', () => {
  it('wraps an error that isn\'t a MembraneError, classified by its wording, not retryable, with the original as cause', () => {
    const original = callerError();
    const error = callerCodeError(original);
    expect(error).toBeInstanceOf(MembraneError);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false, message: original.message });
    expect(error.cause).toBe(original);
  });

  it('marks a MembraneError not retryable, as the same object', () => {
    const original = rateLimitError('zz a retryable MembraneError');
    expect(callerCodeError(original)).toBe(original);
    expect(original.retryable).toBe(false);
  });

  it('wraps a frozen MembraneError it can\'t mark, with the original as cause', () => {
    const original = Object.freeze(rateLimitError('zz a frozen MembraneError'));
    const error = callerCodeError(original);
    expect(error).not.toBe(original);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(original);
  });
});

describe('complete() sends once when the caller\'s code throws after the response arrived', () => {
  it('onResponse', async () => {
    const adapter = new CountingAdapter();
    const original = callerError();
    const error = await rejection(new Membrane(adapter, noDelay).complete(request(), { onResponse: () => { throw original; } }));
    expect(adapter.completeCalls).toBe(1);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(original);
  });

  it('the afterResponse hook', async () => {
    const adapter = new CountingAdapter();
    const membrane = new Membrane(adapter, { ...noDelay, hooks: { afterResponse: async () => { throw callerError(); } } });
    const error = await rejection(membrane.complete(request()));
    expect(adapter.completeCalls).toBe(1);
    expect(error.retryable).toBe(false);
  });
});

describe('the caller\'s code before the send runs once', () => {
  for (const path of ['complete', 'stream'] as const) {
    it(`${path}: the beforeRequest hook`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), { ...noDelay, hooks: { beforeRequest: async () => { runs++; throw callerError(); } } });
      const error = await rejection(call(path, membrane, request()));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: onCacheWireReceipt on the provider-request basis`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), noDelay);
      const error = await rejection(call(path, membrane, request({ onCacheWireReceipt: () => { runs++; throw callerError(); } })));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: onCacheWireReceipt on the wire-request basis, before the client is called`, async () => {
      let runs = 0;
      const { adapter, create } = anthropic();
      const membrane = new Membrane(adapter, noDelay);
      const error = await rejection(call(path, membrane, request({ onCacheWireReceipt: () => { runs++; throw callerError(); } })));
      expect(runs).toBe(1);
      expect(create).not.toHaveBeenCalled();
      expect(error.retryable).toBe(false);
    });

    it(`${path}: onRequest`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), noDelay);
      const error = await rejection(call(path, membrane, request(), { onRequest: () => { runs++; throw callerError(); } }));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: the onNormalize hook, inside the build`, async () => {
      let runs = 0;
      const membrane = new Membrane(new CountingAdapter(), { ...noDelay, formatter: new NativeFormatter(), hooks: { onNormalize: () => { runs++; throw callerError(); } } });
      const error = await rejection(call(path, membrane, repairedHistory()));
      expect(runs).toBe(1);
      expect(error.retryable).toBe(false);
    });

    it(`${path}: the Anthropic adapter's dynamicHeaders`, async () => {
      let runs = 0;
      const { adapter, create } = anthropic({ dynamicHeaders: () => { runs++; throw callerError(); } });
      const error = await rejection(call(path, new Membrane(adapter, noDelay), request()));
      expect(runs).toBe(1);
      expect(create).not.toHaveBeenCalled();
      expect(error.retryable).toBe(false);
    });
  }
});

describe('the onError hook is the caller\'s code too', () => {
  /** Fails its first call with a provider's rate limit, so onError is asked. */
  class RateLimitedOnce extends CountingAdapter {
    override async complete(...args: Parameters<MockAdapter['complete']>) {
      if (this.completeCalls++ === 0) throw rateLimitError('zz the provider says slow down');
      return MockAdapter.prototype.complete.apply(this, args);
    }
    override async stream(...args: Parameters<MockAdapter['stream']>) {
      if (this.streamCalls++ === 0) throw rateLimitError('zz the provider says slow down');
      return MockAdapter.prototype.stream.apply(this, args);
    }
  }

  for (const path of ['complete', 'stream'] as const) {
    it(`${path}: what it throws leaves as a MembraneError that isn't retryable`, async () => {
      const original = callerError();
      const membrane = new Membrane(new RateLimitedOnce(), { ...noDelay, hooks: { onError: () => { throw original; } } });
      const error = await rejection(call(path, membrane, request()));
      expect(error.retryable).toBe(false);
      expect(error.cause).toBe(original);
    });

    it(`${path}: a provider's rate limit is still retried when the caller's code runs and returns (control)`, async () => {
      const adapter = new RateLimitedOnce();
      const onError = vi.fn(() => 'retry' as const);
      const membrane = new Membrane(adapter, { ...noDelay, hooks: { onError } });
      await expect(call(path, membrane, request(), { onRequest: () => {}, onResponse: () => {} })).resolves.toBeDefined();
      expect(path === 'complete' ? adapter.completeCalls : adapter.streamCalls).toBe(2);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  }
});

describe('stream() after emission: the caller\'s error is not retryable, a provider\'s keeps its classification', () => {
  it('onChunk throws after the first chunk', async () => {
    const adapter = new CountingAdapter();
    const original = callerError();
    let chunks = 0;
    const error = await rejection(new Membrane(adapter, noDelay).stream(request(), { onChunk: () => { if (++chunks === 2) throw original; } }));
    expect(adapter.streamCalls).toBe(1);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(original);
  });

  it('onChunk throws as stream() replays a non-streaming response', async () => {
    const adapter = new CountingAdapter();
    const original = callerError();
    const error = await rejection(new Membrane(adapter, noDelay).stream(request({ streaming: false }), { onChunk: () => { throw original; } }));
    expect(adapter.completeCalls).toBe(1);
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(original);
  });

  it('onToolCalls rejects', async () => {
    class ToolUse extends CountingAdapter {
      override async stream(req: any, _callbacks: any, options?: any): Promise<any> {
        this.streamCalls++;
        options?.onRequest?.(req);
        return { content: [{ type: 'tool_use', id: 't9', name: 'lookup', input: {} }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: req.model, rawRequest: req, raw: {} };
      }
    }
    const adapter = new ToolUse();
    const membrane = new Membrane(adapter, { ...noDelay, formatter: new NativeFormatter() });
    const error = await rejection(membrane.stream(request({ tools: [tool] }), { onChunk: () => {}, onToolCalls: async () => { throw callerError(); } }));
    expect(adapter.streamCalls).toBe(1);
    expect(error.retryable).toBe(false);
  });

  it('a provider\'s rate limit after a chunk keeps retryable: true (control)', async () => {
    class LateFailure extends CountingAdapter {
      override async stream(req: any, callbacks: any): Promise<any> {
        this.streamCalls++;
        callbacks.onChunk('partial');
        throw rateLimitError('zz the provider says slow down, after a chunk');
      }
    }
    const adapter = new LateFailure();
    const error = await rejection(new Membrane(adapter, noDelay).stream(request(), { onChunk: () => {} }));
    expect(adapter.streamCalls).toBe(1);
    expect(error).toMatchObject({ type: 'rate_limit', retryable: true });
  });
});

describe('streamYielding(): the error event carries a MembraneError that isn\'t retryable, with the caller\'s error as cause', () => {
  it('the beforeRequest hook', async () => {
    const original = callerError();
    const membrane = new Membrane(new CountingAdapter(), { hooks: { beforeRequest: async () => { throw original; } } });
    const error = await yieldingError(membrane, request());
    expect(error).toMatchObject({ type: 'rate_limit', retryable: false });
    expect(error.cause).toBe(original);
  });

  it('onCacheWireReceipt', async () => {
    const original = callerError();
    const error = await yieldingError(new Membrane(new CountingAdapter()), request({ onCacheWireReceipt: () => { throw original; } }));
    expect(error.retryable).toBe(false);
    expect(error.cause).toBe(original);
  });

  it('the onNormalize hook', async () => {
    const membrane = new Membrane(new CountingAdapter(), { formatter: new NativeFormatter(), hooks: { onNormalize: () => { throw callerError(); } } });
    const error = await yieldingError(membrane, repairedHistory());
    expect(error.retryable).toBe(false);
  });
});

describe('the Responses adapter: a throwing onFastModeFallback is logged, and the response stands', () => {
  for (const path of ['complete', 'stream'] as const) {
    it(path, async () => {
      const fetch = vi.fn(async () => new Response('data: {"type":"response.completed","response":{"status":"completed","output":[],"service_tier":"default"}}\n\n'));
      vi.stubGlobal('fetch', fetch);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const original = callerError();
      const fallback = vi.fn(() => { throw original; });
      const adapter = new OpenAIResponsesAPIAdapter({ mode: 'subscription', credentials: () => ({ token: 't' }), fastMode: true, onFastModeFallback: fallback });
      const membrane = new Membrane(adapter, { ...noDelay, formatter: new OpenAIResponsesFormatter() });
      const req: NormalizedRequest = { messages: [{ participant: 'user', content: [text('hello')] }], config: { model: 'gpt-5.4', maxTokens: 100 } };
      await expect(call(path, membrane, req)).resolves.toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fallback).toHaveBeenCalledWith('default');
      expect(warn).toHaveBeenCalledWith('[membrane:openai-responses] onFastModeFallback threw; the response stands:', original);
    });
  }
});
