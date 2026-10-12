/**
 * Image data that is no image, under an accepted label.
 *
 * A request builder labels an image by its bytes when they show a JPEG, PNG,
 * GIF or WebP image. For data that showed none of them it used to keep the
 * declared label, so data labelled as an accepted type passed every check: a
 * text file renamed notes.png went to the provider as image/png. The API
 * refuses the whole request, and since the block stays in the agent's history,
 * every later request too. Every path now replaces such data with the
 * placeholder an SVG already got, whatever its label says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Membrane } from '../../src/membrane.js';
import { NativeFormatter } from '../../src/formatters/native.js';
import { AnthropicXmlFormatter } from '../../src/formatters/anthropic-xml.js';
import { OpenAIResponsesFormatter } from '../../src/formatters/openai-responses.js';
import { AnthropicAdapter, toAnthropicContent } from '../../src/providers/anthropic.js';
import { BedrockAdapter } from '../../src/providers/bedrock.js';
import { OpenAIAdapter } from '../../src/providers/openai.js';
import { OpenAICompatibleAdapter } from '../../src/providers/openai-compatible.js';
import { OpenRouterAdapter } from '../../src/providers/openrouter.js';
import { GeminiAdapter } from '../../src/providers/gemini.js';
import { OpenAIResponsesAdapter } from '../../src/providers/openai-responses.js';
import { OpenAIResponsesAPIAdapter } from '../../src/providers/openai-responses-api.js';
import { formatToolResults, formatToolResultsForSplitTurn } from '../../src/utils/tool-parser.js';
import { GEMINI_IMAGE_TYPES, OPENAI_IMAGE_EDIT_TYPES, imageForRequest, toolResultContentForRequest, urlImageForRequest } from '../../src/utils/image-media.js';
import { normalizeResponsesInput } from '../../src/providers/responses-input.js';
import { stubFetchWithSseLines } from '../helpers/sse-fixtures.js';
import type { ContentBlock, NormalizedMessage, NormalizedRequest, ProviderAdapter, ProviderRequest } from '../../src/types/index.js';

// Real 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const NOTES = Buffer.from('notes: buy milk, call Sam').toString('base64');
const SAID = 'its data is not a JPEG, PNG, GIF or WebP image, the formats this request can carry (it was labelled "image/png")';
const notes = (): ContentBlock => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: NOTES } });
const png = (): ContentBlock => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: PNG } });
const options = { participantMode: 'simple' as const, assistantParticipant: 'Claude', humanParticipant: 'User' };

function imagesIn(value: any): any[] {
  if (Array.isArray(value)) return value.flatMap(imagesIn);
  if (!value || typeof value !== 'object') return [];
  return value.type === 'image' ? [value] : Object.values(value).flatMap(imagesIn);
}

/** How often the placeholder appears in a request, however it is serialized
 *  (a text-only tool result carries it JSON-encoded inside a string). */
function placeholders(value: unknown): number {
  return JSON.stringify(value).split('the formats this request can carry').length - 1;
}

// A HEIC header: an ftyp box whose major brand is heic. A GIF header.
const HEIC = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic'), Buffer.alloc(12)]).toString('base64');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00\x00', 'latin1').toString('base64');
const imageOf = (data: string, mediaType: string): ContentBlock => ({ type: 'image', source: { type: 'base64', mediaType, data } });
const urlImage = (url: string): ContentBlock => ({ type: 'image', source: { type: 'url', url } });
const NOTES_URL = `data:image/png;base64,${NOTES}`;
const PNG_URL = `data:image/png;base64,${PNG}`;
const REMOTE = 'https://example.com/cat.png';

