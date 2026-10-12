/**
 * Anthropic server-tool blocks: the content blocks the Messages API returns
 * in an assistant turn for a tool it runs itself (web search, web fetch, code
 * execution, tool search, the MCP connector) and for a file it puts in the
 * code-execution container. Membrane has no normalized ContentBlock for them,
 * so response parsing keeps each one verbatim on a zero-width carrier,
 * `{ type: 'text', text: '', rawItem: <the block> }`.
 *
 * They are part of the turn as the model produced it. When signed thinking
 * sits in the same turn, the API refuses the turn with the blocks left out
 * ("thinking ... blocks in the latest assistant message cannot be modified"),
 * and a model replayed without its search results no longer has them. So
 * Membrane sends each one back in its carrier's place, in the assistant turn
 * that produced it, through an adapter that declares
 * replaysAnthropicServerBlocks (AnthropicAdapter). Its other builds, Bedrock's
 * included, and request shapes for other wires leave it out.
 */

/**
 * The response block types for server tools that membrane has no normalized
 * block for, as the Anthropic SDK publishes them (0.115.0): its `ContentBlock`
 * union's server blocks, and the MCP connector's two, from its beta types.
 * This package builds against an older SDK whose stable union has only the
 * first two.
 */
export const ANTHROPIC_SERVER_BLOCK_TYPES: ReadonlySet<string> = new Set([
  'server_tool_use',
  'web_search_tool_result',
  'web_fetch_tool_result',
  'code_execution_tool_result',
  'bash_code_execution_tool_result',
  'text_editor_code_execution_tool_result',
  'tool_search_tool_result',
  'container_upload',
  'mcp_tool_use',
  'mcp_tool_result',
]);

/** A block whose `type` is one of {@link ANTHROPIC_SERVER_BLOCK_TYPES}, as the API sent it. */
export type AnthropicServerBlock = { type: string } & Record<string, unknown>;

/** An object whose `type` is one of {@link ANTHROPIC_SERVER_BLOCK_TYPES}. */
export function isAnthropicServerBlock(item: unknown): item is AnthropicServerBlock {
  return (
    item !== null &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    ANTHROPIC_SERVER_BLOCK_TYPES.has((item as { type?: unknown }).type as string)
  );
}

/**
 * The Anthropic server-tool block that `block` is, or that it carries as a
 * zero-width carrier; undefined for every other block, including a carrier
 * holding another provider's item.
 */
function serverBlockOf(block: unknown): AnthropicServerBlock | undefined {
  if (isAnthropicServerBlock(block)) return block;
  if (block === null || typeof block !== 'object') return undefined;
  const carrier = block as { type?: unknown; text?: unknown; rawItem?: unknown };
  if (carrier.type !== 'text' || carrier.text !== '') return undefined;
  return isAnthropicServerBlock(carrier.rawItem) ? carrier.rawItem : undefined;
}

/** True for an Anthropic server-tool block, or a zero-width carrier holding one. */
export function carriesAnthropicServerBlock(block: unknown): boolean {
  return serverBlockOf(block) !== undefined;
}

/**
 * What an Anthropic-shaped request sends for `block` when it is an Anthropic
 * server-tool block, or a zero-width carrier holding one: a copy of that
 * block, without any `cache_control` stored on it or on its carrier. A
 * marker is the request's own, placed by the builder, so a stale one kept in
 * history isn't sent and doesn't count toward the four-marker limit, as it
 * never did while carriers were dropped. Because it's a copy, a breakpoint
 * the builder places marks it and never the stored item. Undefined for every
 * other block.
 */
export function anthropicServerBlockFor(block: unknown): AnthropicServerBlock | undefined {
  const item = serverBlockOf(block);
  if (item === undefined) return undefined;
  const { cache_control: _stored, ...sent } = item;
  return sent as AnthropicServerBlock;
}

/**
 * A zero-width carrier: empty text holding an object `rawItem`, a provider
 * item with no normalized form. It has no text, so a text serialization of a
 * turn leaves it out rather than writing an empty part.
 */
export function isZeroWidthCarrier(block: { type?: unknown; text?: unknown; rawItem?: unknown }): boolean {
  return block.type === 'text' && block.text === '' && block.rawItem !== null && typeof block.rawItem === 'object';
}
