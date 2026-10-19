- Media in MCP's form, `{ type: 'image', data, mimeType }` with no `source`,
  is now carried as the same media in membrane's form is,
  `{ type, source: { type: 'base64', data, mediaType } }`, for an image,
  document, audio clip or video (#139). An image converts whatever its data
  and label, and is then read as any image is: a request that sends an image
  decides it by its data's header, and one with data that is missing or empty
  gets the note that it came without its data (see Changed). A document, audio
  clip or video converts only with data that isn't empty and a `mimeType` that
  isn't empty. Membrane converts it wherever it takes content: the messages
  of `complete()`, `stream()` and `streamYielding()`, rebuilt each round of a
  native tool loop; the request built directly by each adapter that reads
  membrane's content blocks, `AnthropicAdapter`, `BedrockAdapter`,
  `OpenAIAdapter`, `OpenAICompatibleAdapter`, `OpenRouterAdapter`,
  `GeminiAdapter`, the image adapter `OpenAIResponsesAdapter`, and
  `OpenAIResponsesAPIAdapter` in subscription mode; and the exported
  `toAnthropicContent` and `transformToChat`. An xml tool loop's
  results, which `formatToolResults` and the split that sends a result's
  images render each round, already read an image in MCP's form by its data.
  The block keeps its other fields, apart from MCP's `annotations` and
  `_meta`, which no request carries. The caller's messages and the executor's
  results stay as they were, and a round's report names what it would for the
  same media in membrane's form. Inside a `tool_result`, the anthropic-xml and
  native formatters already read such an image by its data, and send it as
  before. Before:
  - at the top of a message, the anthropic-xml formatter in either tool mode,
    the native formatter and the Responses formatter threw a TypeError on
    such an image, and the anthropic-xml formatter in native tool mode and
    the native formatter on such audio;
  - `AnthropicAdapter`'s request built directly threw on one in a
    `tool_result`, and sent one at the top of a message as it was, with no
    source, which the API refuses;
  - `BedrockAdapter`'s request built directly sent one as it was, at the top
    of a message and in a `tool_result`, which the API refuses;
  - the requests built directly by `OpenAIAdapter`, `OpenAICompatibleAdapter`,
    `OpenRouterAdapter` and `GeminiAdapter` left such an image at the top of
    a message out, with no note and no report, `OpenAIResponsesAdapter`
    attached none to an image edit, and the one `OpenAIResponsesAPIAdapter`
    built in subscription mode left it out and reported its message altered,
    and gave one in a `tool_result` the note for an image it can't carry;
  - `toAnthropicContent` threw a TypeError on such an image, at the top of
    the turn and in a `tool_result`, and on such a document at the top, and
    `transformToChat` threw one on such an image at the top of a message.
- A document, audio clip or video in MCP's form that doesn't convert, with
  no `data`, empty `data` or no `mimeType`, is a source membrane's request
  builds can't represent, as a URL image is where they have no branch for
  one: at the top of a message they leave it out with no note and report its
  message altered (#139). Before, the native formatter, and the anthropic-xml
  formatter in native tool mode, threw a TypeError on such audio there, and
  the requests `AnthropicAdapter` and `BedrockAdapter` built directly sent it
  as it was, with no source, which the API refuses. A document, or audio in
  xml tool mode, still meets `unsupportedMedia` at the top of a message, as
  in membrane's form. `toAnthropicContent` leaves out such a document, where
  it threw a TypeError, and gives such audio or video the error it gives
  audio or video in membrane's form. Inside a `tool_result` nothing changes:
  the xml renderers leave it out, and the native formatter passes it on,
  which the Anthropic adapter leaves out as it does any block it has no
  tool-result form for. A message the Anthropic or Bedrock adapter's direct
  build leaves with no block is dropped, as the build drops any message it
  leaves empty, and where dropping it would change the request's final role,
  the build refuses.
- An image in a base64 `data:` URL whose payload escapes characters, such as
  its padding as `%3D`, is percent-decoded before its bytes are read, as the
  fetch spec's `data:` URL processor decodes it, wherever membrane reads a
  `data:` URL image (#153). Before, `AnthropicAdapter`'s request sent the
  escaped text as the image's base64 data, which isn't base64, and the OpenAI,
  OpenAI-compatible and OpenRouter requests sent the URL with its escapes.
