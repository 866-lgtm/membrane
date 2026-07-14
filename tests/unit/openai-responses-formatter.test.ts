import { describe, expect, it } from 'vitest';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';

const options = {
  participantMode: 'multiuser' as const,
  assistantParticipant: 'Codex',
  systemPrompt: 'must not be injected over imported developer items',
};

describe('OpenAIResponsesFormatter', () => {
  it('replays native items exactly, then converts only the new tail', () => {
    const reasoning = {
      type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [],
    };
    const assistant = {
      type: 'message', id: 'msg_1', role: 'assistant', phase: 'final_answer',
      content: [{ type: 'output_text', text: 'old answer' }],
    };
    const formatter = new OpenAIResponsesFormatter();
    const result = formatter.buildMessages([
      {
        participant: 'Codex',
        content: [
          { type: 'redacted_thinking', data: 'opaque', rawItem: reasoning } as never,
          { type: 'text', text: 'old answer', rawItem: assistant } as never,
        ],
      },
      { participant: 'user', content: [{ type: 'text', text: 'new turn' }] },
    ], options);

    expect(result.messages).toEqual([
      reasoning,
      assistant,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'new turn' }] },
    ]);
    expect(result.systemContent).toBeUndefined();
  });

  it('deduplicates a multi-part assistant item without losing its phase', () => {
    const item = {
      type: 'message', id: 'msg_multi', role: 'assistant', phase: 'commentary',
      content: [
        { type: 'output_text', text: 'a' },
        { type: 'output_text', text: 'b' },
      ],
    };
    const result = new OpenAIResponsesFormatter().buildMessages([{
      participant: 'Codex',
      content: [
        { type: 'text', text: 'a', rawItem: item } as never,
        { type: 'text', text: 'b', rawItem: structuredClone(item) } as never,
      ],
    }], options);

    expect(result.messages).toEqual([item]);
  });
});
