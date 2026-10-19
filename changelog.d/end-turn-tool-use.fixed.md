- A round the provider ends with `stop_reason: end_turn`, or with no stop
  reason (as an OpenAI-family server that sends no `finish_reason` does),
  while its content holds complete client tool calls now runs as a
  `tool_use` round on both native tool loops (`stream()` with `onToolCalls`,
  and `streamYielding()`), and `complete()` returns it as a `tool_use` stop.
  Before, every native loop gated execution on `tool_use` alone, so the
  calls never ran and the turn ended as if finished, with nothing logged;
  production Anthropic responses had this shape on 2026-10-19. A call is
  complete when its block stopped and its input parsed to an object (no
  `unparseableInput`); a round holding an incomplete call runs nothing, as
  before. A length, refusal, stop-sequence or pause stop never qualifies,
  nor does a provider token membrane doesn't map. Each occurrence warns
  once, through the configured `logger` when one is set, with the model, the
  tool names and the message and request ids, and is recorded in the new
  `details.anomalies` (`ToolUseWithEndTurnAnomaly`: `kind:
  'tool_use_with_end_turn'`, `round`, `providerStopReason`, `toolNames`,
  `toolUseIds`, `treatedAsToolUse`, `model`, `messageId`, `requestId`),
  which keeps the round's own stop token. `details.stop` describes the
  response's final round. The Anthropic and Bedrock stream adapters now hold
  block events to the API's order: a start while no block is open, for an
  index not used yet, then that block's deltas and its stop. The first event
  out of that order (such as a block left open when the next one starts, a
  late stop or delta, or a second start for an index) means the stream can't
  vouch for which call any arguments belong to: no later block event is
  applied, a block still open is finalized as cut off, and every `tool_use`
  block in the response is marked (`unparseableInput`; one not already
  marked also gets `input` `{}`), so the gate runs none of them on an
  `end_turn` round, and on a `tool_use` round the caller gets them marked.
  Each adapter warns once, and the Anthropic adapter keeps those events in
  `raw.provider_events.unhandled`. The marking leaves server tool calls as
  they streamed, since they ran on the API's side: one that stopped keeps
  its input. Citations are the exception to "not applied": the SDK appends
  each one to the `citations` array a text block's start carried, which the
  adapter's block shares, so one still lands there. A stream that ends with
  a block open, as a `max_tokens` cut does, is in order, as before.
