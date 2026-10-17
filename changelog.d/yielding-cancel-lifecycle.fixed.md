- A cancelled `streamYielding()` stream now ends at its `aborted` event, as
  `cancel()`'s documentation says. A loop that resumed because a wait had
  already resolved, from results passed to `provideToolResults()` just before
  the cancel or a provider response that crossed the abort, no longer delivers
  `block`, `tokens` or `tool-calls` events after it. Its next tool wait is
  refused at once, so the loop finishes instead of waiting for results that
  will never come. A `cancel()` that comes after the stream has queued its own
  `complete`, `error` or `aborted` no longer adds a second terminal event.
