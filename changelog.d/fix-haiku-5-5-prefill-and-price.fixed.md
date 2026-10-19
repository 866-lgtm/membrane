- Claude Haiku 5.5 (`claude-haiku-5-5`) is listed as refusing an assistant
  prefill, so a build that ends in one for it fails in membrane, with the
  typed error that names native tool mode, rather than at the API. The
  Messages API answered such a request with a 400, with no thinking config
  and with an adaptive or an enabled one: "This model does not support
  assistant message prefill. The conversation must end with a user message."
- The default pricing table gives Claude Opus 5.5, Sonnet 5.5, Fable 5.1,
  Mythos 5.1, Mythos 5 and Haiku 5.5 the rates Anthropic's price page lists
  on 2026-10-19. Opus 5.5, Sonnet 5.5 and Fable 5.1 had matched their
  family's shorter prefix and taken its rate: Opus 5.5 $5/$25, $6.25 for a
  5-minute write and $0.50 for a cache hit, where the page gives $4/$20, $5
  and $0.20; Sonnet 5.5's hits $0.20 for $0.10; Fable 5.1's $1 for $0.25.
  Mythos 5 and 5.1 and Haiku 5.5 had no rate. So where no `ModelRegistry`
  supplies pricing, a response's `usage.estimatedCost` falls for Opus 5.5
  and for those cache hits, and Haiku 5.5, Mythos 5 and Mythos 5.1 responses
  carry a cost instead of the unpriced warning. Haiku 5.5 takes its rate for
  prompts up to 100,000 tokens, since the table has no field for the higher
  rate above that, so a longer prompt is priced low. Every Anthropic row the
  page lists is dated 2026-10-19, which callers see as `pricingAsOf`.
