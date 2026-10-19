- A round the provider ends with `stop_reason: end_turn`, or with no stop
  reason, while its content holds complete client tool calls now runs as a
  `tool_use` round on both native tool loops (`stream()` with `onToolCalls`,
  and `streamYielding()`), and `complete()` returns it as a `tool_use` stop.
  Before, every native loop gated execution on `tool_use` alone, so the
  calls never ran and the turn ended as if finished, with nothing logged;
  production Anthropic responses had this shape on 2026-10-19. A call is
  complete when its block stopped and its input parsed to an object (no
  `unparseableInput`); a round holding an incomplete call runs nothing, as
  before. A length, refusal, stop-sequence or pause stop never qualifies,
  nor does a provider token membrane doesn't map. Each occurrence warns once,
  with the model, the tool names and the message and request ids, and is
  recorded in the new `details.anomalies` (`ToolUseWithEndTurnAnomaly`:
  `kind: 'tool_use_with_end_turn'`, `round`, `providerStopReason`,
  `toolNames`, `toolUseIds`, `treatedAsToolUse`, `model`, `messageId`,
  `requestId`). `details.stop.providerReason` keeps the provider's own
  `end_turn`.
