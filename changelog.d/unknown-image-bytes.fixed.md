- Image data that its destination doesn't accept now becomes the visible text
  placeholder wherever membrane converts it for a request, whatever type it is
  labelled with. Data whose bytes matched no format used to keep its label, so
  a text file labelled `image/png` went to the provider as an image, and the
  API refused that request and every later one that carried it in history. The
  decision recognizes each format by its header and takes the destination's
  formats: JPEG, PNG, GIF and WebP by default, Gemini's PNG, JPEG, WebP, HEIC
  and HEIF (so a GIF sent to Gemini now becomes the placeholder), and the
  Images adapter's PNG, WebP and JPEG. The request builders still send only
  the four default formats, so HEIC and HEIF reach Gemini only from a direct
  adapter call or a hook-replaced request. Tool results in native tool
  requests, every adapter (called directly or through a builder), the XML
  tool-result notes, and the OpenAI Responses formatter and transport now
  check it, and the Images adapter leaves such data unattached. A `data:` URL
  takes the same decision. A native `input_image` part becomes the placeholder
  when its data holds no accepted image, and otherwise replays verbatim, its
  label included. A remote URL goes out as it is, and so does a caller's
  whole-payload override (`extra.messages`, `extra.contents`). An XML tool
  loop whose result's only image became the placeholder no longer sends an
  empty image turn. The placeholder now names the formats the request can
  carry and the label the data had, quoted. Its new text also replaces the
  text an image of an unsupported type already got, so after upgrading,
  requests from a context that holds one change from that point, and its
  prompt cache is written again from there once. An image whose header shows
  an accepted format is sent as before, labelled by its header;
  `toAnthropicContent` now labels a generated image that way too, and an image
  with no label now goes under its header's type, where the OpenAI-family
  adapters sent `image/png` and Gemini `image/jpeg`.
- An MCP-shaped image in a tool result (`{ type: 'image', data, mimeType }`)
  is now decided by its data. The native builder gave every such image the
  placeholder, and the XML builder failed on one, so an accepted one now
  reaches the model as an image. A context that holds such images sends
  larger requests from the first one after upgrading, and its prompt cache is
  written again from there once.
