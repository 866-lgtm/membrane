- **A native tool call's `block_complete` event carries the tool's name as the caller gave it.** For
  a tool whose name has a colon, the event carried the escaped wire name (`srv__get_weather` for
  `srv:get_weather`), unlike the returned content and tool calls.