function history(toolResult: ContentBlock[]): NormalizedMessage[] {
  return [
    { participant: 'User', content: [{ type: 'text', text: 'What does this say?' }, notes()] },
    { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot_1', name: 'shot', input: {} }] },
    { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot_1', content: toolResult }] },
  ];
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('formatters', () => {
  it.each([
    ['native', () => new NativeFormatter()],
    ['XML', () => new AnthropicXmlFormatter()],
  ] as const)('%s puts the placeholder in place of a message image', (_name, create) => {
    const result = create().buildMessages([{ participant: 'User', content: [notes()] }], options);
    expect(imagesIn(result.messages)).toEqual([]);
    expect(placeholders(result.messages)).toBe(1);
    expect(warn).toHaveBeenCalledWith('[membrane] image block stripped: its data is not a JPEG, PNG, GIF or WebP image (it was labelled "image/png")');
  });

  it('native puts the placeholder in place of a tool-result image and keeps the image beside it', () => {
    const result = new NativeFormatter().buildMessages(history([{ type: 'text', text: 'Screenshot' }, notes(), png()]), options);
    expect(imagesIn(result.messages)).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);
    expect(placeholders(result.messages)).toBe(2);
    expect(JSON.stringify(result.messages)).toContain('Screenshot');
  });

  it('the Responses formatter sends the placeholder as input_text, in a message and in a tool result', () => {
    const result = new OpenAIResponsesFormatter().buildMessages(history([notes()]), options);
    const items = result.messages as any[];
    expect(items[0].content).toEqual([
      { type: 'input_text', text: 'What does this say?' },
      { type: 'input_text', text: expect.stringContaining(SAID) },
    ]);
    const output = items.find(item => item.type === 'function_call_output').output;
    expect(output).toEqual([{ type: 'input_text', text: expect.stringContaining(SAID) }]);
    expect(JSON.stringify(items)).not.toContain(NOTES);
  });
});

describe('membrane request builders', () => {
  it.each(['stream', 'streamYielding'] as const)(
    '%s native tool requests replace it in a message and in a tool result, and hand on the PNG beside it labelled',
    async (method) => {
      const sent: unknown[] = [];
      const adapter: ProviderAdapter = {
        name: 'image-capture', supportsModel: () => true,
        complete: async () => { throw new Error('Unexpected complete'); },
        stream: async (request, callbacks) => {
          sent.push(structuredClone(request));
          callbacks.onChunk('Done');
          return {
            content: [{ type: 'text', text: 'Done' }], stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 }, raw: {},
          };
        },
      };
      const request: NormalizedRequest = {
        messages: history([{ type: 'text', text: 'Screenshot' }, notes(), png()]),
        config: { model: 'claude-sonnet-4-5', maxTokens: 32 }, toolMode: 'native',
        tools: [{ name: 'shot', description: 'Take a screenshot', inputSchema: { type: 'object' } }],
      };
      const membrane = new Membrane(adapter);
      if (method === 'stream') await membrane.stream(request, { onChunk: () => {} });
      else for await (const _event of membrane.streamYielding(request)) { /* drain */ }
      expect(sent).toHaveLength(1);
      expect(placeholders(sent[0])).toBe(2);
      expect(JSON.stringify(sent[0])).not.toContain(NOTES);
      expect(imagesIn(sent[0])).toEqual([{ type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' } }]);
    },
  );

  it('XML split-turn tool results put the placeholder in the result text', () => {
    const result = formatToolResultsForSplitTurn([{ toolUseId: 'shot_1', content: [notes() as any] }]);
    expect(result.hasImages).toBe(false);
    expect(placeholders(result)).toBe(1);
  });
});

const anthropic = () => new AnthropicAdapter({ apiKey: 'test-key', cacheKeepalive: { enabled: false } });
const bedrock = () => new BedrockAdapter({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'us-west-2' });

describe('images whose bytes match a format', () => {
  // Native tool requests now label tool-result images before an adapter sees
  // them. The Anthropic and Bedrock wire must come out byte for byte as it did
  // when the adapters labelled them, so prompt caches keep their prefixes.
  it('reach the Anthropic and Bedrock wire from a native tool request as before', async () => {
    const sent: any[] = [];
    const adapter: ProviderAdapter = {
      name: 'image-capture', supportsModel: () => true,
      complete: async () => { throw new Error('Unexpected complete'); },
      stream: async (request, callbacks) => {
        sent.push(structuredClone(request));
        callbacks.onChunk('Done');
        return {
          content: [{ type: 'text', text: 'Done' }], stopReason: 'end_turn',
          usage: { inputTokens: 1, outputTokens: 1 }, raw: {},
        };
      },
    };
    await new Membrane(adapter).stream({
      messages: [
        { participant: 'User', content: [{ type: 'text', text: 'Take a screenshot' }] },
        { participant: 'Claude', content: [{ type: 'tool_use', id: 'shot_1', name: 'shot', input: {} }] },
        { participant: 'User', content: [{ type: 'tool_result', toolUseId: 'shot_1', content: [{ type: 'text', text: 'Screenshot' }, png()] }] },
      ],
      config: { model: 'claude-sonnet-4-5', maxTokens: 32 }, toolMode: 'native',
      tools: [{ name: 'shot', description: 'Take a screenshot', inputSchema: { type: 'object' } }],
    }, { onChunk: () => {} });
    const toolResultOf = (built: any) =>
      built.messages.flatMap((m: any) => m.content).find((b: any) => b.type === 'tool_result').content;
    expect(JSON.stringify(toolResultOf((anthropic() as any).buildRequest(sent[0])))).toBe(JSON.stringify([
      { type: 'text', text: 'Screenshot' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]));
    expect(JSON.stringify(toolResultOf((bedrock() as any).buildRequest(sent[0])))).toBe(JSON.stringify([
      { type: 'text', text: 'Screenshot' },
      { type: 'image', source: { type: 'base64', data: PNG, media_type: 'image/png' } },
    ]));
  });
});

describe('Anthropic and Bedrock adapters', () => {
  it.each([
    ['Anthropic', anthropic],
    ['Bedrock', bedrock],
  ] as const)('%s replaces it at the top level, keeping its cache breakpoint, and inside a tool result', (_name, create) => {
    const built = (create() as any).buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: NOTES }, cache_control: { type: 'ephemeral' } },
        { type: 'tool_result', tool_use_id: 'shot_1', content: [notes()] },
      ] }],
    });
    const [top, result] = built.messages[0].content;
    expect(top).toEqual({ type: 'text', text: expect.stringContaining(SAID), cache_control: { type: 'ephemeral' } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(SAID) }]);
    expect(imagesIn(built.messages)).toEqual([]);
  });

  it('toAnthropicContent replaces it in an image block and in a generated image', () => {
    const blocks = toAnthropicContent([
      notes(),
      { type: 'generated_image', data: NOTES, mimeType: 'image/png' },
    ] as ContentBlock[]);
    expect(blocks).toEqual([
      { type: 'text', text: expect.stringContaining(SAID) },
      { type: 'text', text: expect.stringContaining(SAID) },
    ]);
  });
});

