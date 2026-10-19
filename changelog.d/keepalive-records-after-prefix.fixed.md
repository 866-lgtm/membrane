- The Anthropic adapter's cache keepalive now holds a request only once the
  provider is known to have started its message: at `message_start` in a
  stream, and once the SDK has the response in `complete()`. It recorded
  each request before sending it, so a call that then failed, never
  delivered or refused, left its request to be replayed every 45 minutes for
  up to a day, though the provider wasn't known to have cached it, and the
  request before it, which the provider had cached, was no longer held. A
  request refused for what its prefix holds, such as a prompt longer than
  the model's context, had its replays refused too, and three refresh
  failures in a row turn the keepalive off for every lineage for the rest of
  the adapter's life. Now a call that fails before its message starts leaves
  its lineage's earlier snapshot, and the day measured from it, as they
  were. One cost: a call no longer marks its lineage touched until its
  message starts, so a refresh can fall due while the call waits for its
  first event and replay the earlier snapshot, once per 45 minutes of that
  wait. In `complete()`, where the keepalive is opt-in, the wait is the
  whole call. A refresh now acts only on the snapshot it replayed. While a
  replay was out, a real call could record a newer request for its lineage,
  which a second ineffective refresh in a row then dropped, and a tick could
  go on to replay a snapshot that a real call had replaced since the tick
  began.
