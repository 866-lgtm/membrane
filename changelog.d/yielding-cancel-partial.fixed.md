- A cancelled `streamYielding()` turn keeps what it had (#142). Its `aborted`
  event, whether from `cancel()` or from the caller's `AbortSignal`, now
  carries `partialContent`, `rawAssistantText`, `toolCalls` and `toolResults`,
  as a provider or deadline abort's does and as `stream()`'s aborted response
  does. Before, it carried none of them. Results passed to
  `provideToolResults()` just before the cancel aren't in it: the turn hadn't
  recorded them yet, as it wouldn't have for a provider abort at that moment.
