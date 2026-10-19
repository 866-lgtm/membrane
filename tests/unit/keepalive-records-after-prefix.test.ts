/**
 * The Anthropic adapter's cache keepalive records a request only once the
 * provider has its prefix: in the stream lane at `message_start`, and in the
 * complete lane once the response has arrived.
 *
 * Recorded before the send, a request whose call then failed was replayed
 * through its day, though the provider never cached it, and one the provider
 * refused had its replays refused too. Three refusals in a row stop the
 * keepalive for every lineage, so one refused request could turn it off for
 * the process. Now a call that fails before the provider has the prefix
 * leaves its lineage's earlier snapshot, and that snapshot's window, as they
 * were.
 *
 * The SDK client is a stub, so nothing leaves the process, and the clock is
 * faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import type { CacheKeepaliveConfig, KeepaliveEvent } from '../../src/cache-keepalive.js';
import { MembraneError } from '../../src/types/index.js';

const START = Date.parse('2026-10-19T00:00:00Z');
const timing = { refreshAfterMs: 100, checkIntervalMs: 100, maxIdleMs: 10_000 };

/** A request whose one-hour cache marker makes it one the keepalive holds. */
function request(system: string, turns = 1) {
  return {
    model: 'claude-opus-4-1', maxTokens: 1024,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
    messages: Array.from({ length: turns }, (_, i) => ({ role: 'user', content: [{ type: 'text', text: `turn ${i}` }] })),
  } as any;
}

const readUsage = { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 };
const answer = { id: 'msg', model: 'claude-opus-4-1', role: 'assistant', type: 'message', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { ...readUsage, output_tokens: 1 } };
const refused = () => Object.assign(new Error('400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 212000 tokens > 200000 maximum"}}'), { status: 400 });
const unreachable = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });

const messageStart = { type: 'message_start', message: { model: 'claude-opus-4-1', usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } };
const rest = [
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

/** An SDK stream that yields `events`, then throws `failure` if one is given. */
function sdkStream(events: unknown[], failure?: Error) {
  return {
    controller: { abort() { /* the stub has nothing to abort */ } },
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          if (index < events.length) return { value: events[index++], done: false };
          if (failure) throw failure;
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const adapters: AnthropicAdapter[] = [];
/** An adapter whose SDK client is a stub. `create` answers both a complete()
 *  call and each keepalive replay, which the keepalive sends through it. */
function adapter(config: CacheKeepaliveConfig, create: (wire: any) => unknown, stream?: (wire: any) => unknown) {
  const events: KeepaliveEvent[] = [];
  const a = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { ...timing, ...config, onEvent: e => { events.push(e); } } });
  adapters.push(a);
  const sent: any[] = [];
  const client: any = {
    messages: {
      create: vi.fn(async (wire: any) => { sent.push(wire); return create(wire); }),
      stream: vi.fn(async (wire: any) => stream!(wire)),
    },
  };
  client.withOptions = () => client;
  (a as any).client = client;
  const replays = () => sent.filter(w => w.max_tokens === 0);
  return { a, events, replays };
}

const settle = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e);
const noCallbacks = { onChunk: () => {} } as any;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START); });
afterEach(() => {
  for (const a of adapters.splice(0)) a.cacheKeepalive?.stop();
  vi.useRealTimers();
});

describe('the stream lane records a request at message_start', () => {
  it('a call that fails before message_start leaves the earlier snapshot and its window', async () => {
    let fail = false;
    const { a, replays } = adapter({}, () => ({ ...answer, content: [], stop_reason: 'max_tokens', usage: readUsage }),
      () => fail ? Promise.reject(unreachable()) : sdkStream([messageStart, ...rest]));
    await a.stream(request('Resident system A'), noCallbacks);
    await vi.advanceTimersByTimeAsync(50);
    fail = true;
    const error = await settle(a.stream(request('Resident system A', 2), noCallbacks));
    expect(error).toBeDefined();
    const [lineage, ...others] = a.cacheKeepalive!.getStatus();
    expect(others).toEqual([]);
    // The window still runs from the call that reached the provider.
    expect(lineage!.realIdleMs).toBe(50);
    await vi.advanceTimersByTimeAsync(200);
    expect(replays().length).toBeGreaterThan(0);
    // What's replayed is the request the provider had: one turn, not two.
    for (const wire of replays()) expect(wire.messages).toHaveLength(1);
  });

  it('a refused call is never recorded, so never replayed', async () => {
    const { a, replays } = adapter({}, () => { throw refused(); }, () => Promise.reject(refused()));
    const error = await settle(a.stream(request('Resident system B'), noCallbacks));
    expect(error).toBeInstanceOf(MembraneError);
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    await vi.advanceTimersByTimeAsync(timing.maxIdleMs * 2);
    expect(replays()).toEqual([]);
  });

  it('a call that fails after message_start is recorded, since the provider had the prefix (control)', async () => {
    const overloaded = Object.assign(new Error('Overloaded'), { status: 529 });
    const { a, replays } = adapter({}, () => ({ ...answer, content: [], stop_reason: 'max_tokens', usage: readUsage }),
      () => sdkStream([messageStart], overloaded));
    const error = await settle(a.stream(request('Resident system C'), noCallbacks));
    expect(error).toBeDefined();
    expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(replays().length).toBeGreaterThan(0);
  });

  it("refused real calls don't trip the breaker for a healthy lineage beside them", async () => {
    const isRefused = (wire: any) => JSON.stringify(wire.system).includes('Resident system F');
    const { a, events, replays } = adapter({},
      wire => { if (isRefused(wire)) throw refused(); return { ...answer, content: [], stop_reason: 'max_tokens', usage: readUsage }; },
      wire => isRefused(wire) ? Promise.reject(refused()) : sdkStream([messageStart, ...rest]));
    for (let i = 0; i < 3; i++) await settle(a.stream(request('Resident system F'), noCallbacks));
    await a.stream(request('Resident system H'), noCallbacks);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events.filter(e => e.type === 'error' || e.type === 'disabled')).toEqual([]);
    expect(replays().filter(isRefused)).toEqual([]);
    // More healthy refreshes than the breaker's limit of three failures.
    expect(events.filter(e => e.type === 'refreshed').length).toBeGreaterThan(3);
    expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
  });
});

describe('the complete lane records a request once the response has arrived', () => {
  it('a refused complete() is never recorded', async () => {
    const { a, replays } = adapter({ lanes: ['complete'] }, () => { throw refused(); });
    const error = await settle(a.complete(request('Resident system D')));
    expect(error).toBeInstanceOf(MembraneError);
    expect(a.cacheKeepalive!.getStatus()).toEqual([]);
    await vi.advanceTimersByTimeAsync(timing.maxIdleMs * 2);
    expect(replays()).toEqual([]);
  });

  it('a complete() that answers is recorded and replayed (control)', async () => {
    const { a, replays } = adapter({ lanes: ['complete'] }, wire => wire.max_tokens === 0
      ? { ...answer, content: [], stop_reason: 'max_tokens', usage: readUsage }
      : answer);
    await a.complete(request('Resident system E'));
    expect(a.cacheKeepalive!.getStatus()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(replays().length).toBeGreaterThan(0);
  });
});
