- `openai-completions` and `gemini` read a `null` finish reason as no reason,
  a plain `end_turn`, as `openai`, `openai-compatible` and `openrouter`
  already did. They returned the `null` as their stop reason, and membrane's
  log line for an unmapped stop reason read its `length`, so the first
  non-streamed `complete()` in a process that met one failed with a
  `MembraneError`, "Cannot read properties of null (reading 'length')".
  Their streams read a finish reason only when it's truthy, so a `null` one
  never reached the mapper. An empty finish reason is still passed on as an
  unmapped stop reason, as in the other three.
- Membrane's log line for an unmapped stop reason can't fail the call. An
  adapter can return a stop reason outside its type, passing on a server's
  value or written in JavaScript, and one the line couldn't print, such as
  `null` or `undefined`, failed the first call that met it. The line now
  prints a number, `null` or `undefined` by its value and anything else but
  a string by its kind, such as `object (not a string)`. Such a stop reason
  still normalizes to `end_turn`. It's logged once by what the line prints,
  so an object an adapter returns fresh on every response is logged once.
- The line no longer says `details.stop.providerReason` carries a stop
  reason that isn't a non-empty string. When the adapter gives no
  `providerStopReason`, only a non-empty one is carried there.
