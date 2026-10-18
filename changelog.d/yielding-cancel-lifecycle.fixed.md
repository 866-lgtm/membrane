- A cancelled `streamYielding()` stream now ends at its `aborted` event, as
  `cancel()`'s documentation says: no event of any kind follows it. A loop
  that resumed because a wait had already resolved, from results passed to
  `provideToolResults()` just before the cancel or a provider response that
  crossed the abort, could deliver `block`, `tokens`, `usage`, `tool-calls`
  or a late `complete` after it. Its next tool wait is now refused at once, so
  the loop finishes instead of waiting for results that will never come. A
  round whose response arrives after the cancel isn't reported, its usage
  included. A `cancel()` that comes after the stream has queued its own
  `complete`, `error` or `aborted` adds no event, and that event stays the
  stream's last.
