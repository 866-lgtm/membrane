- XML tool instructions mark a parameter `nullable="true"` only when an
  `enum` or `const` beside its type admits null too (#150). Before, a type
  list naming null, or OpenAPI's `nullable: true`, marked the parameter on
  its own, so `{type: ["string", "null"], enum: ["a", "b"]}` told the model it
  could send a null the schema doesn't accept. The parse is unchanged: a
  written `null` for such a parameter still follows the type. In the same
  instructions a null enum member now prints as `null` (`enum="a,b,null"`);
  before, it printed as an empty item (`enum="a,b,"`).