describe('the Images adapter', () => {
  it('leaves it unattached, as an image block or a generated image, and the transcript shows it as omitted', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    const adapter = new OpenAIResponsesAdapter({ apiKey: 'sk-test', promptFormat: 'transcript', transcriptPreamble: '' });
    await adapter.complete({
      model: 'gpt-image-1', maxTokens: 1,
      messages: [
        { role: 'assistant', content: [{ type: 'generated_image', data: NOTES, mimeType: 'image/png' }] },
        { role: 'user', content: [{ type: 'text', text: 'alice: make it blue' }, notes()] },
      ],
    } as any);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/images\/generations$/);
    expect(JSON.parse(String(init.body)).prompt).toBe(
      '### Assistant\n[Image omitted]\n\n### User\nalice: make it blue\n[Image omitted]\n\n### Assistant',
    );
  });
});

/**
 * OpenAI, OpenAI-compatible, OpenRouter and Gemini make the decision
 * themselves, so a direct call, or a request a hook replaced, is covered as a
 * builder's is. Gemini takes its own formats: HEIC and HEIF, and no GIF.
 */
describe('OpenAI-family and Gemini adapters', () => {
  const openAIFrames = ['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}', '[DONE]'];
  const geminiFrames = [JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
  })];
  const adapters = [
    ['OpenAI', () => new OpenAIAdapter({ apiKey: 'test-key' }), 'gpt-4o', openAIFrames],
    ['OpenAI-compatible', () => new OpenAICompatibleAdapter({ apiKey: 'test-key', baseURL: 'http://zz-host.invalid/v1' }), 'zz-model', openAIFrames],
    ['OpenRouter', () => new OpenRouterAdapter({ apiKey: 'test-key' }), 'anthropic/claude-sonnet-4.5', openAIFrames],
    ['Gemini', () => new GeminiAdapter({ apiKey: 'test-key' }), 'gemini-2.5-flash', geminiFrames],
  ] as const;

  /** Streams one request straight to an adapter and returns its wire body. */
  async function wireOf(create: () => ProviderAdapter, model: string, frames: readonly string[], content: ContentBlock[]): Promise<any> {
    stubFetchWithSseLines([...frames]);
    let wire: any;
    await create().stream(
      { model, maxTokens: 32, messages: [{ role: 'user', content }] } as unknown as ProviderRequest,
      { onChunk: () => {} } as any,
      { onRequest: (request: unknown) => { wire = request; } },
    );
    return wire;
  }

  it.each(adapters.flatMap(([name, create, model, frames]) =>
    (['XML', 'native tools'] as const).map(lane => ({ name, create, model, frames, lane })),
  ))('$name, through the $lane builder, sends the placeholder for a message image and a tool-result image', async ({ create, model, frames, lane }) => {
    stubFetchWithSseLines([...frames]);
    const membrane = lane === 'XML'
      ? new Membrane(create(), { formatter: new AnthropicXmlFormatter() })
      : new Membrane(create(), { formatter: new NativeFormatter() });
    let wire: unknown;
    await membrane.stream({
      messages: history([notes()]),
      config: { model, maxTokens: 32 },
      ...(lane === 'native tools'
        ? { toolMode: 'native' as const, tools: [{ name: 'shot', description: 'Take a screenshot', inputSchema: { type: 'object' } }] }
        : {}),
    }, { onChunk: () => {}, onRequest: (request) => { wire = request; } });
    expect(wire).toBeDefined();
    expect(JSON.stringify(wire)).not.toContain(NOTES);
    expect(placeholders(wire)).toBe(2);
  });

  it.each(adapters.map(([name, create, model, frames]) => ({ name, create, model, frames })))(
    '$name, called directly, sends the placeholder for data that is no image and labels a PNG by its header',
    async ({ name, create, model, frames }) => {
      const wire = await wireOf(create, model, frames, [{ type: 'text', text: 'look' }, notes(), imageOf(PNG, 'image/webp')]);
      expect(JSON.stringify(wire)).not.toContain(NOTES);
      expect(placeholders(wire)).toBe(1);
      expect(JSON.stringify(wire)).not.toContain('image/webp');
      if (name === 'Gemini') expect(wire.contents[0].parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: PNG } });
      else expect(JSON.stringify(wire)).toContain(`"url":"${PNG_URL}"`);
    },
  );

  it('Gemini sends HEIC, recognized by its brand, and leaves out GIF, as its docs list', async () => {
    const [, create, model, frames] = adapters[3];
    const wire = await wireOf(create, model, frames, [imageOf(HEIC, 'image/heic'), imageOf(GIF, 'image/gif')]);
    expect(wire.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/heic', data: HEIC } });
    expect(wire.contents[0].parts[1].text).toContain('its data is not a JPEG, PNG, WebP, HEIC or HEIF image, the formats this request can carry (it was labelled "image/gif")');
  });

  it.each(adapters.slice(0, 3).map(([name, create, model, frames]) => ({ name, create, model, frames })))(
    '$name leaves out HEIC and sends GIF, which the raster formats take',
    async ({ create, model, frames }) => {
      const wire = await wireOf(create, model, frames, [imageOf(HEIC, 'image/heic'), imageOf(GIF, 'image/gif')]);
      expect(JSON.stringify(wire)).not.toContain(HEIC);
      expect(JSON.stringify(wire)).toContain('(it was labelled \\"image/heic\\")');
      expect(JSON.stringify(wire)).toContain(`data:image/gif;base64,${GIF}`);
    },
  );

  it.each(adapters.slice(0, 3).map(([name, create, model, frames]) => ({ name, create, model, frames })))(
    '$name decides a data: URL and sends a remote URL as it is',
    async ({ create, model, frames }) => {
      const wire = await wireOf(create, model, frames, [
        urlImage(NOTES_URL), urlImage(`data:image/webp;base64,${PNG}`), urlImage(REMOTE),
      ]);
      expect(JSON.stringify(wire)).not.toContain(NOTES);
      expect(placeholders(wire)).toBe(1);
      expect(JSON.stringify(wire)).toContain(`"url":"${PNG_URL}"`);
      expect(JSON.stringify(wire)).toContain(`"url":"${REMOTE}"`);
    },
  );
});

