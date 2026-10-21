- System changes: a message holding only `system_change` blocks (`SystemChangeContent`, with
  `removeTools`, `defineTools` and `addSystem`) changes the tools the model is offered and its system
  text from that point on, without editing `tools` or `system`, so the prompt cache before it holds.
  `NativeFormatter` and `AnthropicAdapter` send it as a mid-conversation `role: 'system'` message at the
  first point the API accepts, with the inline-tools beta when it changes tools. A request carrying one
  fails with `MembraneError.systemChangeRefused` set when no point after its place accepts it or the
  formatter or adapter is another, before anything is sent, and when the model takes no mid-conversation
  system message; a formatter that can't carry the request's tools at all refuses first, unflagged. A tool a change defines comes back under its own name when the model calls it. New
  optional members: `ProviderAdapter.sendsSystemChanges` (a decorator must forward it, or requests
  through it are refused) and `PrefillFormatter.rendersSystemChanges`.
