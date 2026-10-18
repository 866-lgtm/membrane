- `gemini` reads a `null` `blockReason` as no block, and a candidate whose
  content and finish reason are `null` or absent as no candidate, on both
  paths. Gemini's API speaks proto3's JSON mapping, where a `null` field is
  unset.
  - A non-streamed response with no candidates and a `null` `blockReason` was
    a `refusal`. It's now an empty `end_turn`.
  - A stream whose frames give only a `null` `blockReason` was a `refusal`. It
    now fails as a stream that ended before a terminal event, as a stream
    with nothing in it does.
  - A later stream frame with a `null` `blockReason` replaced the reason an
    earlier frame gave, so the stop carried no provider reason. The earlier
    reason now stands, and the stop's provider reason carries it.
  - Beside a blocked prompt, a candidate with a `null` finish reason failed a
    stream as one cut short, and a non-streamed candidate with no data (`{}`,
    or one whose fields are `null`) read as an empty `end_turn`. Both are now
    a `refusal` with the block's reason as the provider reason, as a block
    with no candidates is.
