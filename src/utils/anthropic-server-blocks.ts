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

import type { ContentBlock } from '../types/content.js';
import { isRawItemCarrier } from './fidelity.js';

/**
 * The response block types for server tools that membrane has no normalized
 * block for, as the Anthropic SDK 0.115.0 publishes them: its `ContentBlock`
 * union's server blocks, and the MCP connector's two, from its beta types.
 * The SDK this package builds against, 0.52.0, defines six of them (the first
 * two in its stable types; code execution's result, `container_upload` and
 * the MCP connector's two in its beta types); the other four are 0.115.0's.
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
  const item = isAnthropicServerBlock(block)
    ? block
    : block !== null && typeof block === 'object' && isRawItemCarrier(block as ContentBlock)
      ? (block as { rawItem?: unknown }).rawItem
      : undefined;
  return isAnthropicServerBlock(item) ? item : undefined;
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
 * the builder places marks it and never the stored item. A server call whose
 * streamed input didn't arrive whole carries `unparseableInput` (the
 * Anthropic adapter marks it, as it marks a tool_use); it goes out as stored,
 * with the start's input, as a marked tool_use does, and without the marker,
 * which is membrane's record, not the API's field. Undefined for every other
 * block.
 */
export function anthropicServerBlockFor(block: unknown): AnthropicServerBlock | undefined {
  const item = serverBlockOf(block);
  if (item === undefined) return undefined;
  const { cache_control: _stored, unparseableInput: _marker, ...sent } = item;
  return sent as AnthropicServerBlock;
}
