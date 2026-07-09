import { describe, it, expect, afterEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';

const ORIGINAL_API_KEY = process.env.ANTHROPIC_API_KEY;
const ORIGINAL_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN;

afterEach(() => {
  process.env.ANTHROPIC_API_KEY = ORIGINAL_API_KEY;
  process.env.ANTHROPIC_AUTH_TOKEN = ORIGINAL_AUTH_TOKEN;
});

function getClient(adapter: AnthropicAdapter): Anthropic {
  return (adapter as unknown as { client: Anthropic }).client;
}

describe('AnthropicAdapter auth configuration', () => {
  it('uses explicit OAuth/Bearer auth without also sending an API key', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-from-env';

    const adapter = new AnthropicAdapter({ authToken: 'oauth-token' });
    const client = getClient(adapter);

    expect(client.authToken).toBe('oauth-token');
    expect(client.apiKey).toBeNull();
  });

  it('keeps explicit API-key auth available', () => {
    const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
    const client = getClient(adapter);

    expect(client.apiKey).toBe('sk-test');
  });
});
