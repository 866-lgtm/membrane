- `gemini` reads a `null` `blockReason` as no block, and a candidate whose
  content and finish reason are `null` or absent as no candidate, on both
  paths. Gemini's API speaks proto3's JSON mapping, where a `null` field is
  unset.
  - A non-streamed response with no candidates and a `null` `blockReason` was
    a `refusal`. It's now an empty `end_turn`.
  - A stream whose frames give only a `null` `blockReason` was a `refusal`. It
    now fails as a stream with nothing in it does, with membrane's retryable
    error for a stream that ended before a terminal event, so membrane can
    send the request again.
  - A later stream frame with a `null` `blockReason` replaced the reason an
    earlier frame gave, so the stop carried no provider reason. The earlier
    reason now stands, and the stop's provider reason carries it.
  - Beside a blocked prompt, a candidate with no data failed a stream as one
    cut short where its content or finish reason was `null`, and read as an
    empty `end_turn` in a non-streamed response. It's now a `refusal` on both
    paths, with the block's reason as the provider reason, as a block with no
    candidates is. A candidate with content or a finish reason still wins over
    a block, as before.
