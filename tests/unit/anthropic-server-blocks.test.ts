/**
 * Anthropic server-tool blocks (web search and the like) round-trip: response
 * parsing keeps each on a zero-width carrier, every Anthropic-shaped request
 * sends it back in its place, and request shapes for other wires leave it out.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { CompletionsFormatter } from '../../src/formatters/completions.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { AnthropicAdapter, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenAICompletionsAdapter } from '../../src/providers/openai-completions.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { normalizeResponsesInput } from '../../src/providers/responses-input.js';
import { ANTHROPIC_SERVER_BLOCK_TYPES, anthropicServerBlockFor } from '../../src/utils/anthropic-server-blocks.js';
import type { ContentBlock, NormalizedMessage, NormalizedRequest, ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

// A web-search turn in the order the API returned one: signed thinking, the
// search call and its results, more signed thinking, then the answer.
const thinking1 = { type: 'thinking', thinking: '', signature: 'zz-sig-1' };
const serverUse = { type: 'server_tool_use', id: 'srvtoolu_zz1', name: 'web_search', input: { query: 'zz latest release' } };
const searchResult = {
  type: 'web_search_tool_result',
  tool_use_id: 'srvtoolu_zz1',
  caller: { type: 'direct' },
  content: [{ type: 'web_search_result', title: 'zz release', url: 'https://zz.example/', encrypted_content: 'zz-enc', page_age: null }],
};
const thinking2 = { type: 'thinking', thinking: '', signature: 'zz-sig-2' };
const answer = { type: 'text', text: 'zz answer' };
const SERVER_TYPES = ['server_tool_use', 'web_search_tool_result'];

const carrier = (item: unknown, extra: Record<string, unknown> = {}): ContentBlock =>
  ({ type: 'text', text: '', rawItem: item, ...extra }) as ContentBlock;
/** A carrier holding another wire's item: an opaque Responses reasoning item. */
const responsesCarrier = carrier({ type: 'reasoning', id: 'rs_zz1', summary: [], encrypted_content: 'zz-rs' });

const turn = (): ContentBlock[] => [
  thinking1 as ContentBlock, carrier(serverUse), carrier(searchResult), thinking2 as ContentBlock, answer as ContentBlock,
];
/** The turn as Anthropic-shaped requests send it back. */
const sentTurn = [thinking1, serverUse, searchResult, thinking2, answer];

const history = (assistant: ContentBlock[] = turn()): NormalizedMessage[] => [
  { participant: 'User', content: [{ type: 'text', text: 'zz what is the latest release?' }] },
  { participant: 'Claude', content: assistant },
  { participant: 'User', content: [{ type: 'text', text: 'zz thanks' }] },
];
const options = { participantMode: 'simple' as const, assistantParticipant: 'Claude', humanParticipant: 'User' };

