- The stripped-image note, which membrane writes in place of an image it
  can't send, now says so when the image came without its data, with no
  base64 data in its source or on the block and no URL (#139). Before, it
  gave the reason it gives for data that isn't an accepted image: "[system:
  an image that belongs here was NOT shown to you — its data is not a JPEG,
  PNG, GIF or WebP image, the formats this request can carry. You are not
  seeing this image. If it matters, ask for it in one of those formats.]",
  with the label the image came with after the formats where it had one,
  and the warning `[membrane] image block stripped: its data is not a JPEG,
  PNG, GIF or WebP image`. After: "[system: an image that belongs here was
  NOT shown to you — it came without its data. You are not seeing this
  image.]", with the warning `[membrane] image block stripped: no data`.
  Data that isn't an accepted image keeps the formats note. Where an image is
  left out with no note, as media with no source is at the top of a
  message, nothing is written before or after, and the Responses formatter's
  own note for a `tool_result` image it can't carry is unchanged. The first
  request after upgrading carries the new text where a history holds such an
  image under the formats note, so a provider's prompt cache misses from that
  note on, once.
- In an xml tool loop's results, an image that came as a link, with a URL
  source, gets a note that says so and gives the link, where it got the
  formats note above (#139). After: "[system: an image that belongs here was
  NOT shown to you — it came as a link (https://…), which tool results here
  can't carry. You are not seeing this image.]", with the warning
  `[membrane] image block stripped: a URL source, which the XML tool path can't carry`.
  Only an http or https link is repeated, cut at 2,048 characters between
  code points; for any other URL, such as a data URL, or one holding half a
  surrogate pair, which the API refuses in a request's JSON, the note leaves
  out the parenthesis. A URL source that also carries data is such an image
  too: the split that sends a result's images sent that data as an image,
  where the native path reads the image at its URL.
