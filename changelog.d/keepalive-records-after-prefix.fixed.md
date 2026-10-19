- The Anthropic adapter's cache keepalive now holds a request only once the
  provider has started its message: at `message_start` in a stream, and once
  the response arrives in `complete()`. It recorded each request before
  sending it, so a call that then failed, never delivered or refused, left
  its request to be replayed every 45 minutes for up to a day, though the
  provider had cached nothing. A refused request's replays were refused too,
  and three refresh failures in a row turn the keepalive off for every
  lineage for the rest of the adapter's life. Now a call that fails before
  its message starts leaves its lineage's earlier snapshot, and the day
  measured from it, as they were. One cost: a call no longer marks its
  lineage touched until its message starts, so a refresh that falls due
  while the call waits for its first event can replay the earlier snapshot
  once.
