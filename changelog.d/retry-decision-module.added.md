- Membrane's retry decision is its own entry, `@animalabs/membrane/retry`,
  for a layer that retries provider calls itself after passing
  `retry: false`. `classifyFailure` names a failure's class (overloaded, rate
  limited, other retryable, a deadline that ran out on a sent request, or
  final). `retryDecision` says whether to retry after a number of tries and
  how long to wait, or hands back a stated wait past its schedule's ceiling.
  `delayFor` gives one wait and its un-jittered step, for a caller that holds
  rather than gives up. Each takes a path's own settings, a schedule per
  class. `membraneRetrySettings(config)` gives membrane's for a retry config,
  and `MEMBRANE_RETRY_SETTINGS` its default. A retry after attempt n (the
  tries made so far) waits `firstDelayMs × multiplier^(n − 1)`, up to
  `maxDelayMs`, and only an overloaded failure's wait is jittered. The entry
  loads no provider SDK. Membrane's own retries now go through it, and for
  every error membrane's adapters build they decide as before. A failure
  another adapter types `rate_limit` that is also overloaded now takes the
  overloaded class's attempts, and a stated wait is read as a number.
  `hooks.onError` is asked after the retry's wait is decided, so a change it
  makes to `error.retryAfterMs` no longer changes the wait.
