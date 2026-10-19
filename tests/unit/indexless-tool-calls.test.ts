/**
 * Streamed tool calls whose `tool_calls` entries carry no `index`
 * (antra-tess/membrane#159, part 2).
 *
 * OpenAI's API spec requires `index` on every entry; some OpenAI-compatible
 * servers are reported to leave it out. Every entry without one (absent or
 * `null`) used to go to slot 0, so two calls became one: the second's id and
 * name replaced the first's, and their argument strings ran together. Now such
 * an entry never takes a slot, and one that carries nothing is dropped. Any
 * other joins the call that has its id; otherwise it starts a new call when it
 * carries a name and the current call (the one the last entry went to) has a
 * different name, or has an id while it carries a new one; otherwise it joins
 * the current call. A call keeps the first id and the first name a piece gives
 * it. Entries with an index are placed in their slots as before
 * (stream-callback-errors.test.ts covers them), and a slot's first entry takes
 * over a call that began without an index under its id.
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

/** An entry with no index: its id and name only when given, as a later piece of a call often carries neither. */
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
    const a = { id: 'call_a', name: 'zz_a', input: { x: 1 } };
    const b = { id: 'call_b', name: 'zz_b', input: { y: 2 } };

    it('calls with different ids and names stay separate calls, in one delta or across deltas', async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":1}'), piece('call_b', 'zz_b', '{"y":2}')],
        [piece('call_c', 'zz_c', '{"z":3}')],
      ])).toEqual([a, b, { id: 'call_c', name: 'zz_c', input: { z: 3 } }]);
    });

    it('two calls of the same tool, each with its own id, stay separate calls', async () => {
      expect(await calls([[piece('call_a', 'zz_read', '{"x":1}')], [piece('call_b', 'zz_read', '{"y":2}')]])).toEqual([
        { id: 'call_a', name: 'zz_read', input: { x: 1 } },
        { id: 'call_b', name: 'zz_read', input: { y: 2 } },
      ]);
    });

    it('calls with no ids but different names stay separate calls', async () => {
      expect(await calls([[piece(undefined, 'zz_a', '{"x":1}')], [piece(undefined, 'zz_b', '{"y":2}')]])).toEqual([
        { id: '', name: 'zz_a', input: { x: 1 } },
        { id: '', name: 'zz_b', input: { y: 2 } },
      ]);
    });

    it('an index of null counts as none', async () => {
      const nullIndex = (id: string, args: string) => ({ index: null, ...piece(id, `zz_${id}`, args) });
      expect(await calls([[nullIndex('call_a', '{"x":1}')], [nullIndex('call_b', '{"y":2}')]])).toEqual([
        { id: 'call_a', name: 'zz_call_a', input: { x: 1 } },
        { id: 'call_b', name: 'zz_call_b', input: { y: 2 } },
      ]);
    });

    it('a piece with only arguments continues the call before it', async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":')], [piece(undefined, undefined, '1}')],
        [piece('call_b', 'zz_b', '{"y":')], [piece(undefined, undefined, '2}')],
      ])).toEqual([a, b]);
    });

    it('a call whose every piece repeats its id stays one call, as on main', async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [piece('call_a', undefined, '1}')]])).toEqual([a]);
    });

    it("a piece that repeats a call's id joins that call wherever it is, and a piece with only arguments then continues it", async () => {
      expect(await calls([
        [piece('call_a', 'zz_a', '{"x":1}')], [piece('call_b', 'zz_b', '{"y":')], [piece('call_c', 'zz_c', '{"z":3}')],
        [piece('call_b', undefined, '')], [piece(undefined, undefined, '2}')],
      ])).toEqual([a, b, { id: 'call_c', name: 'zz_c', input: { z: 3 } }]);
    });

    it("an id that arrives after the call's name joins that call, as on main", async () => {
      expect(await calls([[piece(undefined, 'zz_a', '')], [piece('call_a', undefined, '{"x":1}')]])).toEqual([a]);
    });

    it('calls whose names come before their ids stay apart, each with its own name', async () => {
      expect(await calls([
        [piece(undefined, 'zz_a', '')], [piece('call_a', undefined, '{"x":1}')],
        [piece(undefined, 'zz_b', '')], [piece('call_b', undefined, '{"y":2}')],
      ])).toEqual([a, b]);
    });

    it('a later piece that carries a new id and no name stays with its call, which keeps the id it started under', async () => {
      expect(await calls([[piece('call_a1', 'zz_a', '{"x":')], [piece('call_a2', undefined, '1}')]])).toEqual([
        { id: 'call_a1', name: 'zz_a', input: { x: 1 } },
      ]);
    });

    it("a later piece that repeats the call's id under another name doesn't rename the call", async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [piece('call_a', 'zz_other', '1}')]])).toEqual([a]);
    });

    it("an entry with no index takes no index's slot: those with one come first, in index order", async () => {
      const at = (index: number, id: string, args: string) => ({ index, ...piece(id, `zz_${id.slice(-1)}`, args) });
      expect(await calls([[at(0, 'call_a', '{"x":1}')], [piece('call_b', 'zz_b', '{"y":2}')], [at(1, 'call_c', '{"z":3}')]])).toEqual([
        a, { id: 'call_c', name: 'zz_c', input: { z: 3 } }, b,
      ]);
    });

    it('an entry with no index after a call at a large index is placed without walking the index space', async () => {
      const large = { index: 100_000_000, ...piece('call_z', 'zz_z', '{}') };
      const started = performance.now();
      const placed = await calls([[large], [piece('call_a', 'zz_a', '{"x":1}')]]);
      // A walk of the 10^8 slots below it took about 8 s (the first round's toolCallSlot); placing takes well under 1 s.
      expect(performance.now() - started).toBeLessThan(1000);
      expect(placed).toEqual([{ id: 'call_z', name: 'zz_z', input: {} }, a]);
    });

    it('a call that began without an index keeps its pieces when later ones carry its id and an index', async () => {
      expect(await calls([[piece('call_a', 'zz_a', '{"x":')], [{ index: 0, ...piece('call_a', undefined, '1}') }]])).toEqual([a]);
    });

    it('an entry with no index that carries nothing opens no call', async () => {
      expect(await calls([[{}], [{ index: 0, ...piece('call_a', 'zz_a', '{"x":1}') }]])).toEqual([a]);
    });

    it('a call whose id comes first and whose name follows takes the name', async () => {
      expect(await calls([[piece('call_a', undefined, '{"x":')], [piece(undefined, 'zz_a', '1}')]])).toEqual([a]);
    });

    it('a call whose name is repeated and whose id arrives later stays one call', async () => {
      expect(await calls([[piece(undefined, 'zz_a', '{"x":')], [piece('call_a', 'zz_a', '1}')]])).toEqual([a]);
    });

    it('an indexed call continued in its slot stays one call, as on main', async () => {
      expect(await calls([[{ index: 0, ...piece('call_a', 'zz_a', '{"x":') }], [{ index: 0, ...piece(undefined, undefined, '1}') }]])).toEqual([a]);
    });

    it("a later indexed piece with another id and name doesn't change the call's", async () => {
      expect(await calls([[{ index: 0, ...piece('call_a', 'zz_a', '{"x":') }], [{ index: 0, ...piece('call_b', 'zz_b', '1}') }]])).toEqual([a]);
    });
  });
}
