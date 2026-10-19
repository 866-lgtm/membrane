- `blockBinding`'s doc no longer implies that a request that sends no
  thinking config holds no thinking that binds. On 2026-10-19 Claude Opus 5.5
  and 5, Sonnet 5.5 and 5, and Haiku 5.5 each returned a signed thinking block
  to a request with no thinking config, and the thinking of Opus 5.5, Sonnet
  5.5 and Haiku 5.5 binds: on an account that enforces the binding, a reply
  from them replayed after its tool list changed was refused with a 400 when
  the request carried no thinking config. The doc now says so, and that a
  caller who wants the controls on such a model, in a request that doesn't
  end in an assistant prefill, sets `blockBinding` and asks for adaptive
  thinking (`enabled: true`, `type: 'adaptive'`, and `display: 'omitted'`, so
  the block comes back signature only, as it did with no config), which those
  three accepted with the binding in place of no config. As with any thinking
  config other than `disabled`, the Anthropic adapter then sends none of the
  caller's `temperature` or `topK`, and no `topP` below 0.95; the Bedrock
  adapter sends `temperature` 1 and the caller's `topK`. The doc also says
  that Fable and Mythos carry the binding when an enabled budget can't fit, as
  they do with thinking disabled, and `RoundReport.thinking`'s doc now says
  the provider's report comes back when the request carries the binding. What
  membrane sends is unchanged.