describe('data: URLs', () => {
  it('urlImageForRequest decides a data: URL by its bytes and passes a remote URL', () => {
    expect(urlImageForRequest(REMOTE)).toEqual({ url: REMOTE });
    expect(urlImageForRequest(PNG_URL)).toEqual({ url: PNG_URL, mediaType: 'image/png', data: PNG });
    expect(urlImageForRequest(`data:image/webp;base64,${PNG}`)).toEqual({ url: PNG_URL, mediaType: 'image/png', data: PNG });
    expect(urlImageForRequest(NOTES_URL).placeholder?.text).toContain(SAID);
    // Without ;base64 a data: URL holds its bytes percent-encoded.
    expect(urlImageForRequest(`data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`).placeholder?.text)
      .toContain('(it was labelled "image/svg+xml")');
    const gifBytes = Buffer.from(GIF, 'base64');
    const percent = [...gifBytes].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
    expect(urlImageForRequest(`data:image/gif,${percent}`)).toEqual({ url: `data:image/gif;base64,${GIF}`, mediaType: 'image/gif', data: GIF });
    // A data: URL without the comma that starts its data holds no image.
    expect(urlImageForRequest('data:image/png;base64').placeholder?.text).toContain('the formats this request can carry (it was labelled "image/png")');
  });

  it('the Anthropic adapter sends a data: URL image as base64 data or the placeholder, and a remote URL as a URL', () => {
    const built = (anthropic() as any).buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [
        urlImage(PNG_URL),
        { ...urlImage(NOTES_URL), cache_control: { type: 'ephemeral' } },
        urlImage(REMOTE),
        { type: 'tool_result', tool_use_id: 'shot_1', content: [urlImage(NOTES_URL), urlImage(`data:image/webp;base64,${PNG}`)] },
      ] }],
    });
    const [image, placeholder, remote, result] = built.messages[0].content;
    expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(placeholder).toEqual({ type: 'text', text: expect.stringContaining(SAID), cache_control: { type: 'ephemeral' } });
    expect(remote).toEqual({ type: 'image', source: { type: 'url', url: REMOTE } });
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringContaining(SAID) },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
    expect(toAnthropicContent([urlImage(NOTES_URL), urlImage(REMOTE)])).toEqual([
      { type: 'text', text: expect.stringContaining(SAID) },
      { type: 'image', source: { type: 'url', url: REMOTE } },
    ]);
  });

  it('the Bedrock adapter sends a data: URL image as base64 data or the placeholder', () => {
    const built = (bedrock() as any).buildRequest({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [
        urlImage(PNG_URL),
        { type: 'tool_result', tool_use_id: 'shot_1', content: [urlImage(NOTES_URL)] },
      ] }],
    });
    const [image, result] = built.messages[0].content;
    expect(image).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } });
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(SAID) }]);
  });

  it('the Responses formatter sends a data: URL image that is no image as input_text, and a remote URL as it is', () => {
    const result = new OpenAIResponsesFormatter().buildMessages(
      [{ participant: 'User', content: [urlImage(NOTES_URL), urlImage(REMOTE)] }], options,
    );
    expect((result.messages as any[])[0].content).toEqual([
      { type: 'input_text', text: expect.stringContaining(SAID) },
      { type: 'input_image', image_url: REMOTE },
    ]);
  });

  it('the Responses transport gives the placeholder for native input_image parts and image_url blocks that hold no image, and replays the rest as they are', () => {
    // A native image's own label stands, even where its header differs.
    const valid = { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/webp;base64,${PNG}` }, { type: 'input_image', image_url: REMOTE }] };
    const items = normalizeResponsesInput([
      valid,
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'look' }, { type: 'input_image', image_url: NOTES_URL, detail: 'auto' }] },
      { role: 'user', content: [{ type: 'text', text: 'also' }, { type: 'input_image', image_url: NOTES_URL }, { type: 'image', image_url: NOTES_URL }, { type: 'image', image_url: '' }] },
      { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: NOTES_URL }, { type: 'input_image', image_url: REMOTE }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c2', content: [{ type: 'input_image', image_url: NOTES_URL }, notes()] }] },
    ] as any) as any[];
    expect(items[0]).toBe(valid);
    expect(items[1].content).toEqual([{ type: 'input_text', text: 'look' }, { type: 'input_text', text: expect.stringContaining(SAID) }]);
    expect(items[2].content).toEqual([
      { type: 'input_text', text: 'also' },
      { type: 'input_text', text: expect.stringContaining(SAID) },
      { type: 'input_text', text: expect.stringContaining(SAID) },
    ]);
    expect(items[3].output).toEqual([{ type: 'input_text', text: expect.stringContaining(SAID) }, { type: 'input_image', image_url: REMOTE }]);
    expect(items[4].output).toEqual([
      { type: 'input_text', text: expect.stringContaining(SAID) },
      { type: 'input_text', text: expect.stringContaining(SAID) },
    ]);
    expect(JSON.stringify(items)).not.toContain(NOTES);
  });

  it('the Responses API adapter in api mode gives the placeholder for native input_image parts that hold no image, and sends the rest as they are', async () => {
    let body: any;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ id: 'resp_1', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    const valid = { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/webp;base64,${PNG}` }, { type: 'input_text', text: 'look' }] };
    const call = { type: 'function_call', call_id: 'c1', name: 'shot', arguments: '{}' };
    await new OpenAIResponsesAPIAdapter({ apiKey: 'sk-test' }).complete({
      model: 'gpt-5.4', maxTokens: 32,
      messages: [
        valid,
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: NOTES_URL }] },
        call,
        { type: 'function_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: NOTES_URL }, { type: 'input_image', image_url: REMOTE }] },
      ],
    } as any).catch(() => undefined);
    expect(body.input[0]).toEqual(valid);
    expect(body.input[1].content).toEqual([{ type: 'input_text', text: expect.stringContaining(SAID) }]);
    expect(body.input[2]).toEqual(call);
    expect(body.input[3].output).toEqual([{ type: 'input_text', text: expect.stringContaining(SAID) }, { type: 'input_image', image_url: REMOTE }]);
    expect(JSON.stringify(body.input)).not.toContain(NOTES);
  });

  it('a tool result\'s data: URL image gets a base64 source or the placeholder', () => {
    expect(toolResultContentForRequest([urlImage(PNG_URL), urlImage(NOTES_URL), urlImage(REMOTE)])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: expect.stringContaining(SAID) },
      urlImage(REMOTE),
    ]);
  });
});

