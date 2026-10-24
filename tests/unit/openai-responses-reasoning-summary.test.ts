/**
 * Reasoning summaries on the Responses API. With store:false the adapter
 * always asks for reasoning.encrypted_content, so every reasoning item comes
 * back encrypted; when reasoning.summary is requested the same item also
 * carries readable summary parts. Both must survive: the summary as a display
 * thinking block, the encrypted payload as the round-trip carrier, and the
 * item itself replayed exactly once on the next turn.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAIResponsesAPIAdapter,
  type OpenAIResponsesOutputItem,
} from '../../src/providers/openai-responses-api.js';
import { Membrane } from '../../src/membrane.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { FidelityNotes } from '../../src/utils/fidelity.js';
import type { ContentBlock, ProviderRequest } from '../../src/types/index.js';

function providerRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return { model: 'gpt-5.1', messages: [], maxTokens: 8192, ...overrides };
}

function jsonResponse(output: OpenAIResponsesOutputItem[]): Response {
  return new Response(JSON.stringify({
    id: 'resp_1', model: 'gpt-5.1', status: 'completed', output,
    usage: { input_tokens: 10, output_tokens: 5 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(events: unknown[]): Response {
  const sse = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(new TextEncoder().encode(sse), { status: 200 });
}

const reasoningItem: OpenAIResponsesOutputItem = {
  type: 'reasoning',
  id: 'rs_sum',
  summary: [
    { type: 'summary_text', text: '**Checking the request**\n\nThe user asked about the pond.' },
    { type: 'summary_text', text: '**Planning a reply**\n\nKeep it short.' },
  ],
  encrypted_content: 'enc-sum',
  status: 'completed',
};

const answerItem: OpenAIResponsesOutputItem = {
  type: 'message',
  id: 'msg_sum',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: 'The pond is 1.6m deep.', annotations: [] }],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAIResponsesAPIAdapter reasoning summaries', () => {
  it('keeps the summary as a thinking block beside the encrypted carrier', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([reasoningItem, answerItem])));
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const result = await adapter.complete(providerRequest());

    expect(result.content.map((block) => block.type)).toEqual(['thinking', 'redacted_thinking', 'text']);
    expect(result.content[0]).toEqual({
      type: 'thinking',
      thinking: '**Checking the request**\n\nThe user asked about the pond.\n\n**Planning a reply**\n\nKeep it short.',
      // Display-only: never on the wire, never billed, no part of the raw-form pairing.
      tokenEstimate: 0,
      itemId: 'rs_sum',
      outputIndex: 0,
    });
    expect(result.content[1]).toMatchObject({
      type: 'redacted_thinking', data: 'enc-sum', itemId: 'rs_sum', outputIndex: 0, rawItem: reasoningItem,
    });
    expect(result.outputItems).toEqual([reasoningItem, answerItem]);
  });

  it('emits only the carrier when the summary is empty or blank', async () => {
    const blank = { ...reasoningItem, id: 'rs_blank', summary: [{ type: 'summary_text', text: '  ' }] };
    const none = { ...reasoningItem, id: 'rs_none', summary: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([blank, none, answerItem])));
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const result = await adapter.complete(providerRequest());

    expect(result.content.map((block) => block.type)).toEqual(['redacted_thinking', 'redacted_thinking', 'text']);
  });

  it('takes the summary from output_item.done when streaming', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_sum', summary: [], status: 'in_progress' } },
      { type: 'response.reasoning_summary_part.added', output_index: 0, item_id: 'rs_sum', summary_index: 0, part: { type: 'summary_text', text: '' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_sum', summary_index: 0, delta: '**Checking' },
      { type: 'response.output_item.done', output_index: 0, item: reasoningItem },
      { type: 'response.output_item.added', output_index: 1, item: { ...answerItem, status: 'in_progress', content: [] } },
      { type: 'response.output_text.delta', output_index: 1, content_index: 0, item_id: 'msg_sum', delta: 'The pond is 1.6m deep.' },
      { type: 'response.output_item.done', output_index: 1, item: answerItem },
      { type: 'response.completed', response: { id: 'resp_1', model: 'gpt-5.1', status: 'completed', output: [], usage: { input_tokens: 10, output_tokens: 5 } } },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(events)));

    const chunks: string[] = [];
    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const result = await adapter.stream(providerRequest(), { onChunk: (chunk) => chunks.push(chunk) });

    // Summary text never leaks into the visible text stream.
    expect(chunks).toEqual(['The pond is 1.6m deep.']);
    expect(result.content.map((block) => block.type)).toEqual(['thinking', 'redacted_thinking', 'text']);
    expect((result.content[0] as { thinking: string }).thinking).toContain('**Planning a reply**');
  });

  it('rebuilds the summary from deltas when no done item or terminal output arrives', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_d', summary: [], encrypted_content: 'enc-d', status: 'in_progress' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_d', summary_index: 0, delta: '**First** ' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_d', summary_index: 0, delta: 'thought' },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs_d', summary_index: 1, delta: '**Second** thought' },
      { type: 'response.completed', response: { id: 'resp_d', model: 'gpt-5.1', status: 'completed', output: [] } },
    ];
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(sseResponse(events)));

    const adapter = new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' });
    const result = await adapter.stream(providerRequest(), { onChunk: () => {} });

    expect(result.content[0]).toMatchObject({ type: 'thinking', thinking: '**First** thought\n\n**Second** thought' });
    expect(result.content[1]).toMatchObject({ type: 'redacted_thinking', data: 'enc-d' });
  });
});

describe('Responses reasoning summary round trip', () => {
  const options = {
    participantMode: 'multiuser' as const,
    assistantParticipant: 'Agent',
    systemPrompt: 'system',
  };

  it('replays the reasoning item once, from the carrier, whether or not the summary block survives', () => {
    const formatter = new OpenAIResponsesFormatter();
    const tail = [
      { type: 'redacted_thinking' as const, data: 'enc-sum', rawItem: reasoningItem },
      { type: 'text' as const, text: 'The pond is 1.6m deep.', rawItem: answerItem },
    ];
    for (const content of [[{ type: 'thinking' as const, thinking: 'summary text', tokenEstimate: 0 }, ...tail], tail]) {
      expect(formatter.buildMessages([{ participant: 'Agent', content }], options).messages)
        .toEqual([reasoningItem, answerItem]);
    }
  });

  it('counts the summary as carried by the reasoning item it sits beside, and only there', () => {
    const formatter = new OpenAIResponsesFormatter();
    const summary = { type: 'thinking' as const, thinking: 'summary text', tokenEstimate: 0 };
    const carried = new FidelityNotes();
    formatter.buildMessages([{ participant: 'Agent', content: [
      summary,
      { type: 'redacted_thinking' as const, data: 'enc-sum', rawItem: reasoningItem },
      { type: 'text' as const, text: 'The pond is 1.6m deep.', rawItem: answerItem },
    ] }], { ...options, fidelity: carried });
    expect([...carried.altered]).toEqual([]);

    // With no reasoning item replayed beside it, nothing carries it.
    const alone = new FidelityNotes();
    formatter.buildMessages([{ participant: 'Agent', content: [
      summary,
      { type: 'text' as const, text: 'The pond is 1.6m deep.', rawItem: answerItem },
    ] }], { ...options, fidelity: alone });
    expect([...alone.altered]).toEqual([0]);
  });

  it('replays a reasoning item shared by several blocks once', () => {
    const formatter = new OpenAIResponsesFormatter();
    const result = formatter.buildMessages([
      {
        participant: 'Agent',
        content: [
          { type: 'thinking', thinking: 'summary text', rawItem: reasoningItem },
          { type: 'redacted_thinking', data: 'enc-sum', rawItem: reasoningItem },
          { type: 'text', text: 'The pond is 1.6m deep.', rawItem: answerItem },
        ],
      },
      { participant: 'User', content: [{ type: 'text', text: 'thanks' }] },
    ], options);

    expect(result.messages).toEqual([
      reasoningItem,
      answerItem,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'thanks' }] },
    ]);
  });

  it('still sends one encrypted reasoning item and no summary text when rawItem was not stored', () => {
    const formatter = new OpenAIResponsesFormatter();
    const result = formatter.buildMessages([
      {
        participant: 'Agent',
        content: [
          { type: 'thinking', thinking: 'summary text' },
          { type: 'redacted_thinking', data: 'enc-sum' },
          { type: 'text', text: 'The pond is 1.6m deep.' },
        ],
      },
    ], options);

    expect(result.messages).toEqual([
      { type: 'reasoning', encrypted_content: 'enc-sum', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The pond is 1.6m deep.' }] },
    ]);
  });

  it('carries the summary through Membrane and replays the item once on the next turn', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse([reasoningItem, answerItem]))
      .mockResolvedValueOnce(jsonResponse([answerItem]));
    vi.stubGlobal('fetch', fetchMock);

    const membrane = new Membrane(
      new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }),
      { formatter: new OpenAIResponsesFormatter(), assistantParticipant: 'Agent' },
    );
    const first = await membrane.complete({
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'How deep is the pond?' }] }],
      config: { model: 'gpt-5.1', maxTokens: 1000 },
    });

    const thinking = first.content.find((block): block is ContentBlock & { type: 'thinking' } => block.type === 'thinking');
    expect(thinking?.thinking).toContain('The user asked about the pond.');
    expect(thinking?.tokenEstimate).toBe(0);
    expect(first.content.some((block) => block.type === 'redacted_thinking')).toBe(true);

    await membrane.complete({
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'How deep is the pond?' }] },
        { participant: 'Agent', content: first.content },
        { participant: 'User', content: [{ type: 'text', text: 'thanks' }] },
      ],
      config: { model: 'gpt-5.1', maxTokens: 1000 },
    });

    const body = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    const reasoningInputs = body.input.filter((item: { type?: string }) => item.type === 'reasoning');
    expect(reasoningInputs).toEqual([reasoningItem]);
    expect(JSON.stringify(body.input)).not.toContain('"input_text","text":"summary');
  });
});