/** Every object in `value` whose `type` is a server block type. */
function serverBlocksIn(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(serverBlocksIn);
  if (!value || typeof value !== 'object') return [];
  const own = SERVER_TYPES.includes((value as { type?: string }).type ?? '') ? [value] : [];
  return [...own, ...Object.values(value).flatMap(serverBlocksIn)];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('anthropicServerBlockFor', () => {
  it('holds exactly these types: a change to the list is a change to this test', () => {
    expect([...ANTHROPIC_SERVER_BLOCK_TYPES].sort()).toEqual([
      'bash_code_execution_tool_result',
      'code_execution_tool_result',
      'container_upload',
      'mcp_tool_result',
      'mcp_tool_use',
      'server_tool_use',
      'text_editor_code_execution_tool_result',
      'tool_search_tool_result',
      'web_fetch_tool_result',
      'web_search_tool_result',
    ]);
  });

  it.each([...ANTHROPIC_SERVER_BLOCK_TYPES])('gives back a carrier\'s %s block as a copy', (type) => {
    const raw = { type, zz: 'field' };
    const sent = anthropicServerBlockFor(carrier(raw));
    expect(sent).toEqual(raw);
    expect(sent).not.toBe(raw);
  });

  it('sends no cache marker stored on the carrier or on the block', () => {
    const stored = { ...searchResult, cache_control: { type: 'ephemeral' } };
    const marked = carrier(stored, { cache_control: { type: 'ephemeral', ttl: '1h' } });
    const before = structuredClone(marked);
    expect(anthropicServerBlockFor(marked)).toEqual(searchResult);
    expect(marked).toEqual(before);
  });

  it('gives back a server block given as itself, as a copy', () => {
    const sent = anthropicServerBlockFor(serverUse);
    expect(sent).toEqual(serverUse);
    expect(sent).not.toBe(serverUse);
  });

  it.each([
    ['a carrier holding another wire\'s item', responsesCarrier],
    ['text that holds a raw item', { type: 'text', text: 'zz visible', rawItem: serverUse }],
    ['plain text', answer],
    ['a client tool call', { type: 'tool_use', id: 'toolu_zz1', name: 'record', input: {} }],
    ['null', null],
  ])('has nothing for %s', (_name, block) => {
    expect(anthropicServerBlockFor(block)).toBeUndefined();
  });
});

describe('NativeFormatter', () => {
  it('sends each kept server block back in its place in the turn', () => {
    const messages = history();
    const before = structuredClone(messages);
    const built = new NativeFormatter().buildMessages(messages, options);
    expect(built.messages[1]).toEqual({ role: 'assistant', content: sentTurn });
    expect(messages).toEqual(before);
  });

  it('still leaves out a carrier holding another wire\'s item', () => {
    const built = new NativeFormatter().buildMessages(history([responsesCarrier, ...turn()]), options);
    expect(built.messages[1]!.content).toEqual(sentTurn);
  });

  it('leaves them out of another participant\'s message, which goes as a user turn', () => {
    const messages: NormalizedMessage[] = [
      { participant: 'User', content: [{ type: 'text', text: 'zz ask the other agent' }] },
      { participant: 'Other', content: turn() },
      { participant: 'User', content: [{ type: 'text', text: 'zz and you?' }] },
    ];
    const built = new NativeFormatter().buildMessages(messages, { participantMode: 'multiuser', assistantParticipant: 'Claude' });
    expect(serverBlocksIn(built.messages)).toEqual([]);
    expect(JSON.stringify(built.messages)).toContain('zz answer');
  });

  it('builds under cm-owned markers though the stored carrier holds one', () => {
    const marked = carrier(searchResult, { cache_control: { type: 'ephemeral' } });
    const built = new NativeFormatter().buildMessages(
      history([thinking1 as ContentBlock, carrier(serverUse), marked, answer as ContentBlock]),
      { ...options, promptCaching: true, cacheMarkers: 'cm-owned' },
    );
    expect(built.messages[1]!.content).toEqual([thinking1, serverUse, searchResult, answer]);
  });

  it('marks a breakpoint on the sent copy, never the stored block', () => {
    const before = structuredClone(searchResult);
    const messages = history([thinking1 as ContentBlock, carrier(serverUse), carrier(searchResult)]);
    messages[1] = { ...messages[1]!, cacheBreakpoint: true };
    const built = new NativeFormatter().buildMessages(messages, { ...options, promptCaching: true });
    expect(built.messages[1]!.content).toEqual([
      thinking1, serverUse, { ...searchResult, cache_control: { type: 'ephemeral' } },
    ]);
    expect(searchResult).toEqual(before);
  });
});

describe('toAnthropicContent', () => {
  it('converts each carrier to its server block in place and leaves out another wire\'s item', () => {
    expect(toAnthropicContent([...turn(), responsesCarrier])).toEqual(sentTurn);
  });

  it('sends a server block given as itself', () => {
    expect(toAnthropicContent([serverUse as unknown as ContentBlock, answer as ContentBlock])).toEqual([serverUse, answer]);
  });
});

describe('complete()', () => {
  it('keeps a turn\'s server blocks on carriers, and sends them back verbatim', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({
        id: 'msg_zz', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
        content: bodies.length === 1 ? sentTurn : [{ type: 'text', text: 'zz ok' }],
        stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const membrane = new Membrane(
      new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } }),
      { formatter: new NativeFormatter() },
    );
    const config = { model: 'claude-sonnet-4-6', maxTokens: 32 };
    const question = history()[0]!;
    const first = await membrane.complete({ messages: [question], assistantParticipant: 'Claude', config });
    expect(first.content).toEqual([thinking1, carrier(serverUse), carrier(searchResult), thinking2, answer]);

    await membrane.complete({
      messages: [question, { participant: 'Claude', content: first.content }, history()[2]!],
      assistantParticipant: 'Claude',
      config,
    });
    expect(bodies[1].messages[1]).toEqual({ role: 'assistant', content: sentTurn });
  });
});

