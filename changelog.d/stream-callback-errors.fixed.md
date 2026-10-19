- A stream callback's error is no longer swallowed (#117). The OpenAI,
  OpenAI-compatible, OpenAI completions and OpenRouter adapters ignored an
  error thrown by `onChunk` (or, on OpenRouter, `onContentBlock`), and the
  Bedrock adapter logged it as a malformed event and skipped it, so the stream
  finished as if nothing had happened. Now the error fails the stream through
  the adapter's error boundary, as it already did on the Anthropic, Gemini and
  Responses API adapters. The provider's response body is cancelled rather
  than left unread, on Gemini too. The error is typed by `classifyError` like
  any other, a plain `Error` by its message: most are `unknown` and not
  retryable, while one whose code reads as a network failure, such as
  `EPIPE` from a callback writing to a closed pipe, is typed `network` and
  retryable. With stop sequences, text held back for a possible stop isn't
  handed to a callback that has thrown.
- What these adapters can't read is still dropped. A data line that isn't
  JSON, or whose JSON isn't an object (`null`, a number, a string, an array),
  drops its frame, on Gemini and the Responses API too, where `data: null`
  failed the stream. A frame whose JSON isn't an object no longer renews the
  progress deadline (`progressTimeoutMs`), and a Bedrock event that decodes to
  such JSON doesn't either. In 0.6.0 every SSE data frame that parsed renewed
  it, and so did every Bedrock event that decoded, other than a `ping` and one
  that decoded to `null`. On the OpenAI, OpenAI-compatible and OpenRouter
  adapters, a `tool_calls` that isn't an array drops its tool calls, and an
  entry that isn't an object, or whose `index` isn't an array index (an
  integer from 0 to 2^32 - 2, or its decimal string with no leading zero),
  drops that entry; the rest of the frame is read. The calls placed are
  gathered in index order, so a first call at index 1, or one after a
  dropped entry, no longer fails the response. A number
  entry used to become an empty tool call. On Bedrock, an event that doesn't
  decode, or decodes to `null`, is skipped with a warning, as before, and so
  is a block start or stop whose index or block can't be placed. When a
  skipped block start leaves the message without a block before later ones,
  the call fails as a retryable `network` error naming that block. Where the
  start's index named no slot, or its block was `null`, the call failed with a
  `TypeError`; where its block was another value that isn't an object, it
  returned the message without that block. An event that carries no `bytes`
  (the field missing or empty), which was skipped silently, and one that
  decodes to other JSON that isn't an object, which was read as nothing, are
  now skipped with the warning too.
- **Provider adapters:** `onProgress`'s doc now says a streaming adapter calls
  it for an SSE data frame only when the frame parses to a JSON object, and
  for an event-stream message only when it decodes to one. A custom adapter
  that follows 0.6.0's wording, each SSE data frame that parses and each
  decoded event-stream message, still renews the progress deadline on a frame
  or message whose JSON is `null`, a number, a string or an array. To match
  the built-in adapters, drop such a frame or message before calling
  `onProgress`.