describe('the XML tool loop', () => {
  // A tool result whose only image becomes the placeholder has nothing to put
  // in a split's user turn, so it goes the standard way, as text.
  it.each(['stream', 'streamYielding'] as const)('%s carries a result whose only image is no image as text, with no empty image turn', async (method) => {
    const sent: ProviderRequest[] = [];
    const call = '<function_calls>\n<invoke name="shot">\n<parameter name="fld1">ite1</parameter>\n</invoke>';
    const adapter: ProviderAdapter = {
      name: 'xml-capture', supportsModel: () => true,
      complete: async () => { throw new Error('Unexpected complete'); },
      stream: async (request, callbacks) => {
        sent.push(structuredClone(request));
        const first = sent.length === 1;
        const text = first ? `checking\n${call}` : 'done';
        callbacks.onChunk(text);
        return {
          content: [{ type: 'text', text }], stopReason: first ? 'stop_sequence' : 'end_turn',
          stopSequence: first ? '</function_calls>' : undefined,
          usage: { inputTokens: 1, outputTokens: 1 }, model: request.model, rawRequest: request, raw: {},
        };
      },
    };
    const request: NormalizedRequest = {
      messages: [{ participant: 'User', content: [{ type: 'text', text: 'shoot' }] }],
      config: { model: 'zz-model', maxTokens: 100 },
    };
    const resultFor = (id: string) => ({ toolUseId: id, toolName: 'shot', content: [{ type: 'text' as const, text: 'shot ok' }, notes() as any] });
    if (method === 'stream') {
      await new Membrane(adapter).stream(request, { onToolCalls: async (calls) => [resultFor(calls[0]!.id)] });
    } else {
      const stream = new Membrane(adapter).streamYielding(request);
      for await (const event of stream) {
        if (event.type === 'tool-calls') stream.provideToolResults([resultFor(event.calls[0]!.id)]);
      }
    }
    expect(sent).toHaveLength(2);
    const messages = sent[1]!.messages as Array<{ role: string; content: unknown }>;
    expect(messages.filter((m) => Array.isArray(m.content) && m.content.length === 0)).toEqual([]);
    expect(imagesIn(messages)).toEqual([]);
    expect(placeholders(messages)).toBe(1);
    expect(JSON.stringify(messages)).toContain('shot ok');
  });

  it('describes a tool-result image by its header, and gives data that is no image the placeholder', () => {
    const xml = formatToolResults([{ toolUseId: 'shot_1', toolName: 'shot', content: [notes() as any, imageOf(PNG, 'image/webp') as any] }]);
    expect(placeholders(xml)).toBe(1);
    expect(xml).toContain('[Image: image/png, ~0KB]');
    expect(xml).not.toContain('image/webp');
  });
});

