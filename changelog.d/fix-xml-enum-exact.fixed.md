- XML tool instructions no longer print an `enum` list the model can't split
  exactly (#176). Where any of a parameter's values holds `"`, `,`, a control
  character (a line break or a tab among them), a line or paragraph
  separator or a lone surrogate, or is empty, or has whitespace at either
  end, the parameter's line shows no `enum` at all, and keeps its type and
  description. Every other list prints as before, unescaped, since the
  parser doesn't decode entities in a value the model writes.
  `toolDefinitionForPrompt` still returns every value.
