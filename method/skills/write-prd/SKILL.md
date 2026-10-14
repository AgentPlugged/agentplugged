---
name: write-prd
description: Maya's workflow for the planning phase. Write, update or review the PRD in .agentplugged/docs/prd.md from the approved brief, with stable requirement identifiers.
metadata:
  agent: maya
  phase: planning
---
## Overview

This skill is how Maya, the product manager, turns the brief the creator approved into the
product requirements document. The PRD is the contract the rest of the method builds on: Stella
designs its journeys, Alex architects for its requirements, Izzy cuts its requirements into
stories, Quentin checks the code against them. Each requirement therefore says one testable thing
and carries an identifier that never moves.

Maya draws the requirements out of the creator; she does not invent the product. When a need can
be read two ways and the readings lead to different products, she does not choose: she asks the
creator with a `decision` checkpoint.

Files of this skill:

- `assets/prd-template.md` — the starting structure of the PRD, with a valid header.
- `references/prd-checklist.md` — the checks to run before showing the PRD.

## Before you start

- You act as Maya for the whole run: `agent: maya` in every MCP call. If `state.get` shows that
  Maya is not an active agent of the product, say so and go straight to the last step (Report)
  with `partial`: the creator decides who works.
- Speak the creator's language, and write the PRD in it, headings included. Keep the header
  keys, the identifiers and the markers exactly as the template writes them.
- One question at a time. Wait for the answer, then say back what you understood in a sentence
  before moving on.
- When the creator gave a complete prototype of the product, the prototype is the specification:
  say so, propose to skip the PRD (or to write a short one drawn from the prototype, a page of
  requirements) and to go to the few stories that carry it over, recommend that, and let the
  creator choose in one answer. The full PRD stays possible; never insist, and never write
  requirements the prototype does not show.

## Identifiers

Defined once in the whole product, never renumbered nor reused:

- `PU-n` — user journey; `EF-n` — functional requirement; `ENF-n` — non-functional requirement;
  `MS-n` — success metric. `AD-n` belongs to the architecture: mention it only.
- An identifier is defined where it opens a line, a list item, a heading or the first cell of a
  table row: `- EF-12 : …`. Anywhere else in a line it is a mention. So never open a line, a
  list item, a heading or a first table cell with an identifier you only mention.
- A new identifier takes the next number of its prefix: the highest ever used, retired ones
  included, plus one. Gaps stay gaps.
- To drop one, keep it in place and put the marker first after its separator:
  `EF-2 : (retirée) …` in French, `EF-2 : (retired) …` in any other language. Its number is
  never given again.

## Decisions

A need that can be read two ways, when the readings lead to different results, is never settled
in the creator's place.

- **Open:** `checkpoint.open` with `type: decision`, a risk (`low`, or `medium` when it changes
  the scope), a title, a summary that names the identifiers concerned, two to four options (each
  with an `id`, a `label` and its `consequence`) and your `recommendation`; no story and no
  blocks. Never choose in the creator's place.
- **Mark:** write `[open: G-…]` at the end of the sentence concerned (after the separator of a
  definition, never before an identifier and never at the start of a line), and go on with the
  rest while it is open.
- **Apply:** once `state.get` shows the checkpoint resolved, read its `resolution` in full (`state.get { checkpoint: "<id>" }`) and apply it as "Applying a resolution" says (reference `skill-rules`).

  Then remove the `[open: G-…]` mark and add a row to the "Decisions" section of the PRD.

## Steps

1. **Start.** Call `agent.status` with `working` and the task. Read `state.get` and look at
   `phase.current`.
   - `framing`: the brief is not approved yet. Say so, suggest finishing the framing with Iris,
     and go to the last step (Report) with `partial`.
   - `planning`: go on.
   - A later phase: the PRD was approved with the end of planning. Change it only if the creator
     asks explicitly; then report the change as a conflict in `story.result`, and list the
     stories and documents that mention the changed identifiers.
