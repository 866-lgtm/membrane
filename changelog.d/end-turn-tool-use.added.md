- `AnthropicAdapter` keeps what it needs to report a response to Anthropic,
  on `ProviderResponse` and on its `raw` response: `responseId` / `raw.id`,
  the message id, and `requestId` / `raw.request_id`, the `request-id`
  response header, on `stream()` and `complete()`. Before, the stream path
  kept neither, and `complete()`'s raw response lost the request id when
  serialized (the SDK attaches it non-enumerably). The stream path's `raw`
  also carries `provider_events`: `message_start` (the event, its message
  without `content`), `message_delta` verbatim, and `unhandled`, the first
  20 events or deltas the adapter doesn't read, each cut to 4,096 JSON
  characters, with `unhandled_omitted` counting the rest. A field or event
  the API adds is now visible where it used to be dropped. Block content is
  not duplicated. `ProviderResponse` gains optional `responseId` and
  `requestId` for any adapter to fill.
