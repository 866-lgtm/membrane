- The Anthropic adapter leaves `temperature`, `top_p` and `top_k` out of a
  request to Claude Haiku 5.5 (`claude-haiku-5-5`), as it already does for
  the other models that refuse them. With no thinking config, the Messages
  API refused `temperature` 0.2, `top_k` 40, and `top_p` 0.9 and 0.95 with
  a 400 ("`temperature` is deprecated for this model", and likewise for the
  others). A `top_p` of 0.99, which Haiku 5.5 accepted, is left out too, as
  for the other listed models.
