/**
 * A default `anthropic-beta` header, given in `defaultHeaders`, read as the
 * Anthropic SDK's buildHeaders reads it, and kept beside a beta the adapter
 * adds for one request (here, thinking-binding controls' beta).
 */
import { describe, it, expect } from 'vitest';
import { AnthropicAdapter, THINKING_BINDING_BETA } from '../../src/providers/anthropic.js';

/** The `anthropic-beta` header a request goes out with, for a given defaultHeaders bag. */
async function sentBeta(defaultHeaders: unknown): Promise<string | undefined> {
  const seen: Array<Record<string, string> | undefined> = [];
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test', cacheKeepalive: { enabled: false }, defaultHeaders: defaultHeaders as any });
  (adapter as any).client = { messages: { create: async (_body: unknown, opts: { headers?: Record<string, string> }) => {
    seen.push(opts.headers);
    return { content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } };
  } } };
  await adapter.complete({
    model: 'claude-opus-5-5',
    maxTokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    thinking: { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } },
  } as any);
  return seen[0]?.['anthropic-beta'];
}

describe('a default anthropic-beta beside a per-request beta', () => {
  it('keeps an array-valued default', async () => {
    expect(await sentBeta({ 'anthropic-beta': ['oauth-2025-04-20'] })).toBe(`oauth-2025-04-20,${THINKING_BINDING_BETA}`);
  });

  it('keeps every value of an array, and null clears the values before it', async () => {
    expect(await sentBeta({ 'anthropic-beta': ['old-beta', null, 'oauth-2025-04-20', 'other-beta'] }))
      .toBe(`oauth-2025-04-20,other-beta,${THINKING_BINDING_BETA}`);
  });

  it('entries rows for the header append', async () => {
    expect(await sentBeta([['anthropic-beta', 'a-beta'], ['Anthropic-Beta', 'b-beta']])).toBe(`a-beta,b-beta,${THINKING_BINDING_BETA}`);
  });

  it('a later object key that differs only in case replaces the values an earlier one gave', async () => {
    expect(await sentBeta({ 'anthropic-beta': ['old-beta'], 'Anthropic-Beta': ['new-beta'] })).toBe(`new-beta,${THINKING_BINDING_BETA}`);
  });

  it('an undefined value is skipped', async () => {
    expect(await sentBeta({ 'anthropic-beta': ['a-beta', undefined] })).toBe(`a-beta,${THINKING_BINDING_BETA}`);
  });
});
