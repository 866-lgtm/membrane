/**
 * The progress deadline (`progressTimeoutMs`, agent-framework #268).
 *
 * After antra-tess/membrane#94 a body carrying only SSE keepalives renews the
 * Anthropic idle watchdog, so a connection that stays up while the model sends
 * nothing never ends. The progress deadline is renewed only by parsed provider
 * events (`ProviderRequestOptions.onProgress`), one per provider call, so tool
 * waits between calls never count. On expiry the call aborts with the deadline
 * mark and becomes a TimeoutAbortError on every path.
 *
 * Timings are scaled fixture inputs: a deadline of PROGRESS_MS, events or
 * keepalives every TICK_MS, and runs of 4x the deadline, wide enough that a
 * loaded machine doesn't turn them into races.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { MockAdapter } from '../../src/providers/mock.js';
import { createProgressDeadline, isDeadlineAbort, deadlineTimeoutError } from '../../src/providers/utils.js';
import { TimeoutAbortError, isAbortedResponse } from '../../src/types/index.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';
import type { ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

const PROGRESS_MS = 150;
const TICK_MS = 30;
const LIVE_MS = 4 * PROGRESS_MS;

const REQUEST: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'claude-sonnet-4-6', maxTokens: 100 },
};
const NATIVE_REQUEST: NormalizedRequest = {
  ...REQUEST,
  toolMode: 'native',
  tools: [{ name: 'zz_probe', description: 'zz probe', inputSchema: { type: 'object', properties: { fld1: { type: 'string' } } } }],
};

// ---------------------------------------------------------------------------
// A live response body the test scripts over time; records transport teardown.
// ---------------------------------------------------------------------------

interface Io {
  emit(text: string): void;
  sleep(ms: number): Promise<void>;
  close(): void;
  isDone(): boolean;
  untilDone(): Promise<void>;
}
const torn: boolean[] = [];

function liveResponse(init: RequestInit | undefined, script: (io: Io) => Promise<void>): Response {
  const encoder = new TextEncoder();
  const index = torn.push(false) - 1;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const stop = (error?: Error): void => {
    if (done) return;
    done = true;
    release();
    try { if (error) controller.error(error); else controller.close(); } catch { /* already settled */ }
  };
  const body = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { torn[index] = true; done = true; release(); },
  });
  // The platform's fetch rejects a body read with the signal's own reason
  // (pinned against a real server in adapter-timeout-identity.test.ts).
  init?.signal?.addEventListener('abort', () => {
    torn[index] = true;
    stop(init.signal!.reason as Error);
  }, { once: true });
  void script({
    emit: (text) => { if (!done) { try { controller.enqueue(encoder.encode(text)); } catch { /* closed */ } } },
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    close: () => stop(),
    isDone: () => done,
    untilDone: () => released,
  }).catch(() => {});
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_fixture' } });
}

function stubFetch(respond: (init: RequestInit, call: number) => Response | Promise<Response>): RequestInit[] {
  const calls: RequestInit[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    calls.push(init);
    return respond(init, calls.length - 1);
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  torn.length = 0;
});

