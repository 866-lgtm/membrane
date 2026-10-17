/**
 * A yielding stream ends at its terminal event. After cancel(), the consumer
 * sees one aborted event and nothing after it, a loop that resumes anyway
 * finishes instead of parking on a tool wait, and a cancel that comes after
 * the loop's own terminal event adds no second one.
 */
import { describe, it, expect } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { YieldingStreamImpl } from '../../src/yielding-stream.js';
import { abortError } from '../../src/types/errors.js';
import type { NormalizedRequest, StreamEvent } from '../../src/types/index.js';
import type { ProviderAdapter, ProviderRequest, ProviderRequestOptions, ProviderResponse } from '../../src/types/provider.js';
import type { StreamCallbacks } from '../../src/types/streaming.js';

type Mode = 'native' | 'xml';

const XML_CALL = 'zz checking\n<function_calls><invoke name="zz_noop"><parameter name="x">1</parameter></invoke></function_calls>';

const respond = (request: ProviderRequest, content: unknown[], stopReason: string): ProviderResponse => ({
  content, stopReason, usage: { inputTokens: 10, outputTokens: 5 }, model: request.model, rawRequest: request, raw: {},
}) as never;

/** One tool round, then a second round that streams text and fails as an adapter does once its signal aborts. */
class TwoRoundAdapter implements ProviderAdapter {
  readonly name = 'zz-two-rounds';
  calls = 0;
  constructor(private readonly mode: Mode) {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.calls++;
    if (this.calls === 1) {
      if (this.mode === 'xml') {
        callbacks.onChunk(XML_CALL);
        return respond(request, [{ type: 'text', text: XML_CALL }], 'end_turn');
      }
      callbacks.onChunk('zz checking');
      return respond(request, [{ type: 'text', text: 'zz checking' }, { type: 'tool_use', id: 'zz-tu-1', name: 'zz_noop', input: { x: 1 } }], 'tool_use');
    }
    callbacks.onChunk('zz second ');
    const signal = options!.signal!;
    await new Promise<never>((_, reject) => {
      if (signal.aborted) { reject(abortError('Request aborted')); return; }
      signal.addEventListener('abort', () => reject(abortError('Request aborted')), { once: true });
    });
    throw new Error('unreachable');
  }
}

/**
 * A response that had already come when the cancel arrived: the round streams
 * its text (and, on the XML path, its call), waits for the abort, then
 * resolves with a tool call anyway, as a provider whose last bytes crossed
 * the cancel would.
 */
class LateCallAdapter implements ProviderAdapter {
  readonly name = 'zz-late-call';
  calls = 0;
  private started!: () => void;
  readonly streaming = new Promise<void>((resolve) => { this.started = resolve; });
  constructor(private readonly mode: Mode) {}
  supportsModel(): boolean { return true; }
  async complete(): Promise<ProviderResponse> { throw new Error('not used'); }
  async stream(request: ProviderRequest, callbacks: StreamCallbacks, options?: ProviderRequestOptions): Promise<ProviderResponse> {
    this.calls++;
    callbacks.onChunk(this.mode === 'xml' ? XML_CALL : 'zz first ');
    const signal = options!.signal!;
    await new Promise<void>((resolve) => {
      if (signal.aborted) { resolve(); return; }
      signal.addEventListener('abort', () => resolve(), { once: true });
      this.started();
    });
    return this.mode === 'xml'
      ? respond(request, [{ type: 'text', text: XML_CALL }], 'end_turn')
      : respond(request, [{ type: 'text', text: 'zz first ' }, { type: 'tool_use', id: 'zz-late', name: 'zz_noop', input: { x: 2 } }], 'tool_use');
  }
}

const BASE: NormalizedRequest = {
  messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz hello' }] }],
  config: { model: 'zz-model', maxTokens: 100 },
  tools: [{ name: 'zz_noop', description: 'zz no-op', inputSchema: { type: 'object', properties: { x: { type: 'number' } } } }],
};
const requestFor = (mode: Mode): NormalizedRequest => ({ ...BASE, toolMode: mode });

/** One turn of the event loop: enough for a loop resuming from a settled wait to reach its next await. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

describe('a yielding stream ends at its terminal event', () => {
  for (const mode of ['native', 'xml'] as const) {
    it(`results passed just before cancel() leave nothing after the aborted event (${mode})`, async () => {
      const stream = new Membrane(new TwoRoundAdapter(mode)).streamYielding(requestFor(mode), {});
      const types: string[] = [];
      for await (const event of stream) {
        types.push(event.type);
        if (event.type === 'tool-calls') {
          stream.provideToolResults(event.calls.map((call) => ({ toolUseId: call.id, content: 'zz ok' })));
          stream.cancel();
        }
        // Reading on while the loop resumes and runs to its next check.
        await turn();
      }
      expect(types[types.length - 1]).toBe('aborted');
      expect(types.filter((type) => type === 'aborted')).toHaveLength(1);
    });

    it(`a call that resolves after the cancel brings no tool-calls, and the loop finishes (${mode})`, async () => {
      const adapter = new LateCallAdapter(mode);
      const stream = new Membrane(adapter).streamYielding(requestFor(mode), {});
      void adapter.streaming.then(() => stream.cancel());
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
        await turn();
      }
      await turn();

      expect(events[events.length - 1].type).toBe('aborted');
      expect(events.some((event) => event.type === 'tool-calls')).toBe(false);
      // The late call was recorded after the event was built, so the event
      // doesn't gain it.
      expect((events[events.length - 1] as { toolCalls?: unknown[] }).toolCalls).toEqual([]);
      // The loop finished: it isn't parked on a tool wait, and markDone() ran.
      expect(stream.isWaitingForTools).toBe(false);
      expect((stream as unknown as { abortSnapshot?: unknown }).abortSnapshot).toBeUndefined();
      expect(adapter.calls).toBe(1);
    });
  }

  it("a cancel() after the loop's own complete leaves complete the only terminal event", async () => {
    let finished!: () => void;
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const stream = new YieldingStreamImpl({}, async (running) => {
      running.emit({ type: 'complete', response: {} } as never);
      finished();
    });
    const iterator = stream[Symbol.asyncIterator]();
    await done;
    stream.cancel();
    const types: string[] = [];
    for (;;) {
      const next = await iterator.next();
      if (next.done) break;
      types.push(next.value.type);
    }
    expect(types).toEqual(['complete']);
  });
});
