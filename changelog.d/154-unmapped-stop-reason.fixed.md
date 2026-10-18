- A `stopReason` that membrane doesn't map (one other than `end_turn`,
  `max_tokens`, `stop_sequence`, `tool_use`, `pause_turn` and `refusal`),
  returned by an adapter without `providerStopReason`, is now kept as
  `details.stop.providerReason` (#154), also when membrane then ends the
  response at a stop sequence it finds itself. Membrane still normalizes the
  token to `end_turn` and logs it once, but the token was dropped, so a
  custom adapter's `stopReason: 'error'` read as a clean end of turn to a
  caller that checks `providerReason`. When the adapter gives a
  `providerStopReason`, `providerReason` still carries that, and a
  `stopReason` membrane maps, returned alone, still leaves `providerReason`
  unset.
  - A `providerStopReason` that isn't a non-empty string, such as `null` or
    `''`, now counts as none: the field is a string, omitted when no reason
    was reported. It was reported as `providerReason` as it came, so where a
    built-in adapter passes on a server's empty stop token, `providerReason`
    is now unset. An empty or non-string `stopReason` isn't carried either.
  - Otherwise the built-in adapters' responses don't change: they return
    `providerStopReason` beside any token membrane doesn't map.
