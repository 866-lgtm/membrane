- Membrane is now the one layer that retries. `AnthropicAdapter`'s SDK client
  makes one attempt at each request membrane makes. Its own retries are off:
  two by default, inside each of membrane's attempts, on a 408, 409, 429 or
  5xx response and on a connection failure. So with `retry: false` membrane
  retries none of a call's failed requests: a failure reaches the caller
  after one attempt at the request that failed, inside which a credential
  resolver may resend once after a 401. A completed response's
  `details.timing.attempts` and `retryDelaysMs` count every attempt and every
  wait, none of them hidden inside the SDK. The keepalive's replays keep the
  SDK's default.
- What the SDK retried before delivery, membrane now retries on every adapter
  and entry point (see Breaking for the new default of `retry.maxRetries`). A
  409, which the SDK also retried, stays non-retryable unless the API's
  `x-should-retry` says otherwise: Anthropic's Messages API doesn't document
  it. With `overloaded.maxRetries: 0`, a 529 follows the base policy on every
  path; before, it wasn't retried on the streaming paths.
- A deadline that runs out on a request already sent isn't retried. The call
  still ends with a retryable `timeout`, which the caller may retry, but
  membrane doesn't spend another full deadline on it. That covers
  `AnthropicAdapter`'s idle and first-event watchdogs, the runtime's own
  fetch deadlines on the other adapters (undici's headers and body timeouts,
  300 s each by default; Bun's fetch timeout), and every timeout
  `AnthropicAdapter`'s SDK client reports, a connect timeout included (see
  Breaking). On the other adapters, on Node, a connect timeout
  (`UND_ERR_CONNECT_TIMEOUT`, `ETIMEDOUT`) is retried like any connection
  failure. Bun's fetch timeout doesn't say which stage ran out, so on Bun a
  stalled connect is left to the caller too.
- `AnthropicAdapter` reads the API's `x-should-retry` (it decides whether the
  error is retryable) and `retry-after-ms` (before `retry-after`), as the SDK
  did.
