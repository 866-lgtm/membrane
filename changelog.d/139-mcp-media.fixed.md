- Media in MCP's form, `{ type: 'image', data, mimeType }` with no `source`,
  is now carried as the same media in membrane's form is,
  `{ type, source: { type: 'base64', data, mediaType } }`, for an image,
  document, audio clip or video (#139). An image converts without a
  `mimeType` too, with no `mediaType`, and every request decides it by its
  data's header, as it decides any image; other media without a `mimeType`
  doesn't convert. Membrane converts it where content enters: the messages
  of `complete()`, `stream()` and `streamYielding()`, rebuilt each round of a
  native tool loop; an xml tool loop's results, as the document takes them
  (`formatToolResults` and the split that sends a result's images); and
  `AnthropicAdapter`'s request built directly. The block keeps its other
  fields, the caller's messages and the executor's results stay as they
  were, and a round's report names what it would for the same media in
  membrane's form. Carried, an image counts toward the request's byte cap as
  one in membrane's form does: a request it takes over the cap fails at the
  build, or with `shedOversizeImages`, sheds images to fit. Media whose
  `data` is empty doesn't convert, since the API refuses an image with none.
  Inside a `tool_result`, the anthropic-xml and native formatters already
  read such an image by its data, and send it as before. Before:
  - at the top of a message, the anthropic-xml formatter in either tool mode,
    the native formatter and the Responses formatter threw a TypeError on
    such an image, and the anthropic-xml formatter in native tool mode and
    the native formatter on such audio;
  - `AnthropicAdapter`'s request built directly threw on one in a
    `tool_result`, and sent one at the top of a message as it was, with no
    source, which the API refuses.
- A media block with no `source` object that can't convert, with no `data`
  or empty `data`, or media other than an image with no `mimeType`, no longer
  throws a TypeError where it did: at the top of a message in the
  formatters, and inside a `tool_result` in `AnthropicAdapter`'s request
  built directly. Membrane's request builds, and `AnthropicAdapter`'s request
  built directly, take it as a source they can't represent, as they take a
  URL image they have no branch for. At the top of a message the formatters
  leave it out and report its message altered; a document, or audio in xml
  tool mode, still meets `unsupportedMedia` there, as in membrane's form.
  Inside a `tool_result`, the anthropic-xml and native formatters, in either
  tool mode, put the note that an image came without its data (see Changed)
  in its place. `AnthropicAdapter`'s request built directly leaves it out and
  reports the block, at the top of a message as inside a `tool_result`; at
  the top it used to send one as it was, with no source. A message it leaves
  with no block is dropped, as the build drops any message it leaves empty,
  and where dropping it would change the request's final role, the build
  refuses.
