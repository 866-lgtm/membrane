- OpenAI chat completions, the OpenAI Responses API and Gemini now keep a
  provider-reported cache-read count of 0 as `cacheReadTokens: 0`. Before,
  a reported 0 was dropped to `undefined`, indistinguishable from a provider
  that reported nothing. An unreported count is still absent. Gemini's
  `usageMetadata` follows proto3 JSON, which omits zero counts, so when it is
  present a missing `cachedContentTokenCount` is a reported 0, as a missing
  `candidatesTokenCount` is; only a response without `usageMetadata` leaves
  the count unreported.
- Turn totals (the usage `complete()` and `stream()` return, the `usage`
  event's `usage`, and `onUsage`) and a refused attempt's record
  (`details.usage.discardedAttempts`) carry a cache-read or cache-creation
  count, and thinking tokens, once any round reported it, a 0 included, as
  each round's own entry in `perRound` does. Before, a count was added only
  when it was positive, so a reported 0 was lost there too. A count no round
  reported is still absent. This changes values a caller reads without
  `round`: where a provider reports 0, the totals now carry the 0.
