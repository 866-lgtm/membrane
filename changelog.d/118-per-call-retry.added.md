- A per-call `retry` option on `complete()`, `stream()` and
  `streamYielding()`. With `false`, membrane retries none of the call's failed
  requests, whatever the error and whatever the `retry` config says: the 429
  floor and the `overloaded` schedule are off too. The failure reaches the
  caller as it came, with the provider's advice on it (`retryable`, and a
  stated wait on `retryAfterMs`), and `hooks.onError`, which is asked before
  each retry, isn't asked. It's for a caller whose own layer retries, such as
  an agent framework that retries its turns under a policy of its own and
  keeps a provider's stated waits. Two sends stay: a refusal re-issue, which
  a `complete()` call, or a `streamYielding()` call in native tool mode, asks
  for with `refusalRetries`, and the one resend with refreshed credentials
  that an adapter with a credential resolver makes after an HTTP 401. The
  default keeps membrane's retries.