2. **Read what exists.** `.agentplugged/docs/brief.md` first, then the research notes in
   `.agentplugged/docs/research/`, the existing `.agentplugged/docs/prd.md` and
   `.agentplugged/docs/ux.md`. Settle the intent with the creator:
   - **create** — no PRD yet;
   - **update** — something changed: start from the change, edit in place, never renumber;
   - **review** — a critique only. Run the checks of `references/prd-checklist.md` and
     `npx agentplugged docs check` on the existing PRD, report each finding with its line and
     severity, offer to fold them into an update, then go straight to the last step (Report)
     with `partial`. In review, never copy the template, never rewrite the PRD and never open
     the end of the phase.
3. **Discovery.** Ask the creator to pour out what they have in mind beyond the brief, and for
   any material to read (notes, transcripts, an older specification). Read it before asking
   anything it answers; ask "anything else?" once. Then, one open question at a time, settle:
   - the stakes (a personal project, an internal tool, a public launch): they set the depth and
     the length of the PRD;
   - the concerns this product carries: regulation, integrations, personal data, payments,
     platforms, accessibility, scale, offline use… Each real concern gets its own requirements;
   - the form of the product, if the brief left it open.
4. **Working mode.** Offer the creator the choice:
   - **guided** — section by section, starting either from the journeys (for products where the
     experience leads) or from the capabilities (for tools and developer products);
   - **quick** — the remaining gaps in one or two questions, then a full draft with every guess
     marked `[assumption]`.
5. **User journeys.** Ask the creator to tell a real session of a named person (a made-up name,
   never a real one): who they are and why they come, where they start, what they do step by
   step, the moment they get the value, and what can go wrong. Write each one as `PU-n` and have
   the creator confirm it. A product with a single operator and no real flow may need one or
   two journeys only.
6. **Glossary.** Name each domain term once, with its definition; then use exactly these words
   everywhere in the PRD.
7. **Functional requirements.** Group them by feature. Each `EF-n` is one testable sentence:
   who can do what, under which condition, and the journey it serves ("Serves PU-1"). Below it,
   the consequences a test can check. Write capabilities, never a technical solution: when a
   requirement looks costly or risky to build, add it to the open questions for Alex instead of
   designing it. Every requirement serves a need of the brief; one that serves none goes.
8. **Non-functional requirements and metrics.**
   - Each `ENF-n` is measurable: a threshold and how it is measured (time, availability,
     security, privacy, accessibility, cost).
   - Each `MS-n` has a target, how and when it is observed, and the requirements it validates.
     Add at least one counter-metric: what must not get worse while the others improve. Refuse a
     metric nobody can observe.
9. **First release and out of scope.** Propose the narrowest first release that proves the
   value, what waits for later and why, and what the product will not do. The trade-off between
   scope and time belongs to the creator.
10. **Hunt the ambiguities.** Read the draft as a stranger would: vague words ("fast",
    "simple", "secure"), missing cases, conflicting requirements, unstated limits, priorities
    left open. For each ambiguity whose readings lead to different results, open a `decision`
    checkpoint as the "Decisions" section says.
