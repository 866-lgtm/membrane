- A `tool_use` block's `input` is now always a plain object, as
  `ToolUseContent` types it. When a model's arguments aren't a JSON object,
  `input` is `{}` and `unparseableInput` keeps what came, as the Anthropic
  adapter already did for a call its stream left unfinished.
  - The OpenAI, OpenAI-compatible, OpenAI Responses and OpenRouter adapters
    stored whatever `JSON.parse` returned, so a model's arguments of `null`,
    a number, a string or an array became `input` as they were. Arguments
    that didn't parse became `{}` with nothing to tell them from a call with
    no arguments. Both are now `{}` with `unparseableInput`. In a
    non-streamed response, an `arguments` field that isn't text at all,
    which these wires' specs don't allow, is read as a value, as Gemini's
    `args` are, and a `null` field is a call with no arguments.
  - The Anthropic and Bedrock stream assemblies kept a parse that wasn't an
    object; Bedrock also kept `{}` silently for arguments that didn't parse.
    Both now mark them. Bedrock now also marks a call the stream left open
    (no `content_block_stop`, as when `max_tokens` cuts it), as the Anthropic
    adapter does: `input` stays what `content_block_start` carried, and
    `unparseableInput` holds whatever arguments arrived, `""` when none did.
    Before, it parsed what had arrived as if the call had finished, and
    kept `{}` unmarked when that didn't parse or nothing had arrived.
  - Gemini copied `functionCall.args` into `input` unchecked. `input` is now
    `{}` when the call carries no args, or `null` ones (unset, in Gemini's
    proto3 JSON), and a value that isn't an object is kept, as JSON, in
    `unparseableInput`. The exported `fromAnthropicContent` and Bedrock's
    non-streamed response follow the same rule for the `input` the provider
    sent, where `null` is a value that isn't an object.
  - `Membrane.complete` and `Membrane.stream` give every `tool_use` in the
    content they hand on an object `input`, whatever an adapter gave: an
    `input` that isn't an object reaches the caller as `{}`, with
    `unparseableInput` holding it as JSON unless the adapter marked the block
    already. `Membrane.complete` now carries an adapter's
    `unparseableInput`, as streamed responses already did, and its
    `toolCalls` get the same object `input`. The streaming block events
    (`block_complete`, and the deprecated `onContentBlockUpdate`) still
    report a tool call as the adapter streamed it, with no marker.
  - `ToolCall` has `unparseableInput` too, set from the call's block, so an
    executor can answer a marked call with an error result instead of
    running it with `{}`. It's on the calls `stream()` hands `onToolCalls`,
    the yielding stream's `tool-calls` event and `complete()`'s `toolCalls`.
  - A call with empty arguments, or arguments that are only JSON
    whitespace, is `{}`, unmarked.
  - The warning for arguments that aren't an object, which the Anthropic
    and Bedrock stream assemblies now log too for a call that finished, no
    longer includes the parse error, whose message quotes the arguments. A
    call the stream left open is marked without a warning; the response's
    stop reason says why.
