- An error the caller's own code throws is no longer resent (#160). That's
  the code membrane runs that observes or shapes a request or a response:
  the `beforeRequest`, `afterResponse`, `onError` and `onNormalize` hooks,
  `onRequest`, `onResponse` and `stream()`'s callbacks, a request's
  `onCacheWireReceipt`, and the Anthropic adapter's `dynamicHeaders`. The
  call now ends at once with a `MembraneError` whose `retryable` is `false`:
  the one the caller's code threw if it was a `MembraneError`, or else one
  classified from its error as before, with that error as its `cause`. A
  provider's or transport's error keeps its classification, before and after
  the caller's code runs, and so does a credential resolver's. Before:
  - An error that read like a rate limit made `complete()` send the request
    up to five times, paying again for a response that had already arrived
    when it came from `onResponse` or `afterResponse`.
  - Thrown before the send, it made `complete()` and `stream()` run the hook
    or callback again on each attempt.
  - Thrown after `stream()` had emitted, it ended the call but still said
    `retryable: true`, and what the `onError` hook threw left as it was.
    Either way, a caller's policy could resend the request.
- **`streamYielding()` consumers:** an error the caller's code throws, such
  as a `beforeRequest` hook's or an `onCacheWireReceipt` consumer's, now
  reaches the `error` event as that `MembraneError`, where it used to be the
  caller's own error. The caller's error is its `cause`.
- **Responses adapter, subscription mode:** an `onFastModeFallback` that
  throws is now logged with `console.warn`, and the response stands. Its
  error used to trigger a second request, which didn't call it again, so the
  error was lost.
