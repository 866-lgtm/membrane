- **Callers without a retry layer of their own:** `retry.maxRetries` now
  defaults to 3 (it was 0). A 5xx, a provider's 408 or a connection failure
  before anything was delivered gets three sends on the base schedule, with
  waits of 1 and 2 seconds, on every adapter. On `AnthropicAdapter` those three
  sends were already made, inside its SDK client, and are now membrane's,
  counted in `details.timing.attempts` and cancellable; on the other adapters
  it was one send.
  - **Migration:** none, to keep a call working. `retry: { maxRetries: 1 }`
    keeps one send for these errors, and `retry: false` on a call turns off
    every retry membrane would make on it.
  - **Siblings:** context-manager 0.17.1 depends on `^0.6.0`, which admits a
    0.6.x patch, and calls `complete()` without `retry`, under a backoff of its
    own. agent-framework 0.23.1 and connectome-host 0.10.2 depend on
    `^0.5.87`, which admits no 0.6.x. Released as a minor, this reaches each
    sibling when it raises its range.
  - **Unchanged:** what a call whose first send succeeds sends and returns. A
    call that has delivered anything is never sent again.
- **Callers with a retry layer of their own,** such as a framework that
  retries its turns under a policy of its own: pass `retry: false` on each
  call. Otherwise membrane's schedules run inside each of your attempts, up to
  seven sends of a 529 over five to ten minutes, and a stated wait of up to a
  minute is spent inside membrane, out of your layer's sight.
  - **Migration:** `retry: false` on `complete()`, `stream()` or
    `streamYielding()`. A failure then reaches you after one send, as it came,
    with `retryable` and any stated wait on `retryAfterMs`. Two sends stay: a
    refusal re-issue you ask for with `refusalRetries`, and a credential
    resolver's one resend after a 401.
  - **Siblings:** agent-framework retries its turns so, and its range
    (`^0.5.87`) admits no 0.6.x.
  - **Unchanged:** the error your layer receives, and how it is classified.
- **`hooks.onError` users:** it is now asked before each retry on
  `streamYielding()` too, and on every entry point its `attempt` counts the
  attempts at the failing request since its last refusal re-issue, the count
  the retry budget reads. It used to count every pass of the whole call,
  refusal re-issues included, so after a re-issue it now starts again from 1.
  - **Migration:** a hook that told the call's passes apart by `attempt`
    counts them itself.
  - **Siblings:** none of the three sets `hooks.onError`.
  - **Unchanged:** returning `'abort'` ends the call with the error.
- **`AnthropicAdapter` callers who relied on its SDK client's retries of a
  connect timeout:** a connect timeout now reaches you after one send, as a
  retryable `timeout`, where the SDK sent it three times. The SDK reports a
  connect timeout the same way as a timeout on a request already sent, which
  membrane doesn't spend another deadline on.
  - **Migration:** retry a `timeout` yourself where a stalled connect is likely.
  - **Siblings:** context-manager's `^0.6.0` admits a 0.6.x patch;
    agent-framework's and connectome-host's `^0.5.87` admit no 0.6.x.
  - **Unchanged:** on the other adapters, on Node, a connect timeout is
    retried like any connection failure.
- **Callers who relied on the 429 floor's five attempts:** an error whose
  stated wait (`retry-after`) is longer than a minute, or than its schedule's
  `maxRetryDelayMs` where that's longer, now reaches you at once, with the
  stated wait on `retryAfterMs`. Before, membrane waited only its own cap and
  sent the call again inside the window the provider had named, and
  `AnthropicAdapter`'s SDK client sent it again after its own short backoff. A
  stated wait of up to a minute is waited out, as the SDK waited out one under
  a minute, though the base schedule's own backoff stops at 30 seconds.
  - **Migration:** pace on `retryAfterMs`, or raise `retry.maxRetryDelayMs`
    to have longer stated waits waited out.
  - **Siblings:** context-manager's `^0.6.0` admits a 0.6.x patch;
    agent-framework's and connectome-host's `^0.5.87` admit no 0.6.x.
  - **Unchanged:** a 429 that states no wait still gets five attempts.
- **Callers who build the `retry` config:** a field that isn't a finite number
  of at least 0 is now refused when the `Membrane` is constructed, with a
  `RangeError` naming the field (a `TypeError` for a value that isn't a
  number). A field given as `undefined` takes its default. Before, an explicit
  `undefined` replaced the default, and `undefined` or `NaN` as `maxRetries`
  meant no retries at all.
  - **Migration:** pass a number, or leave the field out.
  - **Siblings:** connectome-host, which builds the `Membrane` its agents use,
    already refuses a recipe's `agent.retry` by the same rule, so no recipe it
    loads today is refused here.
  - **Unchanged:** a config whose fields are numbers of at least 0, or absent.
