- Streamed tool calls whose `tool_calls` entries carry no `index`, as some
  OpenAI-compatible servers send them, are no longer merged into one call
  (#159). The OpenAI, OpenAI-compatible and OpenRouter adapters put every
  such entry in the first call, so a second call's id and name replaced the
  first's and their arguments ran together. Now an entry with no `index`
  never takes an index's slot. It joins the call that already has its id.
  Otherwise it starts a new call when it carries a name and the call the
  last entry went to has a different name, or has an id while the entry
  carries a new one; otherwise it continues that call. Calls without an
  index come after those with one, in the order they started. Entries with
  an `index` go to their slots as before.
- A streamed tool call keeps the first id and the first name a piece gives
  it, on the same three adapters, with or without an `index`. A later piece
  of the same call that carried a different one replaced it. OpenAI sends
  each once, so its streams come back unchanged.
- Three streams of entries with no `index` still come back wrong: one call
  whose every piece repeats its name and changes its id is split, two calls
  of the same tool sent with no ids are merged, as before, and so are
  distinct calls a server gives the same id.
