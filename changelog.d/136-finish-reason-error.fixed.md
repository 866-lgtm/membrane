- `openrouter`, `openai`, `openai-compatible` and `openai-completions` fail the
  call when the provider reports an error inside an HTTP 200, streamed or not
  (#136): an `error` object, at the top level or on the first choice,
  whatever the finish reason, or a first choice that ends with
  `finish_reason: "error"`.
  - A response whose first choice ends with `finish_reason: "error"` was an
    `end_turn` holding the partial text, with the token disclosed as
    `details.stop.providerReason` and logged once. It now throws. An `error`
    object on that choice classifies the error, as a top-level one does; that
    is how OpenRouter documents a non-streaming generation that failed
    partway. With no `error` object at all, it is a `MembraneError` of type
    `server`, retryable, with `httpStatus` 500, as OpenRouter's documented
    mid-stream `server_error` is. `complete()` retries it when `maxRetries`
    allows another attempt, as it does any retryable error, and a retry layer
    above membrane that reads `retryable` will send the request again too.
  - A non-streaming 200 whose body is only an `error` object threw
    `Cannot read properties of undefined (reading '0')`, typed `unknown` and
    not retryable. It now throws the error a stream frame carrying that
    object gives, classified from its code or status. OpenRouter's documented
    `server_error` is a retryable server error, so `complete()` retries it
    when `maxRetries` allows another attempt.
  - A non-streaming 200 with an `error` object beside its choices returned
    the choices' content, and a stream chunk with an `error` object on its
    choice was read as an ordinary chunk. Both now throw, as a chunk with a
    top-level `error` object already did.
  - A stream chunk with a top-level `error` object, OpenRouter's documented
    mid-stream failure, already threw, classified by that object, and still
    does.
