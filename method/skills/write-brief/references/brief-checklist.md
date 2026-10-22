# Brief checklist

Run before showing the brief. Fix what fails; what needs the creator is one question.

## Header and form

- Header first: `id: brief`, `kind: brief`, `owner: iris`, `links` naming only existing notes; no
  `status`, `cost`, `progress`. `npx agentplugged docs check` reports nothing.
- One to two pages; no identifier defined (`EF`, `ENF`, `PU`, `MS` belong to the PRD); no padded
  section (one line says it does not apply); no `<…>` placeholder, guidance comment or generated
  line; no `[open: G-…]` left for a decision already answered.
- Each research note follows `assets/research-note-template.md` (`research-<topic>`,
  `kind: note`, `owner: iris`, sources named).
- Written in the creator's language, readable without this skill.

## Substance

- The problem is one sentence, in the creator's words, naming who has it; it comes before the
  solution.
- Each user group has a job to get done and a workaround. The value is an outcome users would
  notice, not a feature list.
- Every figure, quote and market claim names its source or carries `[assumption]`; the riskiest
  assumption is first and has a test.
- The scope says what is out as clearly as what is in, and what is open; success signals can be
  observed from outside; open questions are real unknowns, not tasks.
