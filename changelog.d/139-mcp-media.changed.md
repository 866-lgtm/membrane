- The stripped-image note, which membrane writes in place of an image it
  can't send, now says so when the image came without its data, with no
  base64 data in its source or on the block (#139). Before, it gave the
  reason it gives for data that isn't an accepted image: "[system: an image
  that belongs here was NOT shown to you — its data is not a JPEG, PNG, GIF
  or WebP image, the formats this request can carry. You are not seeing this
  image. If it matters, ask for it in one of those formats.]", with the label
  the image came with after the formats where it had one, and the warning
  `[membrane] image block stripped: its data is not a JPEG, PNG, GIF or WebP
  image`. After: "[system: an image that belongs here was NOT shown to you —
  it came without its data. You are not seeing this image.]", with the
  warning `[membrane] image block stripped: no data`. Data that isn't an
  accepted image keeps the formats note. An image in MCP's form with empty
  data, or none, gets the new note wherever the same image in membrane's form
  does, at the top of a message as inside a `tool_result` (see Fixed). The
  Responses formatter's own note for a `tool_result` image it can't carry is
  unchanged. The first request after upgrading carries the new text where a
  history holds such an image under the formats note and membrane writes the
  note again, so a provider's prompt cache misses from that note on, once. An
  xml tool loop's result stored with its raw text replays the note its turn
  wrote.
- In an xml tool loop's results, an image at a URL a provider would fetch
  gets a note that says so and gives the link, where it got the formats note
  above (#139). After: "[system: an image that belongs here was NOT shown to
  you — it came as a link (https://…), which tool results here can't carry.
  You are not seeing this image.]", with the warning
  `[membrane] image block stripped: a URL source, which the XML tool path can't carry`.
  Only an http or https link is repeated, cut at 2,048 characters between
  code points; for any other URL, or one holding half a surrogate pair, which
  the API refuses in a request's JSON, the note leaves out the parenthesis. A
  URL source that also carries data is such an image too: the split that
  sends a result's images sent that data as an image, where the native path
  reads the image at its URL. A split round stored before this change, whose
  result held one, replays without that image; when it was the only image
  the split sent, the round's report says the message was altered, and
  otherwise nothing says so.
- In an xml tool loop's results, an image in a `data:` URL is decided by its
  bytes, as the native path decides it, where it got the formats note above
  (#139): the split sends an accepted one, the results without a split give
  its `[Image: …]` note, and any other gets the note its bytes call for. A
  split round stored before this change, whose result held one beside an
  image the split sent, replays with it sent too, beside the formats note
  that turn wrote, and nothing reports it.
- A stored tool result that xml tool mode re-renders without its raw text
  keeps an image with a URL source, and gives it the note the live results
  give: the link note, or for a `data:` URL, what its bytes call for (#139).
  Before, it left the image out with no note. The first request after
  upgrading carries that note where a history holds such a result, so a
  provider's prompt cache misses from there on, once.
