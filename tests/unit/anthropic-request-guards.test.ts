/**
 * Anthropic request guards
 *
 * Two wire-boundary repairs in the Anthropic adapter, both of which
 * previously produced a non-retryable 400 that killed the whole turn:
 *
 * 1. Temperature stripping for models that reject sampling parameters
 *    (the known claude-haiku-4-5 case; Opus 4.7+/Sonnet 5/Fable 5 have the
 *    parameters removed from the API surface). Mirrors the OpenAI
 *    provider's `noTemperatureSupport` gate.
 *
 * 2. Root-level oneOf/anyOf/allOf in a tool's input schema (legal MCP,
 *    illegal for Anthropic tools) is flattened into a single object schema
 *    via `flattenRootSchemaUnion` before the request is shipped.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../src/providers/anthropic.js';
import { flattenRootSchemaUnion } from '../../src/providers/anthropic-tool-schema.js';

// ---------------------------------------------------------------------------
// Helpers — adapter with the SDK client stubbed out so we can capture the
// exact outgoing request payload (same pattern as
// anthropic-thinking-signature.test.ts).
// ---------------------------------------------------------------------------

function captureAdapter() {
  const adapter = new AnthropicAdapter({ apiKey: 'sk-test' });
  const captured: any[] = [];
  (adapter as any).client = {
    messages: {
      create: async (req: any) => {
        captured.push(req);
        return {
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          model: req.model,
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  return { adapter, captured };
}

const baseRequest = {
  messages: [{ role: 'user', content: 'hi' } as any],
  maxTokens: 64,
};

// ---------------------------------------------------------------------------
// 1. Temperature stripping (finding 6.12)
// ---------------------------------------------------------------------------

describe('AnthropicAdapter: sampling-parameter model gate', () => {
  it('strips temperature for a model in the reject-list (claude-haiku-4-5)', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-haiku-4-5',
      temperature: 0.7,
    } as any);

    expect(captured).toHaveLength(1);
    expect(captured[0]).not.toHaveProperty('temperature');
  });

  it('strips temperature for dated snapshots of reject-list models', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-haiku-4-5-20251001',
      temperature: 0.7,
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
  });

  it('strips top_p and top_k too for reject-list models', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-opus-4-8',
      topP: 0.9,
      topK: 40,
    } as any);

    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[0]).not.toHaveProperty('top_k');
  });

  it('passes temperature through for models that still accept it', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
    } as any);

    expect(captured[0].temperature).toBe(0.7);
  });

  it('does not confuse claude-sonnet-4-5 with the claude-sonnet-5 prefix', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-5',
      temperature: 0.7,
    } as any);
    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5-20250929',
      temperature: 0.7,
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature'); // sonnet-5: stripped
    expect(captured[1].temperature).toBe(0.7);             // sonnet-4-5: kept
  });

  it('strips temperature/top_k when extended thinking is enabled (any model)', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
      topK: 40,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    } as any);

    expect(captured[0]).not.toHaveProperty('temperature');
    expect(captured[0]).not.toHaveProperty('top_k');
    expect(captured[0].thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
  });

  it('keeps temperature when thinking is explicitly disabled', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      temperature: 0.7,
      thinking: { type: 'disabled' },
    } as any);

    expect(captured[0].temperature).toBe(0.7);
  });

  it('strips out-of-range top_p when thinking is on but keeps [0.95, 1]', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      topP: 0.9,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    } as any);
    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      topP: 0.97,
      thinking: { type: 'enabled', budget_tokens: 2048 },
    } as any);

    expect(captured[0]).not.toHaveProperty('top_p');
    expect(captured[1].top_p).toBe(0.97);
  });
});

// ---------------------------------------------------------------------------
// 2. Root-level schema union flattening (finding 6.13)
// ---------------------------------------------------------------------------

describe('flattenRootSchemaUnion', () => {
  it('returns the same reference when there is nothing to repair', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a'],
    };
    expect(flattenRootSchemaUnion(schema)).toBe(schema);
  });

  it('leaves nested unions (inside properties) untouched', () => {
    const schema = {
      type: 'object',
      properties: {
        value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
      },
    };
    expect(flattenRootSchemaUnion(schema)).toBe(schema);
  });

  it('flattens a root oneOf of object variants into a single object schema', () => {
    const schema = {
      oneOf: [
        {
          type: 'object',
          properties: { channelId: { type: 'string' }, message: { type: 'string' } },
          required: ['channelId', 'message'],
        },
        {
          type: 'object',
          properties: { userId: { type: 'string' }, message: { type: 'string' } },
          required: ['userId', 'message'],
        },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('oneOf');
    expect(result).not.toHaveProperty('anyOf');
    expect(result.type).toBe('object');
    expect(Object.keys(result.properties).sort()).toEqual([
      'channelId',
      'message',
      'userId',
    ]);
    // Only keys required by every variant stay required.
    expect(result.required).toEqual(['message']);
    // The union intent survives as prose.
    expect(result.description).toContain('channelId, message');
    expect(result.description).toContain('userId, message');
  });

  it('flattens a root anyOf the same way', () => {
    const schema = {
      description: 'Query tool',
      anyOf: [
        { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
        { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('anyOf');
    expect(result.type).toBe('object');
    expect(Object.keys(result.properties).sort()).toEqual(['id', 'q']);
    expect(result.required).toBeUndefined(); // intersection is empty
    expect(result.description).toContain('Query tool');
  });

  it('unions required lists for a root allOf (intersective semantics)', () => {
    const schema = {
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { b: { type: 'string' } }, required: ['b'] },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('allOf');
    expect(result.type).toBe('object');
    expect([...result.required].sort()).toEqual(['a', 'b']);
  });

  it('drops variant-level additionalProperties:false from the merged schema', () => {
    const schema = {
      oneOf: [
        { type: 'object', properties: { a: {} }, additionalProperties: false },
        { type: 'object', properties: { b: {} }, additionalProperties: false },
      ],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;
    expect(result).not.toHaveProperty('additionalProperties');
  });

  it('falls back to a permissive object schema for non-object variants', () => {
    const schema = {
      description: 'Weird tool',
      oneOf: [{ type: 'string' }, { type: 'object', properties: { a: {} } }],
    };

    const result = flattenRootSchemaUnion(schema) as Record<string, any>;

    expect(result).not.toHaveProperty('oneOf');
    expect(result.type).toBe('object');
    expect(result.additionalProperties).toBe(true);
    expect(result.description).toContain('Weird tool');
    expect(result.description).toContain('"type":"string"');
  });

  it('passes non-object schemas through untouched', () => {
    expect(flattenRootSchemaUnion(undefined)).toBeUndefined();
    expect(flattenRootSchemaUnion(null)).toBeNull();
    expect(flattenRootSchemaUnion('not a schema')).toBe('not a schema');
  });
});

describe('AnthropicAdapter: tool input_schema union flattening', () => {
  it('rewrites a root oneOf so the compiled tool schema has no root-level union', async () => {
    const { adapter, captured } = captureAdapter();

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      tools: [
        {
          name: 'send_message',
          description: 'Send a message to a channel or user',
          input_schema: {
            oneOf: [
              {
                type: 'object',
                properties: { channelId: { type: 'string' }, text: { type: 'string' } },
                required: ['channelId', 'text'],
              },
              {
                type: 'object',
                properties: { userId: { type: 'string' }, text: { type: 'string' } },
                required: ['userId', 'text'],
              },
            ],
          },
        },
      ],
    } as any);

    const shippedTool = captured[0].tools[0];
    expect(shippedTool.name).toBe('send_message');
    expect(shippedTool.input_schema).not.toHaveProperty('oneOf');
    expect(shippedTool.input_schema).not.toHaveProperty('anyOf');
    expect(shippedTool.input_schema).not.toHaveProperty('allOf');
    expect(shippedTool.input_schema.type).toBe('object');
    expect(Object.keys(shippedTool.input_schema.properties).sort()).toEqual([
      'channelId',
      'text',
      'userId',
    ]);
  });

  it('leaves well-formed tools untouched (same object reference)', async () => {
    const { adapter, captured } = captureAdapter();

    const tool = {
      name: 'get_weather',
      description: 'Get the weather',
      input_schema: {
        type: 'object',
        properties: { location: { type: 'string' } },
        required: ['location'],
      },
    };

    await adapter.complete({
      ...baseRequest,
      model: 'claude-sonnet-4-5',
      tools: [tool],
    } as any);

    expect(captured[0].tools[0]).toBe(tool);
  });
});