// Anthropic SSE, through the real SDK parser (which drops `ping` events).
const message = {
  id: 'msg_test', type: 'message', role: 'assistant', model: REQUEST.config.model,
  content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
};
const frame = (event: string, data: object): string => `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
const ping = (): string => frame('ping', {});
const messageStart = (): string => frame('message_start', { message });
const textAnswer = (text: string): string[] => [
  frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text } }),
  frame('content_block_stop', { index: 0 }),
  frame('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } }),
  frame('message_stop', {}),
];
const anthropic = (): AnthropicAdapter => new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false } });

async function keepalives(io: Io, emit: () => string, ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms && !io.isDone(); elapsed += TICK_MS) {
    io.emit(emit());
    await io.sleep(TICK_MS);
  }
}

async function collect(stream: AsyncIterable<StreamEvent>, onEvent?: (event: StreamEvent) => void): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    onEvent?.(event);
  }
  return events;
}

// ---------------------------------------------------------------------------

describe('createProgressDeadline', () => {
  it('aborts with the deadline mark, naming itself, when nothing renews it', async () => {
    vi.useFakeTimers();
    const deadline = createProgressDeadline(undefined, 1000);
    vi.advanceTimersByTime(999);
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal!.aborted).toBe(true);
    expect(isDeadlineAbort(deadline.signal!.reason)).toBe(true);
    const error = deadlineTimeoutError(deadline.signal!.reason);
    expect(error).toBeInstanceOf(TimeoutAbortError);
    expect(error.type).toBe('timeout');
    expect(error.message).toBe('No stream progress within 1000ms');
    deadline.cleanup();
  });

  it('stays open while renewed, and expires a full period after the last renewal', () => {
    vi.useFakeTimers();
    const deadline = createProgressDeadline(undefined, 1000);
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(400);
      deadline.renew!();
    }
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(999);
    expect(deadline.signal!.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(deadline.signal!.aborted).toBe(true);
    deadline.cleanup();
  });

  it("passes the caller's cancellation through unmarked, and stops after cleanup", () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const cancelled = createProgressDeadline(caller.signal, 1000);
    const reason = new Error('caller');
    caller.abort(reason);
    expect(cancelled.signal!.reason).toBe(reason);
    expect(isDeadlineAbort(cancelled.signal!.reason)).toBe(false);
    cancelled.cleanup();

    const cleaned = createProgressDeadline(undefined, 1000);
    cleaned.cleanup();
    vi.advanceTimersByTime(5000);
    expect(cleaned.signal!.aborted).toBe(false);
  });

  it('without a timeout passes the caller signal through and offers no renew', () => {
    const caller = new AbortController();
    const off = createProgressDeadline(caller.signal, undefined);
    expect(off.signal).toBe(caller.signal);
    expect(off.renew).toBeUndefined();
    off.cleanup();
  });
});

describe('Membrane core: one renewable deadline per provider call', () => {
  class RecordingAdapter extends MockAdapter {
    readonly seen: Array<ProviderRequestOptions | undefined> = [];
    override async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.seen.push(options);
      return super.stream(request, callbacks, options);
    }
    override async complete(request: ProviderRequest, options?: ProviderRequestOptions): Promise<ProviderResponse> {
      this.seen.push(options);
      return super.complete(request, options);
    }
  }

  it('gives the adapter onProgress and a deadline signal only when progressTimeoutMs is set', async () => {
    const on = new RecordingAdapter();
    await new Membrane(on).stream(REQUEST, { progressTimeoutMs: 60_000 });
    await new Membrane(on).complete(REQUEST, { progressTimeoutMs: 60_000 });
    for await (const _ of new Membrane(on).streamYielding(REQUEST, { progressTimeoutMs: 60_000 })) { /* drain */ }
    expect(on.seen).toHaveLength(3);
    for (const options of on.seen) {
      expect(typeof options?.onProgress).toBe('function');
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }

    const off = new RecordingAdapter();
    const caller = new AbortController();
    await new Membrane(off).stream(REQUEST, { signal: caller.signal });
    expect(off.seen[0]?.onProgress).toBeUndefined();
    expect(off.seen[0]?.signal).toBe(caller.signal);
  });
});

describe('Anthropic: the deadline follows SDK events, not keepalives', () => {
  it('ends a stream that carries only pings after message_start, as a timeout', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      io.emit(messageStart());
      await keepalives(io, ping, 20 * LIVE_MS);
    }));
    const started = Date.now();
    const result = await new Membrane(anthropic()).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(LIVE_MS * 4);
    expect(torn[0]).toBe(true);
  });

  it('keeps a long tool-input stream alive though it fires no callback, and a tool wait never counts', async () => {
    stubFetch((init, call) => liveResponse(init, async (io) => {
      io.emit(messageStart());
      if (call === 0) {
        io.emit(frame('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'toolu_zz1', name: 'zz_probe', input: {} } }));
        io.emit(frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{"fld1":"' } }));
        await keepalives(io, () => frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: 'x' } }), LIVE_MS);
        io.emit(frame('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '"}' } }));
        io.emit(frame('content_block_stop', { index: 0 }));
        io.emit(frame('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } }));
        io.emit(frame('message_stop', {}));
      } else {
        for (const part of textAnswer('zz done')) io.emit(part);
      }
      io.close();
    }));
    const stream = new Membrane(anthropic()).streamYielding(NATIVE_REQUEST, { progressTimeoutMs: PROGRESS_MS });
    const events = await collect(stream, (event) => {
      if (event.type !== 'tool-calls') return;
      // A tool that takes several deadlines to run: time outside a provider call.
      setTimeout(() => stream.provideToolResults([{ toolUseId: event.calls[0]!.id, content: 'zz ok' }]), 3 * PROGRESS_MS);
    });
    expect(events.filter((e) => e.type === 'aborted')).toEqual([]);
    expect(events.some((e) => e.type === 'tool-calls')).toBe(true);
    expect(events.some((e) => e.type === 'complete')).toBe(true);
  });

  it('reports a stalled yielding round as aborted with reason timeout', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      io.emit(messageStart());
      await keepalives(io, ping, 20 * LIVE_MS);
    }));
    const events = await collect(new Membrane(anthropic()).streamYielding(REQUEST, { progressTimeoutMs: PROGRESS_MS }));
    const aborted = events.filter((e) => e.type === 'aborted');
    expect(aborted).toHaveLength(1);
    expect((aborted[0] as { reason: string }).reason).toBe('timeout');
  });

  it('bounds a non-streaming call whose response never comes, and names the deadline', async () => {
    stubFetch((init) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    }));
    const error = await new Membrane(anthropic())
      .complete(REQUEST, { progressTimeoutMs: PROGRESS_MS })
      .then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(TimeoutAbortError);
    expect((error as TimeoutAbortError).message).toBe(`No stream progress within ${PROGRESS_MS}ms`);
  });
});

describe('SSE adapters: data frames renew the deadline, comments do not', () => {
  const sse = (): OpenAICompatibleAdapter =>
    new OpenAICompatibleAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz-not-a-key' });
  const data = (payload: object): string => `data: ${JSON.stringify(payload)}\n\n`;
  const delta = (content: string): string => data({ choices: [{ index: 0, delta: { content } }] });
  const finish = (): string[] => [data({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }), 'data: [DONE]\n\n'];

  it('ends a stream that sends only comments after its first frame, as a timeout', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      io.emit(delta('zz'));
      await keepalives(io, () => ': keepalive\n\n', 20 * LIVE_MS);
    }));
    const result = await new Membrane(sse()).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    expect(isAbortedResponse(result)).toBe(true);
    expect((result as { reason: string }).reason).toBe('timeout');
    expect(torn[0]).toBe(true);
  });

  it('keeps a slow stream of data frames alive past the deadline', async () => {
    stubFetch((init) => liveResponse(init, async (io) => {
      await keepalives(io, () => delta('z'), LIVE_MS);
      for (const part of finish()) io.emit(part);
      io.close();
    }));
    const result = await new Membrane(sse()).stream(REQUEST, { progressTimeoutMs: PROGRESS_MS });
    expect(isAbortedResponse(result)).toBe(false);
  });
});
