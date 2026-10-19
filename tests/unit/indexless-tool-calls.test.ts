/**
 * Streamed tool calls whose `tool_calls` entries carry no `index`
 * (antra-tess/membrane#159, part 2).
 *
 * OpenAI sends `index` on every entry; some OpenAI-compatible servers leave it
 * out. Every entry without one (absent or `null`) used to go to slot 0, so two
 * calls with different ids became one: the second's id and name replaced the
 * first's, and their argument strings ran together. Now such an entry starts
 * a new call only when it carries an id that no call has and the newest call
 * already has an id; otherwise it joins the call with its id, or the newest
 * call. Entries with an index are placed as before
 * (stream-callback-errors.test.ts covers them).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import type { ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

afterEach(() => { vi.unstubAllGlobals(); });

const wire: ProviderRequest = { model: 'zz-review-model', messages: [{ role: 'user', content: 'go' }], maxTokens: 16 };

/** One SSE frame per delta's `tool_calls`, then the finish and `[DONE]`. */
function sse(deltas: unknown[][]): Response {
  const frames = [...deltas.map(tool_calls => ({ choices: [{ delta: { tool_calls } }] })), { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }];
  const text = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(text, { headers: { 'content-type': 'text/event-stream' } });
}

/** An index-less entry: its id and name only when given, as a later piece of a call carries neither. */
const piece = (id: string | undefined, name: string | undefined, args: string) =>
  ({ ...(id ? { id, type: 'function' } : {}), function: { ...(name ? { name } : {}), arguments: args } });

const adapters: Array<[string, () => ProviderAdapter]> = [
  ['openai', () => new OpenAIAdapter({ apiKey: 'zz-key' })],
  ['openai-compatible', () => new OpenAICompatibleAdapter({ apiKey: 'zz-key', baseURL: 'https://review.invalid/v1' })],
  ['openrouter', () => new OpenRouterAdapter({ apiKey: 'zz-key' })],
];

for (const [name, make] of adapters) {
  describe(`${name}: tool_calls entries with no index`, () => {
    const calls = async (deltas: unknown[][]) => {
      vi.stubGlobal('fetch', vi.fn(async () => sse(deltas)));
      const response = await make().stream(wire, { onChunk() {} }) as any;
      return response.content
        .filter((block: { type: string }) => block.type === 'tool_use')
        .map((block: { id: string; name: string; input: unknown }) => ({ id: block.id, name: block.name, input: block.input }));
    };

    it('calls with different ids stay separate calls, in one delta or across deltas', async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":1}'), piece('call_b', 'zz_b', '{"y":2}')],
        [piece('call_c', 'zz_c', '{"z":3}')],
      ])).toEqual([
        { id: 'call_a', name: 'zz_a', input: { x: 1 } },
        { id: 'call_b', name: 'zz_b', input: { y: 2 } },
        { id: 'call_c', name: 'zz_c', input: { z: 3 } },
      ]);
    });

    it('an index of null counts as none', async () => {
      const nullIndex = (id: string, args: string) => ({ index: null, ...piece(id, `zz_${id}`, args) });
      expect(await calls([[nullIndex('call_a', '{"x":1}')], [nullIndex('call_b', '{"y":2}')]])).toEqual([
        { id: 'call_a', name: 'zz_call_a', input: { x: 1 } },
        { id: 'call_b', name: 'zz_call_b', input: { y: 2 } },
      ]);
    });

    it('a piece without an id continues the newest call', async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":')], [piece(undefined, undefined, '1}')],
        [piece('call_b', 'zz_b', '{"y":')], [piece(undefined, undefined, '2}')],
      ])).toEqual([
        { id: 'call_a', name: 'zz_a', input: { x: 1 } },
        { id: 'call_b', name: 'zz_b', input: { y: 2 } },
      ]);
    });

    it("a call whose every piece repeats its id stays one call, as on main", async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [piece('call_a', undefined, '1}')]])).toEqual([
        { id: 'call_a', name: 'zz_a', input: { x: 1 } },
      ]);
    });

    it("a piece that repeats a call's id joins that call, when another call came between", async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":')], [piece('call_b', 'zz_b', '{"y":2}')], [piece('call_a', undefined, '1}')],
      ])).toEqual([
        { id: 'call_a', name: 'zz_a', input: { x: 1 } },
        { id: 'call_b', name: 'zz_b', input: { y: 2 } },
      ]);
    });

    it("an id that arrives after the call's name joins that call, as on main", async () => {
      expect(await calls([[piece(undefined, 'zz_a', '')], [piece('call_a', undefined, '{"x":1}')]])).toEqual([
        { id: 'call_a', name: 'zz_a', input: { x: 1 } },
      ]);
    });
  });
}
