- Anthropic server-tool blocks (`server_tool_use`, `web_search_tool_result`
  and the other blocks the API returns for a tool it runs itself) go back to
  the Anthropic API in their place in the turn. The native tool loops and
  `fromAnthropicContent` kept each on a zero-width `rawItem` carrier, but
  NativeFormatter, the native tool loop's builder and the exported
  `toAnthropicContent` dropped the carrier as empty text. So a replayed
  web-search turn lost its search results, and with signed thinking in the
  turn the API refused it: "`thinking` or `redacted_thinking` blocks in the
  latest assistant message cannot be modified". Each now sends the block
  itself, as a copy without any `cache_control` stored on it or its
  carrier. NativeFormatter and the native builder send it only in the
  assistant's own turns: another participant's message, sent as a user
  turn, still leaves it out. `toAnthropicContent` sends it when given
  `{ role: 'assistant' }`, and otherwise leaves it out, as it always left
  out a carrier. Bedrock requests
  still leave these blocks out: whether Bedrock accepts them is unknown, and
  a refusal there would fail every request carrying the conversation.
  Requests for a stored history with such a turn change bytes from that turn
  on: the first one after upgrading misses the prompt cache there, and the
  search results are input tokens on every later request. A turn stored through
  `complete()` before this release has no carrier to send.
- Streaming: a server tool's call (`server_tool_use`, `mcp_tool_use`) kept
  the empty `input` of its `content_block_start`, because only a `tool_use`
  assembled its `input_json_delta` fragments. It now holds the input the
  model wrote. Fragments that don't parse (a call cut off mid-input) leave
  the start's `input: {}`, and a warning names the block.
- `complete()` keeps a provider block it has no normalized form for (an
  Anthropic server-tool block, or an opaque Responses item such as a
  compaction) on a zero-width carrier, as the native tool loops do, instead
  of dropping it. It still keeps no `rawItem` on the text and thinking
  blocks it normalizes, which the native tool loops do keep.
- Request shapes for other wires leave a server-tool block out, bare or on
  its carrier. The OpenAI Responses formatter no longer replays one as an
  input item, the Responses input normalization no longer passes one through
  as a message part or an empty text part, and the XML and completions
  formatters, and the OpenAI, OpenAI-compatible and OpenRouter adapters, no
  longer write a zero-width carrier as an empty text part or line. In XML
  (prefill) mode the turn is text, so these blocks still aren't sent there.
