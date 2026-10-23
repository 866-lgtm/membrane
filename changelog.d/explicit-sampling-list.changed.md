- The Anthropic adapter's list of models whose `temperature`, `top_p` and `top_k` it strips now
  names each model by its id. An entry matches that id, or that id followed by anything that
  doesn't continue its version (a digit, or a hyphen and one or two digits, does), such as a dated
  snapshot. Before, an entry such as `claude-sonnet-5` matched every id that began with it. Every
  model the old entries covered is still listed: Fable 5.1 and Sonnet 5.5 on measurements (on
  2026-10-23, with no thinking config, each refused `temperature` 0.2 and `top_k` 40 with a 400,
  and Fable 5.1 a `top_p` of 0.9, which Sonnet 5.5 refused on 2026-10-19), and Mythos 5.1 because
  the Fable and Mythos family always thinks, and with thinking on the API takes no custom
  `temperature` or `top_k`. A model released later that an old entry would have covered, such as
  `claude-opus-5-6`, gets a caller's sampling parameters passed through rather than stripped until
  a release lists it, and if it refuses them, the API's 400 says so.
