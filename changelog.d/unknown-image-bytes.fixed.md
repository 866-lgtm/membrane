- Image data that its destination doesn't accept now becomes the visible
  text placeholder on every request path, whatever type it is labelled with.
  Data whose bytes matched no format used to keep its label, so a text file
  labelled `image/png` went to the provider as an image, and the API refused
  that request and every later one that carried it in history. The decision
  recognizes each format by its header and takes the destination's formats:
  JPEG, PNG, GIF and WebP by default, Gemini's PNG, JPEG, WebP, HEIC and HEIF
  (so a GIF sent to Gemini now becomes the placeholder), and the Images
  adapter's PNG, WebP and JPEG. Tool results in native tool
  requests (MCP-shaped images included), every adapter (called directly or
  through a builder), the XML tool-result notes, and the OpenAI Responses
  formatter and transport now check it, and the Images adapter leaves such
  data unattached. A `data:` URL takes the same decision, a native
  `input_image` part included; a remote URL goes out as it is. An XML tool
  loop whose result's only image became the placeholder no longer sends an
  empty image turn. The placeholder now names the formats the request can
  carry and the label the data had, quoted. Its new text also replaces the
  text an image of an unsupported type already got, so after upgrading,
  requests from a context that holds one change from that point, and its
  prompt cache is written again from there once. An image whose header shows
  an accepted format is sent as before, labelled by its header;
  `toAnthropicContent` now labels a generated image that way too.
  Tool-result images in a native tool request now carry `media_type`, as the
  native formatter's requests already did; every built-in adapter reads
  either key.
