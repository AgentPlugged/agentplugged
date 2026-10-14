# The deck, as a plan

Build from the narrative: its story becomes the slides, its Proof the evidence slides, its Ask the
last slide. Length and shape by kind of talk: `deck-types.md`.

- With a brand identity (`launch/identity.md`), the deck takes its tokens and its voice (`launch/brand.md`).
- One idea per slide. The title is the claim, in a sentence ("Makers lose a week to rework"), not a
  topic. Content: at most 6 filled lines (a table counts as one, the `Visual:` line as one), or one figure with its source.
- The 3-second test: can a viewer take the idea in three seconds? Else cut. Every slide has a job:
  inform, persuade, or move on; otherwise it goes.
- Each slide has a line `Notes:` with what the speaker says: the story, the context of a figure, the
  likely question and its answer. Notes carry the detail, the slide stays light.
- Slides are sections `## Slide 1 — <claim>`, numbered in order. Markdown is the export: a section is
  a slide, the `Notes:` line its notes; the creator pastes them into the tool they use.
- A visual is one line, `Visual: <kind> — why`. Never fetch an image. The page draws three kinds from the slide's own
  words: `figures` (a list "42 % — what it says"), `diagram` (a list of steps, joined by arrows), `quote` (a
  quote, last line "— who"). Any other visual stays a line for a designer (Julien's `VI`).
- One visual language for the whole deck: the identity of `ux.md` when it exists.

Drawn: `npx agentplugged docs slides` writes `launch/deck.html` from the file, same text: one slide per screen, arrows or
space to move, N notes, T light or dark, F full screen, print for a PDF. Nothing to install, nothing sent.

Check: a slide with two ideas is split; a figure has its source or `[to verify]`; the last slide says
what to do; `docs check` reports nothing.
