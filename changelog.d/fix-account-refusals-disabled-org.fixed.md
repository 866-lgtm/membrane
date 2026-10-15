- Two more refusals of the account or its credential are typed `auth`, as a
  low credit balance and reached usage limits already were: "This
  organization has been disabled." and "This credential is only authorized
  for use with Claude Code and cannot be used for other API requests."
  Anthropic sends both as a 400. Typed `invalid_request` before, they read
  to callers as something wrong with the request, which no change to the
  request fixes. The text is matched in any provider's own error message,
  as the other two are, so another provider's 400 or 422 that says one of
  these is `auth` too.
