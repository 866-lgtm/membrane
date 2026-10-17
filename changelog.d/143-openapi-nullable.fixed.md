- XML tool mode reads OpenAPI 3.0's `nullable: true` beside a parameter's
  `type` as it reads a type list naming `null` (#143). Before,
  `{type: "string", nullable: true}` read as a plain string. A written
  `null` reached the tool as the text `"null"`, and the tool instructions
  didn't mark the parameter `nullable="true"`. For any other type the null
  arrived, with a warning that it wasn't the declared type. Only
  `nullable: true` itself counts, and only beside a `type`. Membrane doesn't
  consult a sibling `enum` or `const`, as for any `type`.
- The tool instructions now mark `nullable="true"` on a declaration membrane
  can read but can't give one type, when it admits null. Examples are a type
  list such as `["string", "number", "null"]`, `nullable: true` beside such
  a list, and an `anyOf` of several types with a null branch. Such a
  parameter still parses by the legacy guess, which already read a written
  `null` as null.
- The first request after upgrading carries the changed instructions for
  every tool with such a parameter, so a provider's prompt cache misses from
  those instructions on, once.
