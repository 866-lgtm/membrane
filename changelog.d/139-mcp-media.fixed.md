- Media in MCP's form, `{ type: 'image', data, mimeType }` with no `source`,
  is now carried as the same media in membrane's form is,
  `{ type, source: { type: 'base64', data, mediaType } }`, for an image,
  document, audio clip or video (#139). Membrane converts it where content
  enters: the messages of `complete()`, `stream()` and `streamYielding()`,
  rebuilt each round of a native tool loop; an xml tool loop's results, as
  the document takes them (`formatToolResults` and the split that sends a
  result's images); and `AnthropicAdapter`'s request built directly. The
  block keeps its other fields, the caller's messages and the executor's
  results stay as they were, and a round's report names what it would for
  the same media in membrane's form. A history that holds such an image in a
  `tool_result` now sends it where a native or Responses request sent a
  note, so a provider's prompt cache misses from that block on, once, and
  the image counts toward the request's byte cap as one in membrane's form
  does: a request it takes over the cap fails at the build, or with
  `shedOversizeImages`, sheds images to fit. Before:
  - at the top of a message, the anthropic-xml, native and Responses
    formatters threw a TypeError on such an image, and the native formatter
    on such audio;
  - inside a `tool_result`, xml tool mode threw, native tool mode replaced
    an image with a note that its media type "undefined" isn't accepted, and
    the Responses formatter replaced it with its note that the request
    couldn't carry it;
  - an xml tool loop threw when its executor returned such an image;
  - `AnthropicAdapter`'s request built directly threw on one in a
    `tool_result`.
- A media block with no `source` object that can't convert, with no `data`
  or no `mimeType`, no longer throws a TypeError. Membrane's request builds,
  and `AnthropicAdapter`'s request built directly, take it as a source they
  can't represent, as they take a URL image they have no branch for. At the
  top of a message the formatters leave it out and report its message
  altered; a document, or audio in xml tool mode, still meets
  `unsupportedMedia` there, as in membrane's form. Inside a `tool_result`,
  xml tool mode leaves it out and reports its message; native tool mode, and
  an xml tool loop's results, put the stripped-image note in place of an
  image. `AnthropicAdapter`'s request built directly leaves it out and
  reports the block, at the top of a message as inside a `tool_result`; at
  the top it used to send one as it was, with no source. A message it leaves
  with no block is dropped, as the build drops any message it leaves empty,
  and where dropping it would change the request's final role, the build
  refuses.
- An xml tool loop's results give the stripped-image note to any image
  there's no data to show for, a URL image and a base64 source without its
  data among them. Before, `formatToolResults` and the remainder after a
  split threw a TypeError reading such an image's data, and the split sent a
  base64 source without data, of a type it accepts, as an image. The XML
  replay of a split round leaves out the same images, as the split did:
  media in MCP's form that can't convert, and a base64 source without data.
