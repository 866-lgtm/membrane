- Membrane is now the one layer that retries. `AnthropicAdapter`'s SDK client
  sends each request membrane makes once. Its own retries are off: two by
  default, inside each of membrane's attempts, on a 408, 409, 429 or 5xx
  response and on a connection failure. So a 429 left to the caller arrives
  after one send, and `attempts`, `backoff` and `retryDelaysMs` count every
  send. The keepalive's replays keep the SDK's default.
- What the SDK retried before delivery, membrane now retries on every adapter
  and entry point. A 5xx, a provider's 408 and a connection failure get
  `retry.maxRetries` attempts on the base schedule. **`retry.maxRetries` now
  defaults to 5 (it was 0)**, with waits of 1, 2, 4 and 8 seconds. Set it to 1
  if a retry layer of your own should be the only one. A 409, which the SDK
  also retried, stays non-retryable: Anthropic's Messages API doesn't document
  it. With `overloaded.maxRetries: 0`, a 529 follows this base policy on every
  path; before, it wasn't retried on the streaming paths.
- An adapter's own deadline isn't retried: `AnthropicAdapter`'s idle and
  first-event watchdogs still end the call with a retryable `timeout`, which
  the caller may retry, but membrane doesn't spend another full deadline on it.
- `AnthropicAdapter` reads the API's `x-should-retry` (it decides whether the
  error is retryable) and `retry-after-ms` (before `retry-after`), as the SDK
  did.
