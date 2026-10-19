- The Anthropic adapter's cache keepalive now replays a request only through
  its last one-hour cache marker and the end of the user turn at or after it,
  so that a refresh doesn't split a tool call's results or end on an assistant
  message unless the request did. A request with no user message at or after
  that marker is replayed whole. It replayed the whole request every time, and
  whatever followed the last one-hour marker was billed as input on every
  refresh, or written again where a five-minute marker covered it, though no
  cache entry the refresh kept warm held it. Under `cacheMarkers: 'cm-owned'`,
  membrane places no marker on a tool loop's rounds, so a tool-using turn's
  last request carries its rounds after the last marker, and after such a
  turn each refresh paid for them again, every 45 minutes by default for up to
  a day. A refresh now reads the same cache entries without that cost. A
  five-minute marker in what's left out goes with it: each refresh wrote its
  expired entry again, and after two such refreshes the lineage was dropped.