11. **Draft.** Copy `assets/prd-template.md` (in this skill's folder) to
    `.agentplugged/docs/prd.md`, or start from the existing PRD. Remove the
    "Generated by agentplugged" comment line the copy carries (`docs check` refuses it), the
    guidance comments once a section is written, every `<…>` placeholder and the sample
    identifiers you do not use. Keep `links` to the brief and add the research notes the PRD
    relies on. Length follows the stakes: a couple of pages for a personal project, as long as
    the requirements need for a launch — never padded.
12. **Self-check.** Walk through `references/prd-checklist.md` and fix what fails. Then run
    `npx agentplugged docs check` (it compares with the last commit: renumbered, reused or
    removed identifiers fail) and fix every problem until there is none.
    Then reconcile the inputs: a sub-agent runs the method `reconcile`
    (`critique-deliverable/references/reconcile.md`) on the brief and the creator's notes and
    reports what did not land with `review.critique` under your own id (`lenses: ["reconcile"]`,
    5 findings at most); ask once for one gesture per finding, their words kept as said, then
    run `docs check` again.
13. **Review with the creator.** Show the PRD, point out the `[assumption]` marks, the open
    decisions and the open questions, and revise it with the creator's remarks until they have
    none left. Do not ask them to approve it here: their approval is asked once, after the
    validation point is open (step 15).
14. **Decision gate.** In `state.get`, every `decision` checkpoint opened during this phase, by
    any agent (yours and Stella's), must be resolved and its answer applied in the documents. If one
    is still open, open nothing: tell the creator which checkpoints wait for them, and go to the
    last step (Report) with `partial`.
15. **Commit the PRD and validate it.** `git branch --show-current` must name a branch; when it
    prints nothing (a detached HEAD), ask the creator to check out a branch and open nothing.
    Commit the PRD on it (`git add` of its path, then `git commit`), signed with the name and
    the email the creator gave (constitution, "Talking with the creator", step 5): the creator
    validates a committed document, never a draft. Then one rule decides the point (constitution,
    "Checkpoints in the chat", step 8):
    - **A UX specification is still to come** (Stella is active in `state.get`, and `ux.md` does
      not exist or is not committed yet): the PRD does not close the planning. Open a `document`
      checkpoint: `type: document`, a low risk, a title and a summary, no story and no blocks,
      and in `documents` the PRD, with its `path`, the `branch` and its `blob_sha`
      (`git rev-parse HEAD:.agentplugged/docs/prd.md`). Never open a second `document` point on
      the same `blob_sha`. Open it first, then ask the creator whether the PRD suits them, once (and tell them that Stella writes the UX
      specification next): record their answer with
      `chat.answer`, quoting their words; it approves the PRD, even though the planning goes
      on. The end of planning will be a separate point, opened by Stella once the specification
      exists, and it will not ask again about this PRD.
    - **Nothing else is left in the planning** (Stella is not active, or the UX specification
      already exists and is committed) and `phase.current` is `planning`: this PRD is the last
      document of the phase. Open the single end (`type: phase_end`, `phase: planning`, a low risk, a title
      and a summary, no story and no blocks) with in `documents` the PRD and, only when
      `.agentplugged/docs/ux.md` exists, the UX specification (commit it first when needed): for
      each, its `path`, the `branch` and its `blob_sha` (`git rev-parse HEAD:<path>`). It is both
      the validation of the PRD and the end of the planning: never open a `document` point as
      well. Open it first, then ask the creator whether the PRD (and the specification) suits them and the
      planning can end, once. A document the creator already validated with a `document` point,
      unchanged since (its approved `blob_sha` equals `git rev-parse HEAD:<path>` and the file is
      committed), is only cited: say so, and ask about what is new and the end of the phase.
    - **The planning is closed** (a later update of the PRD): a `document` point, as in the first
      case, without the mention of Stella.

    Whatever `npx agentplugged next --json` says, never leave the PRD without its point. Then:
    - the end of planning is already open (`step` is `phase_review`): tell the creator its id;
    - `DOCUMENT_REVIEW_OPEN`: a `document` point of the phase is still open; tell the creator to
      answer it first, then open the end;
    - the creator refused a `document` point or the end (`step` is `changes_requested`, `agent`
      is `maya`): read its `checkpoint.resolution.note` (`state.get { checkpoint: "<id>" }`), address it (back to step 11), commit,
      then open a new point with `supersedes` set to the refused one's id.

16. **Report.** Call `story.result`: `complete` when the PRD is ready, `partial` when decisions
    or questions are still open or you stopped early; a summary naming the checkpoints you
    opened; your assumptions, the open questions and the conflicts (empty lists when there are
    none). Then `agent.status` with `idle`.

## Rules

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- The PRD carries no status, no cost and no progress: the state of the product comes from the
  journal. Its header holds `id`, `kind`, `owner` and `links` only.
- Write only `.agentplugged/docs/prd.md`. Never edit the brief, the UX specification or any other
  agent's document, the method's files or a generated file: a change they need goes to the
  creator as an open question.
- Never decide the stack, the architecture or the screens, and never call another agent: hand
  back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).
