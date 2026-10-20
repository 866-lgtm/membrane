- XML tool instructions now list a parameter's values from more of its
  schema, where before they listed only an `enum` on the first node that
  declares the parameter. An enum behind a `$ref`, as pydantic writes an
  `Enum` field, an `anyOf` of an enum and `{type: "null"}`, as pydantic and
  zod write a nullable enum, enums in `anyOf`, `oneOf` or `allOf` branches,
  enums across root alternatives, and a `const` now render as
  `enum="..."`. Values are listed in schema order, each once, and null only
  where the parameter is marked `nullable="true"`. A nested `oneOf` lists
  only the values exactly one of its branches admits. No list comes from a
  union where a branch, or a root alternative that declares the parameter,
  also takes values outside it, and none is shown where a `$ref` cycles or
  doesn't resolve, or where a listed value is an object or an array. Where
  these rules differ from the first declaring node's own `enum`, the list
  shown before changes: another declaring node can narrow it, values of
  kinds the schema's types exclude are left out, and an empty list renders
  no `enum` attribute. `toolDefinitionForPrompt` returns this list in
  `enum`, each value as a string, as its type says.
