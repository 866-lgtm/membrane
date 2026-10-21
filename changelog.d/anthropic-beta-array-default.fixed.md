- **`AnthropicAdapter` keeps a default `anthropic-beta` header as the SDK sends it** when it adds a
  beta of its own for one request, reading `defaultHeaders` as the SDK's `buildHeaders` does. It used
  to read only a string: a default given as an array was dropped, so the request went out with the
  adapter's beta alone; of entries rows, only the first string row was kept; and of keys differing
  only in case, the first with a string was kept, where for the SDK a later key that carries a value
  replaces it, and a later `null` clears it.
