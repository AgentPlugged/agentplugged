# PRD checklist

Run before showing the PRD. Fix what fails; what needs the creator is one question or a
`decision` checkpoint.

## Header and identifiers

- Header first: `id: prd`, `kind: prd`, `owner: maya`, `links` naming the brief; no `status`,
  `cost`, `progress`.
- Each identifier defined once, at the start of its line; none renumbered, reused or deleted
  (retired ones stay, marked); no `AD-n` defined; no `<…>` placeholder or unused sample id.
- `npx agentplugged docs check` reports nothing.

## Traceability and quality

- Every requirement serves a need of the brief; every `PU-n` is served by an `EF-n`, and each
  `EF-n` names its journey.
- One sentence, one testable capability, no hidden "and", no vague word without a measure, no
  solution (framework, screen layout, API shape). Each `ENF-n` has a threshold and a measure;
  each `MS-n` names what it validates, one is a counter-metric.
- Every ambiguity has its `decision`; resolved ones are applied and leave no `[open: G-…]`;
  every `[assumption]` is listed; open questions name who answers.

## Judgment of the whole

Answer as a stranger, with the passage: holds, thin or broken (a personal tool is not judged
like a public launch). For an independent verdict, a sub-agent runs `judgment` (skill
`critique-deliverable`), thin and broken only.

- **Thesis.** What the product bets on and for whom, from the text alone.
- **Theater.** What is there for form's sake: a persona nothing serves, an unused term, a target
  nobody can observe.
- **Trade-offs.** What it gives up, and why.
- **Form fit.** Length and sections suit this product.

## Scope and form

- The first release is the narrowest that proves the value; out of scope is explicit.
- Terms used exactly; length follows the stakes; no guidance comment nor generated line left.