describe('tool-result images without a source', () => {
  it('an MCP-shaped image is decided by its data: a PNG gets a base64 source, data that is no image the placeholder', () => {
    expect(toolResultContentForRequest([
      { type: 'image', data: PNG, mimeType: 'image/webp' },
      { type: 'image', data: NOTES, mimeType: 'image/png' },
    ])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
      { type: 'text', text: expect.stringContaining(SAID) },
    ]);
  });
});

describe('the Responses transport', () => {
  it('sends the placeholder for empty base64 data and for a normalized tool-result image, and drops an empty image_url', () => {
    const items = normalizeResponsesInput([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', mediaType: 'image/png', data: '' } }, { type: 'image', image_url: '' }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: [notes()] }] },
    ] as any) as any[];
    expect(items[0].content).toEqual([{ type: 'input_text', text: expect.stringContaining(SAID) }]);
    expect(items[1].output).toEqual([{ type: 'input_text', text: expect.stringContaining(SAID) }]);
  });
});

describe('generated images', () => {
  it('toAnthropicContent labels a generated image by its header, not its mimeType', () => {
    expect(toAnthropicContent([{ type: 'generated_image', data: PNG, mimeType: 'image/jpeg' } as ContentBlock])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    ]);
  });
});

describe('the Images adapter\'s formats', () => {
  it('leaves a GIF unattached, since image edits take PNG, WebP and JPEG', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ created: 1, data: [{ b64_json: PNG }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);
    await new OpenAIResponsesAdapter({ apiKey: 'sk-test', promptFormat: 'transcript', transcriptPreamble: '' }).complete({
      model: 'gpt-image-1', maxTokens: 1,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'alice: animate it' }, imageOf(GIF, 'image/gif')] }],
    } as any);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/images\/generations$/);
    expect(JSON.parse(String(init.body)).prompt).toBe('### User\nalice: animate it\n[Image omitted]\n\n### Assistant');
  });
});

