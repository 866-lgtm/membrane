- `hooks.onError` is asked after a retry's wait is decided, so a change it
  makes to `error.retryAfterMs` no longer changes the wait. Its documented
  contract, `'retry'` or `'abort'`, is unchanged.
- A failure typed `rate_limit` that is also overloaded (a 529, or no status
  and `529` or `overloaded_error` in its message), which only another
  adapter's error can be, gets the overloaded attempt count, seven by
  default, or with `overloaded.maxRetries: 0` the base count, where it got
  the rate limit's five.
- A provider's stated wait is read as a number: one that isn't a number
  counts as none, where it gave a wait that ran at once.
