- Streamed tool calls whose `tool_calls` entries carry no `index` (absent or
  `null`), as some OpenAI-compatible servers are reported to send them, are
  no longer merged into one call (#159). The OpenAI, OpenAI-compatible and
  OpenRouter adapters put every such entry in the call at index 0, so a
  second call's id and name replaced the first's and their arguments ran
  together. Now an entry with no `index` never takes an index's slot. It
  joins the call that already has its id, or failing that the call the last
  entry went to, unless it carries a name and a new id while that call has an
  id; then it starts a new call. Calls without an index come after those with
  one, in the order they started. Entries with an `index` go to their slots
  as before. In a slot, a piece continues the latest call there that has its
  id, or else the last call there. One that carries the id of a call that
  began without an index, when no call in the slot has it, moves that call
  into its slot, unless it names another tool.
- On the same three adapters, with or without an `index`, a piece that names
  a tool other than its call's starts a call of its own, and a call keeps the
  first id a piece gives it. A later piece's name and id replaced the call's,
  so two calls of different tools that a server put in one slot, or gave one
  id, came back as one call under the later name and id, with their arguments
  run together. They now come back as two calls, each with its own arguments.
  An entry that carries no id, name or arguments is dropped, with or without
  an `index`; one with an `index` opened an empty call. A stream that gives
  each call its own `index` and sends each call's id and name once, with no
  two calls under one id, comes back as before.
- Every streamed tool call in a response comes back under an id of its own,
  on the same three adapters. A call with no id comes back as `call_<n>`,
  from `call_1`, and one whose id an earlier call in the response already has
  as `<id>_<n>`, from `<id>_2`, and a `[membrane]` warning names each. A call
  with no id came back with `''`, which no tool result can answer: the
  adapters send it back as `""` or as no `tool_call_id` at all. Two calls
  under one id, as these adapters returned for two calls in their own slots
  that a server gave one id or none, made the native formatter's tool-pair
  check refuse the turn that held them.
- Four kinds of stream that came back as one call now come back as several:
  one call whose every piece repeats its name and changes its id, as one call
  per such piece; one whose first piece has no `index` and whose later pieces
  carry index 0 without its id, as two; one call that a later piece renames
  midway through its arguments, as two whose halves don't parse; and a piece
  that carries one call's id and names another call's tool, as a call of its
  own, so that tool comes back twice. In the first kind, a first piece with
  no arguments becomes an extra call with `{}`, and in the last, the other
  call comes back with `{}` when it has no arguments of its own. As before,
  these adapters merge two calls of the same tool sent with no ids or with
  their names before their ids, distinct calls of one tool given the same id
  or put in one slot, and a call whose first piece has its id but no name
  into the call before it. When the earlier call's arguments are empty, the
  merged call parses, and in the last case it runs the earlier call's tool
  with the later call's arguments.
