/**
 * Media in MCP's form, converted to membrane's.
 *
 * An MCP tool result carries an image or audio clip with its bytes on the
 * block itself: `{ type: 'image', data, mimeType }`. Membrane's media blocks
 * (`ImageContent`, `DocumentContent`, `AudioContent`, `VideoContent`) carry
 * them in `source`: `{ type: 'base64', data, mediaType }`. A host that stores
 * MCP results without converting them hands membrane the first form, and the
 * request builders read the second: at the top of a message the formatters
 * threw on the first. So membrane converts where content enters it, and
 * every request builder after that point reads one form:
 * `Membrane`'s request build (`transformRequest`, which every path's messages
 * go through, the native tool loop's each round), the xml document's tool
 * results (`formatToolResults` and `formatToolResultsForSplitTurn`, which take
 * an xml tool loop's results each round), and the Anthropic adapter's request
 * sanitizer, for a caller that builds a request directly. Three carry the
 * caller's form instead: the caller's request a `beforeRequest` hook is
 * handed beside the provider's, which is built from converted content; a
 * continuation's `normalizedMessages`, which no adapter reads for media,
 * since a continuation carries its prompt; and the native loop's prompt
 * messages, which the completions serializer reads for text.
 *
 * The rule: a media block (image, document, audio or video) with no `source`
 * object whose `data` is a string that isn't empty and whose `mimeType` is a
 * string becomes
 * `{ ...rest, source: { type: 'base64', data, mediaType: mimeType } }`,
 * keeping its other fields. An image converts without a `mimeType` too, with
 * no `mediaType` in its source: every request decides an image by its data's
 * header, whatever label it came with (imageForRequest). Nothing decides a
 * document, audio or video that way, so one of those without a `mimeType`
 * stays as it is. Empty data stays as it is too, since the API refuses an
 * image whose data is empty, so a block with no data to send gets each
 * reader's note instead. A media block without a `source` object that
 * doesn't fit is left as it is, and each reader treats it as a source it
 * can't represent.
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

function convertedItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (Array.isArray(item.content)) {
    const content = convertMcpMedia(item.content);
    return content === item.content ? item : { ...item, content };
  }
  if (!MEDIA_TYPES.has(item.type) || isRecord(item.source)) return item;
  const { data, mimeType, ...rest } = item;
  if (typeof data !== 'string' || data === '') return item;
  if (typeof mimeType === 'string') return { ...rest, source: { type: 'base64', data, mediaType: mimeType } };
  // An image's header decides it wherever a request carries it; nothing
  // decides other media that way.
  return item.type === 'image' ? { ...rest, source: { type: 'base64', data } } : item;
}
