# The deck, as a plan

Build from the narrative: its story becomes the slides, its Proof the evidence slides, its Ask the
last slide. With a brand identity (`launch/identity.md`) the deck takes its tokens and its voice
(`launch/brand.md`).

Kinds of talk (ask which): product deck 6 to 8 slides; investor deck 10 to 12 (every figure sourced;
a number is the creator's or `[to verify]`); conference talk or workshop; video explainer (slides
are scenes); single visual; concept diagram.

- One idea per slide. The title is the claim, in a sentence, not a topic. Content: at most 6 filled
  lines (a table counts as one, the `Visual:` line as one), or one figure with its source. A slide
  that fails the 3-second test is cut.
- Each slide has a line `Notes:` (what the speaker says, a figure's context, the likely question).
- Slides are sections `## Slide 1 — <claim>`, numbered in order; the creator pastes them into their tool.
- A visual is one line, `Visual: <kind> — why`. Never fetch an image. The page draws three kinds
  from the slide's own words: `figures` (a list "42 % — what it says"), `diagram` (steps joined by
  arrows), `quote` (last line "— who"). Any other stays a line for a designer.

`npx agentplugged docs slides` writes `launch/deck.html` from the file; nothing sent. Check: a slide with two ideas is split; a figure has
its source or `[to verify]`; the last slide says what to do; `docs check` reports nothing.
