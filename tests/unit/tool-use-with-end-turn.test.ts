/**
 * A response that stops with `end_turn` while carrying a complete client
 * tool call, and the diagnostics that let one be reported.
 *
 * The provider contract is a `tool_use` stop for any response carrying a tool
 * call, and every native loop gated execution on it. Production Anthropic
 * responses broke the contract on 2026-10-19 (three times, two models): a
 * single complete tool_use block, `stop_reason: "end_turn"`, `stop_details`
 * null, message_delta received. Membrane returned the round as a finished
 * turn, nothing ran, and the caller dropped the turn without a word — and the
 * stream adapter had kept neither the message id nor the request id, so there
 * was nothing to report it with.
 *
 * Pinned here: a round whose calls are all complete runs as a `tool_use`
 * round on both native loops (and comes back from complete() as a tool_use
 * stop), recorded in details.anomalies with a warning; a round with an
 * incomplete call, or with a length/refusal stop, runs nothing as before; and
 * the Anthropic adapter keeps the response's id, request id and the
 * provider's own message_start / message_delta events plus anything it
 * doesn't read.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import type { NormalizedRequest, StreamEvent, ToolCall, ToolResult } from '../../src/types/index.js';

/** The SDK's MessageStream as the adapter uses it: async-iterable events,
 *  a controller, and the request id it records on connect. */
function fakeAnthropicStream(events: unknown[], requestId?: string) {
  return {
    controller: { abort() { /* noop */ } },
    ...(requestId ? { request_id: requestId } : {}),
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < events.length) return { value: events[i++], done: false };
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const MODEL = 'claude-zz-1';

function messageStart(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'message_start',
    message: {
      id, type: 'message', role: 'assistant', model: MODEL, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
      ...extra,
    },
  };
}

/** A complete tool call: start, its whole arguments, stop. */
function completeToolCall(index: number, id: string, args: string) {
  return [
    { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'zz_lookup', input: {} } },
    { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: args } },
    { type: 'content_block_stop', index },
  ];
}

function finalText(id: string) {
  return [
    messageStart(id),
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz done' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
  ];
}

/** The 2026-10-19 shape: one complete client tool call, stop_reason end_turn. */
function toolCallStoppedWithEndTurn(id: string) {
  return [
    messageStart(id),
    ...completeToolCall(0, 'toolu_zz_end1', '{"query":"zz"}'),
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null }, usage: { output_tokens: 20 } },
  ];
}

/** An adapter whose SDK client serves one scripted stream per call. */
function scriptedAnthropic(rounds: Array<{ events: unknown[]; requestId?: string }>) {
  const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
  let call = 0;
  (adapter as any).client = {
    withOptions() { return this; },
    messages: {
      stream: async () => {
        const round = rounds[call++];
        if (!round) throw new Error(`unscripted provider call ${call}`);
        return fakeAnthropicStream(round.events, round.requestId);
      },
    },
  };
  return { adapter, calls: () => call };
}

function request(): NormalizedRequest {
  return {
    messages: [{ participant: 'User', content: [{ type: 'text', text: 'zz go' }] }],
    config: { model: MODEL, maxTokens: 64 },
    toolMode: 'native',
    tools: [{ name: 'zz_lookup', description: 'zz', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }],
  };
}

const answer = (calls: ToolCall[]): ToolResult[] =>
  calls.map((c) => ({ toolUseId: c.id, content: 'zz result', isError: false }));

let warn: ReturnType<typeof vi.spyOn> | undefined;
function captureWarnings(): string[] {
  const lines: string[] = [];
  warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  return lines;
}
afterEach(() => { warn?.mockRestore(); warn = undefined; });

