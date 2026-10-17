- The note membrane sends in place of an image that came without its data,
  with no base64 data in its source or on the block and no URL, now says so
  (#139). It used to give a media type as the reason: "undefined", unless a
  source declared one. Before: "[system: an image that belongs here was NOT
  shown to you — its media type "undefined" is not accepted by the model API
  (only jpeg/png/gif/webp are). You are not seeing this image. If it
  matters, ask for it in a supported format.]", with the warning
  `[membrane] image block stripped: unsupported media type "undefined"`.
  After: "[system: an image that belongs here was NOT shown to you — it came
  without its data. You are not seeing this image.]", with the warning
  `[membrane] image block stripped: no data`. An image with data whose media
  type is the reason, MCP's form without a `mimeType` among them, keeps the
  note about its media type. The first request after upgrading carries the
  new text wherever a history holds such an image, so a provider's prompt
  cache misses from that note on, once.
