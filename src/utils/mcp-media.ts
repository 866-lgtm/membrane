/**
 * Media in MCP's form, converted to membrane's.
 *
 * An MCP tool result carries an image or audio clip with its bytes on the
 * block itself: `{ type: 'image', data, mimeType }`. Membrane's media blocks
 * (`ImageContent`, `DocumentContent`, `AudioContent`, `VideoContent`) carry
 * them in `source`: `{ type: 'base64', data, mediaType }`. A host that stores
 * MCP results without converting them hands membrane the first form, and the
 * request builders read the second: at the top of a message the formatters
 * threw on the first. So membrane converts wherever it takes content, and
 * every request builder after that point reads one form:
 * `Membrane`'s request build (`transformRequest`, which every path's messages
 * go through, the native tool loop's each round); the public `buildMessages`
 * of the anthropic-xml, native and Responses formatters, for a caller that
 * builds messages directly; each adapter's request built directly that reads
 * membrane's content blocks (Anthropic, Bedrock, OpenAI, OpenAI-compatible,
 * OpenRouter, Gemini, the OpenAI image adapter, and the Responses adapter in
 * subscription mode, whose API mode takes native items as they are); and the
 * exported converters `toAnthropicContent` and `transformToChat`. The
 * completions formatter and adapter read no image data, so they don't
 * convert. The xml
 * document's tool results (`formatToolResults` and
 * `formatToolResultsForSplitTurn`, which take an xml tool loop's results each
 * round) read their images through `toolResultImage`, which takes MCP's form
 * by its data, so they need no conversion. Three carry the
 * caller's form instead: the caller's request a `beforeRequest` hook is
 * handed beside the provider's, which is built from converted content; a
 * continuation's `normalizedMessages`, which no adapter reads for media,
 * since a continuation carries its prompt; and the native loop's prompt
 * messages, which the completions serializer reads for text.
 *
 * The rule: a media block (image, document, audio or video) with no `source`
 * object, carrying MCP's `data` or `mimeType`, becomes
 * `{ ...rest, source: { type: 'base64', data, mediaType } }`,
 * keeping its other fields, its `mimeType` as the `mediaType` where that's a
 * string that isn't empty. MCP's `annotations` and `_meta` are protocol
 * metadata, which no request has a place for and an API that rejects extra
 * inputs refuses, so they don't go with it. An image converts whatever its
 * data and label: every request builder that sends an image decides its data
 * through imageForRequest, which sends what the data's header shows,
 * whatever label it came with, and notes data that is missing, empty or no
 * image it can carry. `transformToChat`, which hands its content back rather
 * than sending it, passes an image's data on as it is, in either form.
 * Nothing decides a document, audio or video that way, since their builders
 * send the source as it is, so one of those converts only with data that
 * isn't empty and a `mimeType`. One that doesn't is left as it is, and the
 * readers membrane runs after the conversion treat it as a source they can't
 * represent.
 */

const MEDIA_TYPES: ReadonlySet<unknown> = new Set(['image', 'document', 'audio', 'video']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `items` with every media block in MCP's form converted to membrane's. An
 * item is a content block, or anything that holds blocks in a `content` array
 * (a message, a `tool_result`, a `ToolResult`), which is converted at any
 * depth.
 *
 * Copies, not edits: an array holding nothing to convert comes back as the
 * same array, and one that does comes back as a new array, with a new object
 * for each converted block and for each item on the way to one. The objects
 * handed in are never changed, so a caller's request stays as it was.
 */
export function convertMcpMedia<T>(items: T[]): T[] {
  let out: T[] | undefined;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const converted = convertedItem(item);
    if (converted !== item) (out ??= items.slice())[i] = converted as T;
  }
  return out ?? items;
}

/** A media block (image, document, audio or video) with no `source` object:
 *  MCP's form that didn't convert, or media without its source in any form.
 *  No request has a form for it. */
export function isSourcelessMedia(block: unknown): boolean {
  return isRecord(block) && MEDIA_TYPES.has(block.type) && !isRecord(block.source);
}

/**
 * For a builder that reports blocks from inside a reader it hands converted
 * messages: the caller's block at the place in `messages` where `converted`
 * (convertMcpMedia's result for them) holds `block`, or `block` itself where
 * nothing converted. So a report names what the caller handed in, as one
 * about the same media in membrane's form would. The blocks such a reader
 * reports: a message's content blocks, and an item given at the top level,
 * such as a standalone `tool_result`, which it reports itself.
 */
export function blockHandedIn(messages: unknown[], converted: unknown[]): (block: unknown) => unknown {
  const handedIn = new Map<unknown, unknown>();
  converted.forEach((message, i) => {
    const before = messages[i];
    if (message === before || !isRecord(message) || !isRecord(before)) return;
    handedIn.set(message, before);
    if (!Array.isArray(message.content) || !Array.isArray(before.content)) return;
    const original = before.content;
    message.content.forEach((block, j) => {
      if (block !== original[j]) handedIn.set(block, original[j]);
    });
  });
  return (block) => (handedIn.has(block) ? handedIn.get(block) : block);
}

function convertedItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (Array.isArray(item.content)) {
    const content = convertMcpMedia(item.content);
    return content === item.content ? item : { ...item, content };
  }
  if (!MEDIA_TYPES.has(item.type) || isRecord(item.source)) return item;
  // MCP's form carries its media in `data` and `mimeType`. A block with
  // neither is someone else's shape, such as an image given by `image_url`,
  // which the Responses normalizer reads, and goes to the readers as it came.
  if (!('data' in item) && !('mimeType' in item)) return item;
  const { data, mimeType, annotations: _annotations, _meta, ...rest } = item;
  const mediaType = typeof mimeType === 'string' && mimeType !== '' ? mimeType : undefined;
  // imageForRequest decides an image's data wherever a request carries it;
  // other media go with their source as it is.
  if (item.type !== 'image' && (typeof data !== 'string' || data === '' || mediaType === undefined)) return item;
  return { ...rest, source: { type: 'base64', data, ...(mediaType === undefined ? {} : { mediaType }) } };
}
