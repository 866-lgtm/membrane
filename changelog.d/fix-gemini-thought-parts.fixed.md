- `GeminiAdapter` keeps the model's reasoning out of its answer. Gemini
  returns reasoning as text parts flagged `thought: true`, and the adapter read
  every part's text as answer text, so a request that asked for them
  (`thinkingConfig.includeThoughts`, e.g. through `providerParams`) had the
  model's reasoning joined onto the front of its reply
  with no separator, streamed through `onChunk` as visible text, and in
  `rawAssistantText`. On `complete()` and `stream()`, thought parts now
  become one `thinking` block, placed before the answer, and are not streamed
  through `onChunk`, as `OpenAICompatibleAdapter` treats its reasoning channel
  (the Anthropic adapter, by contrast, streams thinking chunks). A response of
  only thought parts has no text block. An image model's interim thought
  images, flagged the same way, are no longer among the answer's images.
  `fromGeminiParts()` keeps part order:
  each thought part with text becomes its own `thinking` block where it fell,
  as each text part is its own `text` block. `toGeminiParts()` sends only text
  and tool calls: a `thinking` or `redacted_thinking` block, as
  `convertMessages` drops them, or an image, which it doesn't convert, used to
  become a text part reading "[object Object]". Thinking blocks in prior
  assistant turns are still not sent back to Gemini. A response without
  thought parts is unchanged.
  - Not round-tripped: Gemini's `thoughtSignature`, which may ride any part,
    is not captured.
