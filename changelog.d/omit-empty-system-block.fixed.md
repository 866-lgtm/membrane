- The native formatter sends no system block for an empty system prompt. With
  the default `membrane-system` cache markers and no message breakpoint, it
  had wrapped `''` as a cache-marked empty text block, which the API doesn't
  cache. Empty text blocks in a system array are dropped the same way before
  the fallback marker goes on the last block, and an array left empty sends
  no system block.
