- The built-in pricing table now prices Gemini's current models (#121).
  `gemini-4-argon`, `gemini-3.8-flash`, `gemini-3.6-flash`,
  `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite` and
  `gemini-3-flash-preview` had no row, so their `estimatedCost` was omitted.
  A rate Google publishes with the date it changes is kept with that date, and
  the estimate follows the date a call is priced on, with no membrane upgrade:
  `gemini-4-argon` is priced at 2/10 per million tokens through November 30,
  2026 and 4/20 from December 1, and the 3.6 and 3.8 Flash models at 0.75/3.75
  through December 31, 2026 and 1.50/7.50 from January 1, 2027. Google names
  no time zone, so each change is taken to start at midnight US Pacific time.
- `gemini-3.5-flash` and `gemini-3.7-flash`, whose requests Google now routes
  to `gemini-3.6-flash` and `gemini-3.8-flash`, are priced at those models'
  rates. `gemini-3.5-flash` was priced at 1.50/9, its rate before it was
  deprecated.
