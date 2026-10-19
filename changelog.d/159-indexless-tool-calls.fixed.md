- Streamed tool calls whose `tool_calls` entries carry no `index` (absent or
  `null`), as some OpenAI-compatible servers are reported to send them, are
  no longer merged into one call (#159). The OpenAI, OpenAI-compatible and
  OpenRouter adapters put every such entry in the call at index 0, so a
  second call's id and name replaced the first's and their arguments ran
  together. Now an entry with no `index` never takes an index's slot. One
  that carries no id, name or arguments is dropped. Any other joins the call
  that already has its id, or failing that the call the last entry went to,
  unless it carries a name and a new id while that call has an id; then it
  starts a new call. Calls without an index come after those with one, in the
  order they started. Entries with an `index` go to their slots as before,
  and a call that began without one moves to the slot a later entry gives it
  under its id.
- On the same three adapters, with or without an `index`, a piece that names
  a tool other than its call's starts a call of its own, and a call keeps the
  first id a piece gives it. A later piece's name and id replaced the call's,
  so two calls of different tools that a server put in one slot, or gave one
  id, came back as one call under the later name and id, with their arguments
  run together. They now come back as two calls, each with its own arguments.
  A stream whose entries all carry an `index`, and which sends each call's id
  and name once, comes back as before.
- Three kinds of stream that came back as one call now come back as two: one
  call whose every piece repeats its name and changes its id, one whose first
  piece has no `index` and whose later pieces carry index 0 without its id,
  and one call that a later piece renames midway through its arguments, whose
  two halves then don't parse. In the first kind, a first piece with no
  arguments becomes an extra call with `{}`. As before, these adapters merge
  two calls of the same tool sent with no ids or with their names before
  their ids, distinct calls of one tool given the same id or put in one slot,
  and a call whose first piece has its id but no name into the call before
  it. When the earlier call's arguments are empty, the merged call parses,
  and in the last case it runs the earlier call's tool with the later call's
  arguments.
