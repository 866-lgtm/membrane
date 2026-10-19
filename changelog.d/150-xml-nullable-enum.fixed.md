- XML tool instructions no longer mark a parameter `nullable="true"` when
  its type admits null but an `enum` or `const` beside that type leaves null
  out (#150). Before, a type list naming null, or OpenAPI's `nullable: true`,
  marked the parameter whatever else the schema said, so
  `{type: ["string", "null"], enum: ["a", "b"]}` told the model it could send
  a null the schema doesn't accept. This also applies where such a type sits
  behind a `$ref`, in an `anyOf`, `oneOf` or `allOf` branch, or in a root
  alternative, and where the keyword beside the type that leaves null out is
  a combinator or a `$ref`. A parameter stays marked where some branch or
  alternative still accepts null. The parse is unchanged: a written `null`
  for such a parameter still follows the type. In the same instructions a
  null enum member now prints as `null` (`enum="a,b,null"`); before, it
  printed as an empty item (`enum="a,b,"`).
