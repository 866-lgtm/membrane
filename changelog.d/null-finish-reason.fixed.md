- `openai-completions` and `gemini` read a `null` finish reason as no reason,
  a plain `end_turn`, as `openai`, `openai-compatible` and `openrouter`
  already did. They returned the `null` as their stop reason, and membrane's
  log line for an unmapped stop reason read its `length`, so the first
  non-streamed `complete()` in a process that met one failed with a
  `MembraneError`, "Cannot read properties of null (reading 'length')".
  Their streams already treated a `null` finish reason as none.
- Membrane's log line for an unmapped stop reason names one that isn't a
  string, which only a JavaScript adapter can return, outside the type, by
  its kind, such as `null (not a string)`, instead of reading it. Such a
  stop reason still normalizes to `end_turn`.
