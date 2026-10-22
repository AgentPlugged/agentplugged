---
name: split-into-stories
description: Break the approved PRD, architecture and UX into epics and self-contained stories, check coverage and dependencies, then open the breakdown checkpoint. Run by Izzy.
metadata:
  agent: izzy
  phase: build
---
# Split into stories

## Overview

- **Step:** build, as Izzy (`agent: izzy` in every MCP call); no sprint planning.
- **Produces:** `.agentplugged/epics/epic-<n>.md` from `assets/epic.md.tmpl` and
  `.agentplugged/stories/<n>-<s>.md` from `assets/story.md.tmpl`.
- **Reads:** by section (`reading: true`, `docs read @requirements @journeys
  @decisions @screens`), never whole. Short path
  (`full_path` in `journey.skipped`): `spec.md` alone stands for all three, its Stories part is
  the first draft. A prototype without PRD: 3 to 6 stories, one per page, citing the prototype's
  sections instead of requirements.
- **Validation point:** a `document` checkpoint per epic (step 6), one stack.

## Rules

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Write only in `.agentplugged/epics/` and `.agentplugged/stories/`; a gap in the PRD,
  architecture or UX goes back to its owner through the creator.
- Ids: `epic-<n>`, story `<n>-<s>`, in delivery order; a story depends only on earlier ones. Never
  renumber an id the creator has seen: add one, or mark the old `(retired)` in its title.

## Steps

1. **Check that the plan can be cut.** `agent.status` (`working`). Planning and design closed:
   their `phase_end` checkpoints resolved `approved` (`state.get`); a draft is not an input; else say which and who owns it, and stop. A gap that changes the build goes to the
   creator. A needed specialty off in `profile.specialties` is said before you cut; never name an
   inactive developer as owner: Noah asks the creator to turn it on, or `creator` owns the story.
2. **Inventory.** Every active `EF-n`, `ENF-n`, the shaping `AD-n`, each `UX-n` of "Elements to
   build", none dropped.
3. **Epics.** By user value, never by technical layer; each builds on the earlier ones only; the
   architecture's starter comes first. Every active requirement is in an
   epic, or in its `out_of_scope`. Write each from the template (replace every `<…>`; `links`
   only to existing documents). Mention a requirement in backticks
   (`` `EF-1` ``), never as `EF-1 : …` at a line's start (it would define it twice).
4. **Stories**, one epic at a time, from the template, small and observable: each is the
   developer's only reading (the sheet). Header: `owner` an active developer of the specialty,
   `reviewer` `quentin` (or `creator` without a quality agent), `requirements` at least one `EF-n`,
   `ENF-n` or `AD-n`, `budget_usd` the `expected` of its lane in `state.get` `usage.estimates`
   (`standard`, or `fast`), never your own figure (`plan.sprint` refuses three times off). Sections:
   `## Context` (requirements, `AD-n`, `UX-n` by identifier, a section without one as
   `` `prd.md#glossary` ``, dependencies: cite, paste nothing); `## Intent` (why, plain);
   `## Acceptance criteria` ("given, when, then", edges included; a story that builds a screen
   takes that screen's sketch in `ux.md` as a criterion, by region number); `## Screen` (its page
   in `ux-mockups/`, its sketch as `` `ux.md#<anchor>` ``); `## Tests expected`; `## Reuse` (from
   `reference/reusable.md`); `## Out of scope` (and which story does it). Then `npx agentplugged
   docs sheet`: the engine quotes each cited passage in `## Excerpts` with its fingerprint (never
   edit it). Over 300 lines (`STORY_SHEET_TOO_LONG`): cut the story.
5. **Review gate.** `npx agentplugged docs check` until clean (among others `REQ_NOT_COVERED`,
   `STORY_DEPENDENCY_FORWARD`, and `LAUNCH_DOCUMENT_INVALID` with reason `ux_element_uncovered`: a
   `UX-n` in no story). Then: criteria cover the listed requirements; no story speaks of a
   later one's work. Tell the creator the budgets' `basis` (`history`, or `reference` when none is
   measured) as a range (`low` to `high`), the total their sum; never an amount without a basis. Draw each epic's `## Dependency graph`.
6. **Ask.** Commit. For each epic, `checkpoint.open`: `type: document`,
   `risk: medium`, no story, no blocks, a summary (value, stories, graph, coverage, questions), and in `documents` the epic file and each story file by
   path under `.agentplugged/stories/`, with the branch and `git rev-parse HEAD:<path>` (20 at most
   per checkpoint). Only once the checkpoints are open, ask the creator whether the breakdown suits
   them, once. Several epics are one stack (constitution, "Stacks to validate"); one epic:
   `chat.answer`.
7. **Report.** `story.result` (`complete`), assumptions, questions; `agent.status`; hand back to
   Noah, who proposes what comes next; the creator decides.

Once approved, a story's intent is frozen (`docs check` fails if it differs). Never edit one: a
change counts once a new `document` checkpoint with the story at its new blob is approved. A cited
passage changed (`stale_sheets` in `state.next`): `docs sheet <story>`, then that checkpoint again.
