- `gemini` reads `usageMetadata.toolUsePromptTokenCount`, the prompt tokens
  Gemini's built-in tools add, into `inputTokens`, and counts it in the check
  against `totalTokenCount`. A response that reported the field logged
  "usageMetadata does not reconcile" every time, and its tool-use tokens were
  left out of usage and the cost estimate, though Google bills code
  execution's, URL context's and file search's as input (#120). Grounding,
  with Google Search or Google Maps, is billed per query or per grounded
  prompt, which membrane doesn't price, and for text models Google doesn't say
  whether grounding's retrieved context is counted in this field or charged as
  input. If it is counted and not charged, a grounded response's input is
  overstated.
