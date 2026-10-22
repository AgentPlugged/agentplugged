# Self-check of the architecture

With the document open, a "no" is fixed before handing over, or written as an open question.

## Header and decisions

- Header: `id`, `kind: architecture`, `owner: alex`, `links` to the PRD and UX; no status, cost or
  progress. Every decision is `### AD-n — <title>`, none renumbered, retired ones in place with
  `(retired)` first.
- Every active decision states **Binds**, **Prevents** and **Rule**. Would two developers building
  apart really diverge without it? If not, move it to Deferred.
- A reviewer can check a diff against each rule ("only the `billing` module writes invoices", not
  "keep the code clean"). No decision contradicts another, the PRD or the UX.
- A plain "no dependency" or "never import" rule carries a `Guard` line (`references/guard.md`).

## Coverage

- Every requirement needing a technical answer (`ENF-n` above all) has a decision, a convention,
  a part of the diagram, or an open question; every UX flow can be built with these units.
- Runtime, data (which unit owns and writes each entity), interfaces, security, deployment,
  operations, test seams: each decided, deferred or open.
- Could two developers obey every decision to the letter and still build parts that do not fit?
  For a high-stakes architecture, a sub-agent runs the method `divergence` (skill
  `critique-deliverable`).

## Stack and form

- Every technology is in the Stack table, its version checked (source and date) or `to verify`
  and listed under Open questions; none past or near end of life.
- No template comment left; empty sections removed (except Deferred and Open questions); valid
  mermaid. `npx agentplugged docs check` reports nothing.
