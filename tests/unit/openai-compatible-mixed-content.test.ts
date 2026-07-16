import { describe, it, expect } from 'vitest';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';

describe('OpenAICompatibleAdapter convertMessages — mixed tool_result + text', () => {
  const adapter = new OpenAICompatibleAdapter({ baseURL: 'http://localhost:8000/v1' });

  const build = (messages: any[]) =>
    (adapter as any).buildRequest({ model: 'test', maxTokens: 100, messages });

  it('re-emits sibling text blocks after tool results instead of dropping them', () => {
    // A user message carrying both the tool_result and an injected text
    // (e.g. the context-manager's trailing summarize instruction). The old
    // behaviour returned only the role:"tool" message, silently deleting
    // the text.
    const req = build([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'status', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ACTIVE' },
          { type: 'text', text: 'Context Manager: please summarize.' },
        ],
      },
    ]);

    expect(req.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [expect.objectContaining({ id: 't1' })] },
      { role: 'tool', tool_call_id: 't1', content: 'ACTIVE' },
      { role: 'user', content: 'Context Manager: please summarize.' },
    ]);
  });

  it('keeps tool-only messages unchanged', () => {
    const req = build([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'status', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ACTIVE' }] },
    ]);

    expect(req.messages).toEqual([
      { role: 'assistant', content: null, tool_calls: [expect.objectContaining({ id: 't1' })] },
      { role: 'tool', tool_call_id: 't1', content: 'ACTIVE' },
    ]);
  });

  it('re-emits sibling image blocks as a content-parts user message', () => {
    const req = build([
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'shot', input: {} }] },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
    ]);

    expect(req.messages[1]).toEqual({ role: 'tool', tool_call_id: 't1', content: 'ok' });
    expect(req.messages[2].role).toBe('user');
    expect(req.messages[2].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ]);
  });
});
