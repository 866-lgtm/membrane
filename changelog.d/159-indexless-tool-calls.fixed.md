- Streamed tool calls whose `tool_calls` entries carry no `index`, as some
  OpenAI-compatible servers send them, are no longer merged into one call
  (#159). The OpenAI, OpenAI-compatible and OpenRouter adapters put every
  such entry in the first call, so a second call's id and name replaced the
  first's and their arguments ran together. Now index-less entries with
  different ids come back as separate calls: an entry with no `index` starts
  a new call when it carries an id that no call has and the newest call
  already has an id. One that repeats a call's id joins that call, and one
  without an id continues the newest call. Entries with an `index` are
  placed as before. The one stream this splits where it didn't before is a
  single call whose pieces carry different ids, which no server is known to
  send.