describe('tool calls the provider stopped with end_turn', () => {
  it('stream(): complete calls run as a tool_use round, and the turn continues', async () => {
    const warnings = captureWarnings();
    const { adapter, calls } = scriptedAnthropic([
      { events: toolCallStoppedWithEndTurn('msg_zz_1'), requestId: 'req_zz_1' },
      { events: finalText('msg_zz_2'), requestId: 'req_zz_2' },
    ]);
    const ran: ToolCall[] = [];
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), {
      onToolCalls: async (toolCalls) => { ran.push(...toolCalls); return answer(toolCalls); },
    });

    expect(ran.map((c) => [c.id, c.name, c.input])).toEqual([['toolu_zz_end1', 'zz_lookup', { query: 'zz' }]]);
    expect(calls()).toBe(2);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies).toEqual([{
      kind: 'tool_use_with_end_turn',
      round: 0,
      providerStopReason: 'end_turn',
      toolNames: ['zz_lookup'],
      toolUseIds: ['toolu_zz_end1'],
      treatedAsToolUse: true,
      model: MODEL,
      messageId: 'msg_zz_1',
      requestId: 'req_zz_1',
    }]);
    const line = warnings.find((w) => w.includes('tool call'));
    expect(line).toContain('treating the round as tool_use');
    expect(line).toContain('msg_zz_1');
    expect(line).toContain('req_zz_1');
  });

  it('streamYielding(): the round yields tool-calls and the turn continues', async () => {
    captureWarnings();
    const { adapter, calls } = scriptedAnthropic([
      { events: toolCallStoppedWithEndTurn('msg_zz_3'), requestId: 'req_zz_3' },
      { events: finalText('msg_zz_4') },
    ]);
    const stream = new Membrane(adapter, { formatter: new NativeFormatter() }).streamYielding(request());
    const toolRounds: ToolCall[][] = [];
    let complete: any;
    for await (const event of stream as AsyncIterable<StreamEvent>) {
      if (event.type === 'tool-calls') {
        toolRounds.push(event.calls);
        stream.provideToolResults(answer(event.calls));
      } else if (event.type === 'complete') {
        complete = event.response;
        break;
      } else if (event.type === 'error' || event.type === 'aborted') {
        throw new Error(`stream ended with ${event.type}`);
      }
    }

    expect(toolRounds.map((r) => r.map((c) => c.id))).toEqual([['toolu_zz_end1']]);
    expect(calls()).toBe(2);
    expect(complete.stopReason).toBe('end_turn');
    expect(complete.details.anomalies).toHaveLength(1);
    expect(complete.details.anomalies[0]).toMatchObject({ round: 0, treatedAsToolUse: true, messageId: 'msg_zz_3', requestId: 'req_zz_3' });
  });

  it('a call cut off before its block stopped runs nothing; the round stays end_turn, recorded untreated', async () => {
    const warnings = captureWarnings();
    const { adapter, calls } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_5'),
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_zz_cut', name: 'zz_lookup', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"z' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      ],
    }]);
    const onToolCalls = vi.fn(async (toolCalls: ToolCall[]) => answer(toolCalls));
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
    expect(response.stopReason).toBe('end_turn');
    expect(response.details.anomalies?.[0]).toMatchObject({ treatedAsToolUse: false, toolUseIds: ['toolu_zz_cut'] });
    expect(warnings.some((w) => w.includes('nothing runs'))).toBe(true);
  });

  it.each([
    ['max_tokens', { stop_reason: 'max_tokens' }],
    ['refusal', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber' } }],
  ])('a %s stop with a tool call runs nothing and records no anomaly', async (_name, delta) => {
    captureWarnings();
    const { adapter, calls } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_6'),
        ...completeToolCall(0, 'toolu_zz_stop', '{"query":"zz"}'),
        { type: 'message_delta', delta, usage: { output_tokens: 5 } },
      ],
    }]);
    const onToolCalls = vi.fn(async (toolCalls: ToolCall[]) => answer(toolCalls));
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(calls()).toBe(1);
    expect(response.stopReason).toBe(delta.stop_reason);
    expect(response.details.anomalies).toBeUndefined();
  });

  it('a provider token membrane doesn\'t map is not read as end_turn: nothing runs', async () => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_7'),
        ...completeToolCall(0, 'toolu_zz_new', '{"query":"zz"}'),
        { type: 'message_delta', delta: { stop_reason: 'zz_new_reason' }, usage: { output_tokens: 5 } },
      ],
    }]);
    const onToolCalls = vi.fn(async (toolCalls: ToolCall[]) => answer(toolCalls));
    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).stream(request(), { onToolCalls });

    expect(onToolCalls).not.toHaveBeenCalled();
    expect(response.details.anomalies).toBeUndefined();
  });

  it('complete(): the response comes back as a tool_use stop, recorded', async () => {
    captureWarnings();
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const message = {
      id: 'msg_zz_8', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'tool_use', id: 'toolu_zz_c', name: 'zz_lookup', input: { query: 'zz' } }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 20 },
    };
    Object.defineProperty(message, '_request_id', { value: 'req_zz_8', enumerable: false });
    (adapter as any).client = { withOptions() { return this; }, messages: { create: async () => message } };

    const response = await new Membrane(adapter, { formatter: new NativeFormatter() }).complete(request());

    expect(response.stopReason).toBe('tool_use');
    expect(response.details.stop.providerReason).toBe('end_turn');
    expect(response.details.anomalies).toEqual([expect.objectContaining({
      kind: 'tool_use_with_end_turn', round: 0, treatedAsToolUse: true, messageId: 'msg_zz_8', requestId: 'req_zz_8',
    })]);
  });
});

