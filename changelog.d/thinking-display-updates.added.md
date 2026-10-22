- `thinking.display` takes `'updates'` (Anthropic beta `thinking-display-updates-2026-08-18`). On
  Fable 5 / 5.1, Mythos 5.1, Opus 5.5 and Sonnet 5.5 the notes the model writes between tool calls
  come back as signed `thinking` blocks before the `tool_use` they introduce, and under the default
  `'omitted'` their text is empty. With `'updates'` their text comes back, as a summary of each note,
  while reasoning stays hidden; any thinking block with non-empty text is such a note. `AnthropicAdapter`
  (header) and `BedrockAdapter` (`anthropic_beta`) add the beta whenever the body they send asks for
  `'updates'`, a thinking config passed through `extra` included. Fable and Mythos models, which get
  no thinking config for a display alone, get `{ type: 'adaptive', display: 'updates' }` for this
  one. New exports from `providers/anthropic`: `THINKING_DISPLAY_UPDATES_BETA` and
  `sendsDisplayUpdates`.
  - **Unchanged:** requests that don't set `'updates'`, including `'summarized'` or `'omitted'` alone
    on a Fable or Mythos model, which still send no thinking config.
