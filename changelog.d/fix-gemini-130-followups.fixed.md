- `gemini`: a response whose cached count exceeds its prompt count, which is
  read as cache-excluded, may have a `totalTokenCount` that counts the cached
  span too. The usage check now accepts that total, so such a response no
  longer logs "usageMetadata does not reconcile" on every call; a total that
  matches neither sum still does, and names both.
