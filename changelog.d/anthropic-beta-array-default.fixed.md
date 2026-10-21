- **`AnthropicAdapter` keeps a default `anthropic-beta` header given as an array** when it adds a
  per-request beta, reading it as the SDK does: each value kept, `null` clearing the values before it.
  It used to send only the per-request beta, dropping the default's values.
