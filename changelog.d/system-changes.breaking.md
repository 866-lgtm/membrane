- **TypeScript consumers:** `ContentBlock` gains `SystemChangeContent` (`type: 'system_change'`), and
  `ProviderMessage.role` gains `'system'`. Code that reads a property only some members declare, or that
  checks a switch over either for exhaustiveness, fails to type-check until it handles the new member.
  The type change itself changes nothing at run time.
