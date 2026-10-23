- The Anthropic adapter strips `temperature`, `top_k` and `top_p` for Claude Opus 5 and Opus 5.5
  (`claude-opus-5`, which covers both and their dated snapshots), as it does for the other models
  that refuse them. With no thinking config, both refused `temperature` 0.2, `top_k` 40 and
  `top_p` 0.9 with a 400 ("… is deprecated for this model"), so a caller's sampling setting
  failed the whole request. As for the other listed models, every `top_p` is stripped, with a
  thinking config or without one: 0.99 too, which both accept with no thinking config, and a
  `top_p` of 0.95 or more under thinking, which the adapter used to pass.
