- `streamYielding()` now retries a provider call that fails with a 529 overload
  or a 429 rate limit before it has delivered anything, on the native and XML
  paths, as `stream()` does: the `overloaded` schedule for a 529, the base
  schedule with its five-attempt floor for a 429. Before, it had no retry at
  all, and the first 529 ended the turn (#118). A call that has delivered
  anything is still not retried, since that would replay what the caller
  already has.
- `stream()` and `streamYielding()` retry such a call in any round of a tool
  loop. `stream()` used to retry only until anything had been emitted, so a 529
  on the call after a tool round ended the turn. The retry now happens inside
  each provider call, so the `beforeRequest` hook and the cache wire receipt
  run once for the round, as they do for a refusal re-issue, and a cancellation
  during a later round's wait returns an `AbortedResponse` with what the
  earlier rounds delivered.
- On `complete()`, a refusal re-issue (`refusalRetries`) no longer spends the
  retry budget for transport errors: after a re-issue, a 529 or 429 gets the
  whole schedule again, as it does on the streaming paths.
