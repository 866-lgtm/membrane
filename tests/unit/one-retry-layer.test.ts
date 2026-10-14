/**
 * Membrane is the one layer that retries.
 *
 *  - AnthropicAdapter's SDK client sends each request once: its own retries
 *    (two by default, invisible to membrane) are off on the requests membrane
 *    makes, so a 429 reaches a caller that asked for it at once, and
 *    `attempts`, `backoff` and `retryDelaysMs` count every send.
 *  - What the SDK used to retry before delivery, membrane retries: a 5xx, a
 *    provider's 408 and a connection failure get the base schedule, five
 *    attempts by default, on every entry point. `maxRetries` still sets it.
 *  - An adapter's own deadline is the caller's: it isn't sent again.
 *  - The API's `x-should-retry` and `retry-after-ms`, which the SDK obeyed,
 *    are read where the adapter types the error.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import {
  MembraneError,
  deadlineExpired,
  isDeadlineExpiry,
  networkError,
  serverError,
  timeoutError,
} from '../../src/types/errors.js';
import type {
  NormalizedRequest,
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  StreamCallbacks,
  StreamEvent,
} from '../../src/types/index.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
  config: { model: 'zz-model', maxTokens: 64 },
};

const FAST = { retry: { retryDelayMs: 1, maxRetryDelayMs: 2, backoffMultiplier: 1 } };

/** Fails its first `failures` sends with `makeError`, then answers. */
class FailingAdapter implements ProviderAdapter {
  readonly name = 'zz-failing';
  sends = 0;
  constructor(private failures: number, private makeError: () => Error) {}
  supportsModel(): boolean { return true; }
  private answer(): ProviderResponse {
    return { content: [{ type: 'text', text: 'zz ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, raw: {} } as unknown as ProviderResponse;
  }
  async complete(): Promise<ProviderResponse> {
    if (++this.sends <= this.failures) throw this.makeError();
    return this.answer();
  }
  async stream(_request: ProviderRequest, callbacks: StreamCallbacks): Promise<ProviderResponse> {
    if (++this.sends <= this.failures) throw this.makeError();
    callbacks.onChunk('zz ok');
    return this.answer();
  }
}

const membrane = (adapter: ProviderAdapter, config: object = FAST) =>
  new Membrane(adapter, { formatter: new NativeFormatter(), ...config });

async function yielding(m: Membrane): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of m.streamYielding(REQUEST)) events.push(event);
  return events;
}

describe('membrane retries what the SDK used to, before delivery, on every entry point', () => {
  it('a 5xx gets the base schedule, five attempts by default', async () => {
    const adapter = new FailingAdapter(Infinity, () => serverError('zz internal', 500));
    const events = await yielding(membrane(adapter));

    expect(adapter.sends).toBe(5);
    const backoffs = events.filter((e) => e.type === 'backoff') as Extract<StreamEvent, { type: 'backoff' }>[];
    expect(backoffs.map((e) => [e.schedule, e.attempt, e.maxAttempts])).toEqual([
      ['base', 1, 4], ['base', 2, 4], ['base', 3, 4], ['base', 4, 4],
    ]);
    const error = (events.at(-1) as Extract<StreamEvent, { type: 'error' }>).error;
    expect(error).toMatchObject({ httpStatus: 500, attempts: 5 });
  });

  it.each(['complete', 'stream', 'yielding'] as const)('%s: a connection failure is sent again', async (entry) => {
    const adapter = new FailingAdapter(1, () => networkError('zz connection reset'));
    const m = membrane(adapter);
    if (entry === 'complete') await m.complete(REQUEST);
    else if (entry === 'stream') await m.stream(REQUEST);
    else expect((await yielding(m)).at(-1)?.type).toBe('complete');
    expect(adapter.sends).toBe(2);
  });

  it("a provider's 408 is sent again", async () => {
    const adapter = new FailingAdapter(1, () =>
      new MembraneError({ type: 'timeout', message: 'zz request timeout', retryable: true, httpStatus: 408, rawError: undefined }));
    await membrane(adapter).stream(REQUEST);
    expect(adapter.sends).toBe(2);
  });

  it.each(['complete', 'stream', 'yielding'] as const)('%s: maxRetries 1 leaves a 5xx to the caller', async (entry) => {
    const adapter = new FailingAdapter(Infinity, () => serverError('zz internal', 503));
    const m = membrane(adapter, { retry: { ...FAST.retry, maxRetries: 1 } });
    const thrown = entry === 'complete'
      ? await m.complete(REQUEST).catch((e) => e)
      : entry === 'stream'
        ? await m.stream(REQUEST).catch((e) => e)
        : ((await yielding(m)).at(-1) as Extract<StreamEvent, { type: 'error' }>).error;
    expect(thrown).toMatchObject({ httpStatus: 503, attempts: 1 });
    expect(adapter.sends).toBe(1);
  });

  it.each(['complete', 'stream', 'yielding'] as const)("%s: an adapter's own deadline is not sent again", async (entry) => {
    const adapter = new FailingAdapter(Infinity, () => deadlineExpired(timeoutError('zz first-event timeout')));
    const m = membrane(adapter);
    const thrown = entry === 'complete'
      ? await m.complete(REQUEST).catch((e) => e)
      : entry === 'stream'
        ? await m.stream(REQUEST).catch((e) => e)
        : ((await yielding(m)).at(-1) as Extract<StreamEvent, { type: 'error' }>).error;
    // Still the retryable timeout the caller sees; membrane just doesn't spend
    // another full deadline on it.
    expect(thrown).toMatchObject({ type: 'timeout', retryable: true, attempts: 1 });
    expect(adapter.sends).toBe(1);
  });
});

describe('AnthropicAdapter sends each request once', () => {
  const overloadedBody = JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'zz overloaded' } });
  const adapter = () => new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  const wire: ProviderRequest = { model: 'zz-model', messages: [{ role: 'user', content: 'zz go' }], maxTokens: 16 };

  it.each(['complete', 'stream'] as const)('%s: a 529 is one HTTP send, not three', async (entry) => {
    const fetch = vi.fn(async () => new Response(overloadedBody, { status: 529, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const a = adapter();
    const thrown = entry === 'complete'
      ? await a.complete(wire).catch((e) => e)
      : await a.stream(wire, { onChunk() {} }).catch((e) => e);
    expect(thrown).toMatchObject({ type: 'server', httpStatus: 529, retryable: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('through membrane, a 429 left to the caller arrives after one send', async () => {
    const fetch = vi.fn(async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'zz slow down' } }),
      { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } },
    ));
    vi.stubGlobal('fetch', fetch);
    const m = new Membrane(adapter(), { formatter: new NativeFormatter() });
    await expect(m.stream(REQUEST, { retryRateLimits: false })).rejects.toMatchObject({
      type: 'rate_limit', retryAfterMs: 30_000, attempts: 1,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("AnthropicAdapter's watchdog expiry is a deadline", () => {
  it('a stream with no first event ends with a timeout membrane leaves to the caller', async () => {
    // Headers arrive, then nothing: the body stays open until the request is aborted.
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => new Response(
      new ReadableStream({
        start(controller) {
          init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )));
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const wire: ProviderRequest = { model: 'zz-model', messages: [{ role: 'user', content: 'zz go' }], maxTokens: 16 };
    const thrown = await adapter.stream(wire, { onChunk() {} }, { firstEventTimeoutMs: 50 }).catch((e) => e);

    expect(thrown).toMatchObject({ type: 'timeout', retryable: true });
    expect(isDeadlineExpiry(thrown)).toBe(true);
  });
});

describe("AnthropicAdapter reads the API's retry advice, as the SDK did", () => {
  const classify = (error: unknown) =>
    (new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }) as any).handleError(error, {});
  const apiError = (status: number, type: string, headers: Record<string, string>) =>
    new Anthropic.APIError(status, { error: { type, message: 'zz' } }, undefined, new Headers(headers));

  it('x-should-retry: false makes a 5xx not retryable', () => {
    expect(classify(apiError(500, 'api_error', { 'x-should-retry': 'false' }))).toMatchObject({ type: 'server', retryable: false });
  });

  it('x-should-retry: true makes a 4xx retryable', () => {
    expect(classify(apiError(400, 'invalid_request_error', { 'x-should-retry': 'true' }))).toMatchObject({ retryable: true });
  });

  it('no x-should-retry leaves the status to decide', () => {
    expect(classify(apiError(500, 'api_error', {}))).toMatchObject({ retryable: true });
    expect(classify(apiError(400, 'invalid_request_error', {}))).toMatchObject({ retryable: false });
  });

  it('retry-after-ms is read before retry-after', () => {
    expect(classify(apiError(429, 'rate_limit_error', { 'retry-after-ms': '1500', 'retry-after': '30' }))).toMatchObject({
      type: 'rate_limit', retryAfterMs: 1500,
    });
  });
});
