- `GeminiAdapter` keeps the model's reasoning out of its answer. Gemini
  returns reasoning as text parts flagged `thought: true`, and the adapter read
  every part's text as answer text, so a request that asked for them
  (`thinkingConfig.includeThoughts`, e.g. through `providerParams`) had the
  model's reasoning joined onto the front of its reply
  with no separator, streamed through `onChunk` as visible text, and in
  `rawAssistantText`. Thought parts now become one `thinking` block, placed
  before the answer, on `complete()`, `stream()` and `fromGeminiParts()`, and
  are not streamed through `onChunk`, as `OpenAICompatibleAdapter` already
  treats its reasoning channel. A response of only thought parts has no text
  block. Thinking blocks in prior assistant turns are still not sent back to
  Gemini. A response without thought parts is unchanged.
  - Not round-tripped: Gemini's `thoughtSignature`, which may ride any part,
    is not captured.
