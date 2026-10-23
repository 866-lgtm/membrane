- **Callers that send sampling parameters to a model the list doesn't name:** the Anthropic
  adapter's list of models whose `temperature`, `top_p` and `top_k` it strips now names each model
  by its id. An entry matches that id, or that id followed by anything that doesn't continue its
  version (a digit, or a hyphen and one or two digits, does), such as a dated snapshot. Before, an
  entry such as `claude-mythos-5` matched every id that began with it. So Mythos 5.1, and a later
  version of a listed model such as `claude-opus-5-6`, now get those parameters where they used to
  be dropped, and a model that refuses them answers with a 400. Stop sending them to an unlisted
  model, or wait for a release that lists it. Through `Membrane`, a request's config already loses
  them for every Fable and Mythos id, by family name, so for those ids this reaches only what a
  caller sends in `providerParams`, or a caller of the adapter itself. Fable 5.1 and Sonnet 5.5,
  which the old entries covered, are listed on measurements: on 2026-10-23, with no thinking
  config, each refused `temperature` 0.2 and `top_k` 40 with a 400, and Fable 5.1 a `top_p` of
  0.9, which Sonnet 5.5 refused on 2026-10-19.