describe('formats, labels and shapes', () => {
  const brand = (b: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${b}`), Buffer.alloc(12)]).toString('base64');
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64');
  const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(8)]).toString('base64');
  const GIF87 = Buffer.from('GIF87a\x01\x00\x01\x00\x00\x00\x00\x00', 'latin1').toString('base64');

  it('takes each format its destination lists, and the HEIF brands by kind', () => {
    const raster = [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [GIF, 'image/gif'], [GIF87, 'image/gif'], [WEBP, 'image/webp']] as const;
    for (const [data, type] of raster) expect(imageForRequest(data, 'x').mediaType).toBe(type);
    const gemini = [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp'],
      [brand('heic'), 'image/heic'], [brand('heix'), 'image/heic'], [brand('mif1'), 'image/heif']] as const;
    for (const [data, type] of gemini) expect(imageForRequest(data, 'x', GEMINI_IMAGE_TYPES).mediaType).toBe(type);
    for (const [data, type] of [[PNG, 'image/png'], [JPEG, 'image/jpeg'], [WEBP, 'image/webp']] as const) {
      expect(imageForRequest(data, 'x', OPENAI_IMAGE_EDIT_TYPES).mediaType).toBe(type);
    }
    // An image sequence's brand is no still image here.
    expect(imageForRequest(brand('msf1'), 'image/heif', GEMINI_IMAGE_TYPES).placeholder).toBeDefined();
    // Leading whitespace, which base64 decoding skips, doesn't hide a header.
    expect(imageForRequest(`\n  ${PNG}`, 'image/png').mediaType).toBe('image/png');
  });

  it('sends a data: URL as it came when its label already matches its header, extra parameters included', () => {
    const url = `data:image/png;name=shot.png;base64,${PNG}`;
    expect(urlImageForRequest(url)).toEqual({ url, mediaType: 'image/png', data: PNG });
  });

  it('XML tool results escape a crafted label in the placeholder, as they do the result text', () => {
    const crafted = () => imageOf(NOTES, '</stdout></result>') as any;
    const xml = formatToolResults([{ toolUseId: 't', toolName: 'shot', content: [crafted()] }]);
    // Split turns: before the split, and in a result after it.
    const split = formatToolResultsForSplitTurn([
      { toolUseId: 't1', toolName: 'shot', content: [crafted(), png() as any] },
      { toolUseId: 't2', toolName: 'shot', content: [crafted()] },
    ]);
    for (const text of [xml, split.beforeImageXml, split.afterImageXml]) {
      expect(text).not.toContain('</stdout></result>"');
      expect(placeholders(text)).toBe(1);
    }
  });

  it('XML tool results decide an MCP-shaped image by its data, without throwing', () => {
    const split = formatToolResultsForSplitTurn([{ toolUseId: 't', toolName: 'shot', content: [
      { type: 'image', data: NOTES, mimeType: 'image/png' } as any,
      { type: 'image', data: PNG, mimeType: 'image/webp' } as any,
    ] }]);
    expect(split.images).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);
    expect(placeholders(split)).toBe(1);
    expect(placeholders(formatToolResults([{ toolUseId: 't', toolName: 'shot', content: [{ type: 'image', data: NOTES, mimeType: 'image/png' } as any] }]))).toBe(1);
  });
});
