- Media in MCP's form, `{ type: 'image', data, mimeType }` with no `source`,
  is now carried as the same media in membrane's form is,
  `{ type, source: { type: 'base64', data, mediaType } }`, for an image,
  document, audio clip or video (#139). An image converts whatever its data
  and label: every request decides it by its data's header, as it decides
  any image, and gives the note that it came without its data where its data
  is missing or empty (see Changed). A document, audio clip or video converts
  only with data that isn't empty and a `mimeType` that isn't empty. Membrane
  converts it where content enters: the messages of `complete()`, `stream()`
  and `streamYielding()`, rebuilt each round of a native tool loop, and
  `AnthropicAdapter`'s request built directly. An xml tool loop's results,
  which `formatToolResults` and the split that sends a result's images render
  each round, already read an image in MCP's form by its data. The block keeps
  its other fields, the caller's messages and the executor's results stay as
  they were, and a round's report names what it would for the same media in
  membrane's form. Inside a `tool_result`, the anthropic-xml and native
  formatters already read such an image by its data, and send it as before.
  Before:
  - at the top of a message, the anthropic-xml formatter in either tool mode,
    the native formatter and the Responses formatter threw a TypeError on
    such an image, and the anthropic-xml formatter in native tool mode and
    the native formatter on such audio;
  - `AnthropicAdapter`'s request built directly threw on one in a
    `tool_result`, and sent one at the top of a message as it was, with no
    source, which the API refuses.
- A document, audio clip or video in MCP's form that doesn't convert, with
  no `data`, empty `data` or no `mimeType`, is a source membrane's request
  builds can't represent, as a URL image is where they have no branch for
  one: at the top of a message they leave it out with no note and report its
  message altered (#139). Before, the native formatter, and the anthropic-xml
  formatter in native tool mode, threw a TypeError on such audio there, and
  `AnthropicAdapter`'s request built directly sent it as it was, with no
  source, which the API refuses. A document, or audio in xml tool mode, still
  meets `unsupportedMedia` at the top of a message, as in membrane's form.
  Inside a `tool_result` nothing changes: the xml renderers leave it out, and
  the native formatter passes it on, which the Anthropic adapter leaves out
  as it does any block it has no tool-result form for. A message the direct
  build leaves with no block is dropped, as the build drops any message it
  leaves empty, and where dropping it would change the request's final role,
  the build refuses.