describe('the native tool loop', () => {
  // One round that searched and then called a client tool, the shape whose
  // continuation the API refuses with the server blocks left out.
  const call = { type: 'tool_use', id: 'toolu_zz1', name: 'record', input: { fact: 'zz' } };
  const toolTurn = [thinking1, serverUse, searchResult, thinking2, call];

  function recordingAdapter(sent: any[]): ProviderAdapter {
    return {
      name: 'anthropic', supportsModel: () => true,
      complete: async () => { throw new Error('Unexpected complete'); },
      stream: async (request) => {
        sent.push(structuredClone(request));
        const first = sent.length === 1;
        return {
          content: first ? toolTurn : [{ type: 'text', text: 'zz done' }],
          stopReason: first ? 'tool_use' : 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 },
          raw: {},
        };
      },
    };
  }
  const request = (): NormalizedRequest => ({
    messages: [history()[0]!],
    assistantParticipant: 'Claude',
    config: { model: 'claude-sonnet-4-6', maxTokens: 32 },
    toolMode: 'native',
    tools: [{ name: 'record', description: 'Record a fact.', inputSchema: { type: 'object' } }],
  });
  const results = (calls: Array<{ id: string }>) =>
    calls.map((c) => ({ toolUseId: c.id, toolName: 'record', content: 'zz recorded' }));

  it('sends a history\'s server blocks only in the assistant\'s own turns, and marks only the copy', async () => {
    const sent: any[] = [];
    const membrane = new Membrane(recordingAdapter(sent));
    const own = [thinking1 as ContentBlock, carrier(serverUse), carrier(searchResult)];
    const messages: NormalizedMessage[] = [
      { participant: 'User', content: [{ type: 'text', text: 'zz search, and ask Other' }] },
      { participant: 'Claude', content: own, cacheBreakpoint: true },
      // Another agent's turn, without its thinking: a reasoning block in a
      // user turn is the normalizer's to re-role, which this test isn't about.
      { participant: 'Other', content: [carrier(serverUse), carrier(searchResult), answer as ContentBlock] },
      { participant: 'User', content: [{ type: 'text', text: 'zz now record it' }] },
    ];
    const before = structuredClone(messages);
    await membrane.stream({ ...request(), messages }, { onToolCalls: async (calls) => results(calls) });
    expect(sent[0].messages[1]).toEqual({
      role: 'assistant',
      content: [thinking1, serverUse, { ...searchResult, cache_control: { type: 'ephemeral' } }],
    });
    expect(serverBlocksIn(sent[0].messages.slice(2))).toEqual([]);
    expect(messages).toEqual(before);
  });

  it.each(['stream', 'streamYielding'] as const)('%s sends the round\'s server blocks back with its tool result', async (method) => {
    const sent: any[] = [];
    const membrane = new Membrane(recordingAdapter(sent));
    if (method === 'stream') {
      await membrane.stream(request(), { onToolCalls: async (calls) => results(calls) });
    } else {
      const stream = membrane.streamYielding(request());
      for await (const event of stream) {
        if (event.type === 'error') throw event.error;
        if (event.type === 'tool-calls') stream.provideToolResults(results(event.calls));
      }
    }
    expect(sent).toHaveLength(2);
    expect(sent[1].messages[1]).toEqual({ role: 'assistant', content: toolTurn });
    expect(sent[1].messages[2].content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_zz1' }),
    ]);
  });
});

describe('the Anthropic adapter\'s stream', () => {
  function fakeStream(events: unknown[]) {
    return {
      controller: { abort() { /* noop */ } },
      [Symbol.asyncIterator]() {
        let i = 0;
        return { async next() { return i < events.length ? { value: events[i++], done: false } : { value: undefined, done: true }; } };
      },
    };
  }

  it('assembles a server tool call\'s input from its input_json_delta fragments', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'zz-key', cacheKeepalive: { enabled: false } });
    (adapter as any).client = {
      messages: {
        stream: async () => fakeStream([
          { type: 'message_start', message: { model: 'claude-zz-1', usage: { input_tokens: 10 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srvtoolu_zz1', name: 'web_search', input: {} } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query": "zz lat' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'est release"}' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: searchResult },
          { type: 'content_block_stop', index: 1 },
          { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'zz answer' } },
          { type: 'content_block_stop', index: 2 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
        ]),
      },
    };
    const res: any = await adapter.stream(
      { model: 'claude-zz-1', maxTokens: 64, messages: [{ role: 'user', content: [{ type: 'text', text: 'zz ask' }] }] } as any,
      { onChunk: () => {} } as any,
    );
    expect(res.content).toEqual([serverUse, searchResult, answer]);
  });
});

