- A per-call `retry` option on `complete()`, `stream()` and
  `streamYielding()`. With `false`, membrane sends each of the call's
  requests once, whatever fails and whatever the `retry` config says: the 429
  floor and the `overloaded` schedule are off too. The failure reaches the
  caller as it came, with the provider's advice on it (`retryable`, and a
  stated wait on `retryAfterMs`), and `hooks.onError`, which is asked before
  each retry, isn't asked. It's for a caller whose own layer retries, such as
  an agent framework that holds every agent on a model through a capacity
  storm and paces one organization's rate limits. A refusal re-issue
  (`refusalRetries`) is asked for separately and isn't affected. The default
  keeps membrane's retries.
