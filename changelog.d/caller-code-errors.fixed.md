- An error from the caller's own code that membrane runs beside a call is no
  longer resent (#160). That code is the `beforeRequest`, `afterResponse`,
  `onError` and `onNormalize` hooks, `onRequest`, `onResponse` and
  `stream()`'s callbacks, a request's `onCacheWireReceipt`, the Anthropic
  adapter's `dynamicHeaders`, the configured logger's `warn()` and a
  registry's `getPricing()`, and a resend of the request can't mend it. The
  call now ends at once with a `MembraneError` whose `retryable` is `false`:
  the caller's own if it already said so, or else a new one classified from
  its error as before, with that error as its `cause` and no `httpStatus`,
  `providerErrorCode` or `retryAfterMs`, since no response to this call
  stands behind them, nor a wrapped `MembraneError`'s `rawError` or
  `rawRequest`, which would be another call's. What builds, sends or reads
  the call keeps its classification: an adapter and the transport, a
  credential resolver, a formatter and its parser. Before:
  - An error that read like a rate limit made `complete()` send the request
    up to five times when it came from `onResponse`, `afterResponse`, the
    logger or the registry, paying again for a response that had already
    arrived.
  - Thrown before the send, it made `complete()` and `stream()` run the hook
    or callback again on each attempt.
  - Thrown after `stream()` had emitted, it ended the call but still said
    `retryable: true`, and what the `onError` hook threw left as it was.
    Either way, a caller's policy could resend the request.
- **Stream callbacks:** a stream callback's error ends the call once it
  reaches membrane. The OpenAI, OpenAI-compatible, OpenAI-completions,
  OpenRouter and Bedrock adapters' stream handlers still catch it and go on.
  An error the caller's code throws named `AbortError` keeps the type
  `abort`, so membrane treats it as any other abort thrown at the same
  point, as it did before.
- **`streamYielding()` consumers:** an error the caller's code throws, such
  as a `beforeRequest` hook's or an `onCacheWireReceipt` consumer's, now
  reaches the `error` event as that `MembraneError`, where it used to be the
  caller's own error. The caller's error is its `cause`, unless it was a
  `MembraneError` that already said `retryable: false` and arrives as itself.
- **Anthropic adapter:** `dynamicHeaders` now runs before the keepalive
  records the request, so a request it fails isn't replayed later.
- **Responses adapter, subscription mode:** an `onFastModeFallback` that
  throws is now logged with `console.warn`, and the response stands. Its
  error used to trigger a second request, which didn't call it again, so the
  error was lost.