describe('Anthropic response diagnostics on raw', () => {
  it('stream: keeps the message id, request id, message_start (without content), message_delta verbatim, and events it does not read', async () => {
    captureWarnings();
    const { adapter } = scriptedAnthropic([{
      requestId: 'req_zz_9',
      events: [
        messageStart('msg_zz_9', { zz_new_start_field: { a: 1 } }),
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'zz text' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'zz_new_delta', payload: 'zz' } },
        { type: 'content_block_stop', index: 0, zz_stop_field: true },
        { type: 'zz_new_event', detail: 'zz' },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, zz_new_delta_field: 'zz' },
          usage: { output_tokens: 7 },
          zz_new_top_field: 1,
        },
      ],
    }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );

    expect(res.responseId).toBe('msg_zz_9');
    expect(res.requestId).toBe('req_zz_9');
    expect(res.raw.id).toBe('msg_zz_9');
    expect(res.raw.request_id).toBe('req_zz_9');
    const events = res.raw.provider_events;
    expect(events.message_start.message.zz_new_start_field).toEqual({ a: 1 });
    expect(events.message_start.message.id).toBe('msg_zz_9');
    expect('content' in events.message_start.message).toBe(false);
    expect(events.message_delta).toEqual({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null, stop_details: null, zz_new_delta_field: 'zz' },
      usage: { output_tokens: 7 },
      zz_new_top_field: 1,
    });
    expect(events.unhandled).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'zz_new_delta', payload: 'zz' } },
      { type: 'content_block_stop', index: 0, zz_stop_field: true },
      { type: 'zz_new_event', detail: 'zz' },
    ]);
    // Existing raw fields are unchanged, and content isn't duplicated.
    expect(res.raw.stop_reason).toBe('end_turn');
    expect(res.raw.content).toEqual([{ type: 'text', text: 'zz text' }]);
    expect(JSON.stringify(events)).not.toContain('zz text');
  });

  it('stream: unhandled events are capped, the rest counted, and an oversized one truncated', async () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ type: 'zz_noise', i }));
    const big = { type: 'zz_big', blob: 'z'.repeat(10_000) };
    const { adapter } = scriptedAnthropic([{
      events: [
        messageStart('msg_zz_10'),
        big,
        ...many,
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      ],
    }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    const events = res.raw.provider_events;
    expect(events.unhandled).toHaveLength(20);
    expect(events.unhandled_omitted).toBe(6);
    expect(events.unhandled[0]).toMatchObject({ type: 'zz_big', truncated: true });
    expect(events.unhandled[0].json.length).toBe(4096);
  });

  it('stream without a request id (a transport that exposes none) leaves it out', async () => {
    const { adapter } = scriptedAnthropic([{ events: finalText('msg_zz_11') }]);
    const res: any = await adapter.stream(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    expect(res.raw.id).toBe('msg_zz_11');
    expect('request_id' in res.raw).toBe(false);
    expect(res.requestId).toBeUndefined();
  });

  it('complete: the SDK\'s non-enumerable request id reaches the serialized raw response', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    const message = {
      id: 'msg_zz_12', type: 'message', role: 'assistant', model: MODEL,
      content: [{ type: 'text', text: 'zz' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
    };
    Object.defineProperty(message, '_request_id', { value: 'req_zz_12', enumerable: false });
    (adapter as any).client = { withOptions() { return this; }, messages: { create: async () => message } };

    const res: any = await adapter.complete(
      { model: MODEL, maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz' }] }] } as any,
    );
    expect(res.responseId).toBe('msg_zz_12');
    expect(res.requestId).toBe('req_zz_12');
    const serialized = JSON.parse(JSON.stringify(res.raw));
    expect(serialized.id).toBe('msg_zz_12');
    expect(serialized.request_id).toBe('req_zz_12');
  });
});
