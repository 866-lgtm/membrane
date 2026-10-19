- Streamed tool calls whose `tool_calls` entries carry no `index` (absent or
  `null`), as some OpenAI-compatible servers are reported to send them, are
  no longer merged into one call (#159). The OpenAI, OpenAI-compatible and
  OpenRouter adapters put every such entry in the call at index 0, so a
  second call's id and name replaced the first's and their arguments ran
  together. Now an entry with no `index` never takes an index's slot. One
  that carries no id, name or arguments is dropped. Any other joins the call
  that already has its id. Failing that, it starts a new call when it carries
  a name and the call the last entry went to already has a different name, or
  has an id while the entry carries a new one. Otherwise it continues that
  call. Calls without an index come after those with one, in the order they
  started. Entries with an `index` go to their slots as before, and a call
  that began without one moves to the slot a later entry gives it under its
  id.
- A streamed tool call keeps the first id and the first name a piece gives
  it, on the same three adapters, with or without an `index`. A later piece
  of the same call that carried a different one replaced it. A stream whose
  entries all carry an `index`, and which sends each call's id and name
  once, comes back as before.
- Two streams that came back as one call now come back as two: one call
  whose every piece repeats its name and changes its id, and one whose first
  piece has no `index` and whose later pieces carry index 0 without its id.
  These adapters still merge two calls of the same tool sent with no ids, or
  whose names come before their ids, and distinct calls a server gives the
  same id, as before. A call whose first piece carries its id but not its
  name joins the call before it.
