- A `tool_use` block's `input` is now always a plain object, as
  `ToolUseContent` types it. When a model's arguments aren't a JSON object,
  `input` is `{}` and `unparseableInput` keeps what came, as the Anthropic
  adapter already did for arguments that never finished arriving.
  - The OpenAI, OpenAI-compatible, OpenAI Responses and OpenRouter adapters
    stored whatever `JSON.parse` returned, so a model's arguments of `null`,
    a number, a string or an array became `input` as they were. Arguments
    that didn't parse became `{}` with nothing to tell them from a call with
    no arguments. Both are now `{}` with `unparseableInput`. An `arguments`
    field that isn't text at all, which these wires' specs don't allow, is
    read as Gemini's `args` are, and a `null` field is a call with no
    arguments.
  - The Anthropic and Bedrock stream assemblies kept a parse that wasn't an
    object; Bedrock also kept `{}` silently for arguments that didn't parse.
    Both now mark them. Bedrock now also marks a call the stream left open
    (no `content_block_stop`, as when `max_tokens` cuts it), as the Anthropic
    adapter does: `input` stays what `content_block_start` carried, and
    `unparseableInput` holds whatever arguments arrived, `""` when none did.
    Before, it parsed what had arrived, and kept `{}` unmarked when that
    didn't parse or nothing had arrived.
  - Gemini copied `functionCall.args` into `input` unchecked. `input` is now
    `{}` when the call carries no args, and a value that isn't an object is
    kept, as JSON, in `unparseableInput`.
  - `Membrane.complete` and `Membrane.stream` hand on every `tool_use` with
    an object `input`, whatever an adapter gave: an `input` that isn't an
    object reaches the caller as `{}`, with `unparseableInput` holding it as
    JSON unless the adapter marked the block already. `Membrane.complete` now
    carries an adapter's `unparseableInput`, as streamed responses already
    did, and its `toolCalls` get the same object `input`.
  - `ToolCall` has `unparseableInput` too, set from the call's block, so an
    executor can answer a marked call with an error result instead of
    running it with `{}`. It's on the calls `stream()` hands `onToolCalls`,
    the yielding stream's `tool-calls` event and `complete()`'s `toolCalls`.
  - A call with empty arguments is still `{}`, unmarked.
