- `estimatedCost` is now omitted, with the one-time unpriced-model warning,
  for `gemini-2.5-flash-image`, `gemini-2.5-flash-preview-tts`,
  `gemini-2.5-pro-preview-tts` and `gemini-2.5-flash-native-audio-*`. A text
  model's row matched them by prefix and priced their image, speech or audio
  output at its text rate, below what Google charges for it. The new rows leave
  `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` and
  `gemini-3.1-flash-lite-image` unpriced. A `ModelRegistry` can still price
  any of them.
