- `thinking.blockBinding` asks the API what to do with a signed thinking
  block the request sends back when the conversation before it has changed
  since it was minted: `{ prefixMismatchBehavior: 'drop_block' }` removes the
  failing blocks and the request proceeds, and `'error'` fails it with a 400.
  The Anthropic and Bedrock adapters send it as `thinking.block_binding`, with
  the `thinking-binding-controls-2026-08-01` beta, inside the thinking config
  membrane builds: enabled thinking whose budget fits, adaptive thinking, or
  a Fable or Mythos model, whose thinking config is otherwise left out.
  Fable 5 and 5.1 accepted it on 2026-10-10, and with `display` beside it
  on 2026-10-12 (that config carries `display` when it's set). Mythos
  hasn't been tried, and that family has refused thinking configs with a
  400 before, so setting it for a Mythos model may fail every request;
  Bedrock's acceptance of the beta hasn't been tried either. A request with
  no thinking config carries no binding: thinking disabled (Fable and Mythos
  think whatever `enabled` says, so they carry it whenever it's asked for), a
  budget that can't fit under `maxTokens`, or a request the XML or
  completions formatter builds to end in an assistant prefill.
  A `thinking` object passed through `providerParams` replaces membrane's,
  binding included. Unset, nothing is sent, and the account's default
  applies.
- Yielding streams report what the provider did with that thinking:
  `RoundReport.thinking` lists the blocks it dropped (`dropped`) and the
  ones that failed a binding check but were shown anyway, where the check
  isn't enforced (`mismatchAllowed`, read from the API's
  `thinking_mismatch_allowed` entries, which we haven't seen live). Each
  entry gives the provider's reason and its `messages.{i}.content.{j}`
  path, which indexes the request as sent, after membrane's merges and
  injections; where membrane can say, the entry also gives the consumer's
  own coordinates: the message it came from (`message`, `injected` as
  `[batch, index]`, or `round` for an earlier round of the stream) and the
  block's index in it. `ProviderResponse.inputTransformations` carries the
  provider's own report, and a streamed response's raw form now includes
  `input_transformations`.