describe('wires with no form for them', () => {
  const anthropicShaped = () => new NativeFormatter().buildMessages(history(), options).messages as any[];

  it('the Responses formatter sends no server block as an item, and still replays its own', () => {
    const built = new OpenAIResponsesFormatter().buildMessages(history([...turn(), responsesCarrier]), options);
    expect(serverBlocksIn(built.messages)).toEqual([]);
    expect(JSON.stringify(built.messages)).toContain('zz answer');
    expect(built.messages).toContainEqual(expect.objectContaining({ type: 'reasoning', id: 'rs_zz1' }));
  });

  it('the Responses formatter leaves out a server block given as itself', () => {
    const built = new OpenAIResponsesFormatter().buildMessages(
      history([serverUse as unknown as ContentBlock, answer as ContentBlock]),
      options,
    );
    expect(serverBlocksIn(built.messages)).toEqual([]);
    expect(JSON.stringify(built.messages)).toContain('zz answer');
  });

  it('the Responses input normalization leaves out their carriers, with no empty part', () => {
    const items = normalizeResponsesInput([
      { role: 'assistant', content: [carrier(serverUse), carrier(searchResult), answer] },
      { role: 'assistant', content: [carrier(serverUse), carrier(searchResult)] },
    ] as ProviderRequest['messages']);
    expect(items).toEqual([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'zz answer' }] }]);
  });

  it('the Responses input normalization leaves them out, and a message of only them', () => {
    const items = normalizeResponsesInput([
      ...anthropicShaped(),
      { role: 'assistant', content: [serverUse, searchResult] },
    ] as ProviderRequest['messages']);
    expect(serverBlocksIn(items)).toEqual([]);
    expect(JSON.stringify(items)).toContain('zz answer');
    expect(items).toHaveLength(3);
  });

  it.each([
    ['OpenAI', (m: any[]) => (new OpenAIAdapter({ apiKey: 'zz' }) as any).convertMessages(m)],
    ['OpenRouter', (m: any[]) => (new OpenRouterAdapter({ apiKey: 'zz' }) as any).convertMessages(m)],
    ['OpenAI-compatible', (m: any[]) =>
      (new OpenAICompatibleAdapter({ apiKey: 'zz', baseURL: 'http://localhost' }) as any).convertMessages(m)],
    ['Gemini', (m: any[]) => (new GeminiAdapter({ apiKey: 'zz' }) as any).convertMessages(m, 'gemini-2.5-pro')],
    ['OpenAI completions', (m: any[]) => {
      const adapter = new OpenAICompletionsAdapter({ baseURL: 'http://zz-host.invalid/v1', apiKey: 'zz' }) as any;
      return m.map((message) => adapter.extractTextContent(message.content));
    }],
  ])('the %s adapter leaves them out of what it sends', (_name, convert) => {
    const out = convert(anthropicShaped());
    expect(serverBlocksIn(out)).toEqual([]);
    expect(JSON.stringify(out)).not.toContain('srvtoolu_zz1');
    expect(JSON.stringify(out)).toContain('zz answer');
  });

  it.each([
    ['XML', () => new AnthropicXmlFormatter()],
    ['completions', () => new CompletionsFormatter()],
  ] as const)('the %s formatter writes the turn as if its carriers weren\'t there', (_name, create) => {
    const withCarriers = create().buildMessages(history(), options);
    const without = create().buildMessages(history([thinking1 as ContentBlock, thinking2 as ContentBlock, answer as ContentBlock]), options);
    expect(withCarriers.messages).toEqual(without.messages);
  });

  it('Bedrock, the Anthropic wire on AWS, passes them through', () => {
    const adapter = new BedrockAdapter({ accessKeyId: 'zz', secretAccessKey: 'zz', region: 'us-west-2' });
    const built = (adapter as any).buildRequest({ model: 'anthropic.claude-sonnet-4-6', messages: anthropicShaped(), maxTokens: 32 });
    expect(built.messages[1].content).toEqual(sentTurn);
  });
});
