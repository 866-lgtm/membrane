- A `stopReason` that membrane doesn't map (one other than `end_turn`,
  `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn` and `refusal`),
  returned by an adapter without `providerStopReason`, is now kept as
  `details.stop.providerReason` (#154). Membrane still normalizes it to
  `end_turn` and logs it once, but the token was dropped, so a custom
  adapter's `stopReason: 'error'` read as a clean end of turn to a caller
  that checks `providerReason`. When the adapter gives a `providerStopReason`,
  `providerReason` still carries that, and a `stopReason` membrane maps,
  returned alone, still leaves `providerReason` unset. Built-in adapters
  return `providerStopReason` beside any token membrane doesn't map, so their
  responses don't change.
