- A round the provider ends with a literal `stop_reason: end_turn` while its
  content holds complete client tool calls now runs as a
  `tool_use` round on both native tool loops (`stream()` with `onToolCalls`,
  and `streamYielding()`), and `complete()` returns it as a `tool_use` stop.
  Before, every native loop gated execution on `tool_use` alone, so the
  calls never ran and the turn ended as if finished, with nothing logged;
  production Anthropic responses had this shape on 2026-10-19. A call is
  complete when its block stopped and its input parsed to an object (no
  `unparseableInput`); a round holding an incomplete call runs nothing, as
  before. A length, refusal, stop-sequence or pause stop never qualifies,
  nor does a provider token membrane doesn't map, nor a round with no
  provider stop token at all (an adapter that reports none, or an
  OpenAI-family server that sends no `finish_reason`): those run nothing, as
  before. Each occurrence warns
  once, through the configured `logger` when one is set, with the model, the
  tool names and the message and request ids, and is recorded in the new
  `details.anomalies` (`ToolUseWithEndTurnAnomaly`: `kind:
  'tool_use_with_end_turn'`, `round`, `providerStopReason`, `toolNames`,
  `toolUseIds`, `treatedAsToolUse`, `model`, `messageId`, `requestId`),
  which keeps the round's own stop token. `details.stop` describes the
  response's final round. The Anthropic and Bedrock stream adapters now hold
  block events to the API's order: a start while no block is open, at the
  next index (in Bedrock a start above it leaves the slot it skips empty,
  which fails the call as a lost block, as before, and a later start in that
  slot now breaks order instead of filling it), then that block's deltas, a
  tool call's being only its arguments, and its stop. The first event out of
  that order (such as a block left open when the next one starts, a late
  stop or delta, a second start for an index, or a text delta in a tool
  call) means the stream can't vouch for which call any arguments belong to:
  no later block event is applied, a block still open is finalized as cut
  off, and every `tool_use` block in the response is marked
  (`unparseableInput`; one not already marked also gets `input` `{}`), so
  the gate runs none of them on an `end_turn` round, and on a `tool_use`
  round the caller gets them marked. Each adapter warns once, and the
  Anthropic adapter keeps those events in `raw.provider_events.unhandled`.
  Bedrock now stops reading at `message_delta`, as the Anthropic adapter
  does, so a call still open there is marked as cut off in both, and nothing
  after it is read: before, a later block event was applied, a second
  `message_delta` set the stop reason again, and an error event failed the
  call. In the Anthropic adapter the marking leaves server tool calls as
  they streamed, since they ran on the API's side: one that stopped keeps
  its input. Bedrock's response carries no server tool blocks, as before.
  Citations are the exception to "not applied": the SDK appends each one to
  the `citations` array a text block's start carried, which the adapter's
  block shares, so one still lands there when the start carried an array. A
  stream that ends with a block open, as a `max_tokens` cut does, is in
  order, as before.
