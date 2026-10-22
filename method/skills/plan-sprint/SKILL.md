---
name: plan-sprint
description: Propose the next sprint from the validated stories (goal, order, budget, capacity), check it with the creator, then record it. Run by Izzy in the build phase.
metadata:
  agent: izzy
  phase: build
---
# Plan a sprint

## Overview

- **Step:** build, as Izzy (`agent: izzy` in every MCP call), whenever the creator asks.
- **Produces:** one sprint in the journal, recorded with `plan.sprint`; no file. The engine checks
  and adds up the budgets, estimates nothing, and refuses (`budget_out_of_range`) a budget more than
  three times off the measured range or the reference.
- **Reads:** story headers in `.agentplugged/stories/`, `state.get`, `.agentplugged/method.yaml`
  (`profile.specialties`, `profile.max_parallel_stories`).
- **Validation point:** the sprint's own checkpoint, opened by `plan.sprint`.

## Steps

1. **Start.** `agent.status` (`working`); Izzy not active: say so, `story.result` `partial`.
   `state.get`: `phase.current` must be `build` (or null), else say what closes it and stop.
   `sprint.latest` `proposed`: tell the creator its `checkpoint` and stop. `refused`: read their
   note (`state.get { checkpoint: "<id>" }`, `checkpoint.resolution.note`); this run answers it.
   `sprint.current`: its stories still `todo`, `in_progress`, `in_review` or `blocked` come first.
   `npx agentplugged docs check`: a story that fails stays out; name it.
2. **Candidates.** A story is **validated** (an approved `document` checkpoint lists its file at its
   current content, header included, else `not_validated`), **not done** (no approved `story`
   checkpoint after its last status), with `owner`, `budget_usd`, `depends_on`. Order by
   dependencies, then by what unblocks most.
3. **Capacity.** Ask once: the developer agents (propose the active ones from
   `profile.specialties`; one developer may build several stories, up to
   `profile.max_parallel_stories`), the number of humans (`owner: creator`), the budget ceiling in
   US dollars if any. Never assume a capacity they did not confirm; "same as last time" reuses
   `sprint.current.capacity`.
4. **Propose.** A goal of 112 characters at most: what a user can do at the end. Stories in order:
   dependencies done or earlier, owner in the capacity (else change the owner in the story's header
   with the creator, never its intent, then `docs check` and commit), total under the ceiling
   (cut from the end), a plausible load. Present goal, stories (owner, budget, waits on), total, risks, what was left out. Revise until the creator agrees.
5. **Record.** `plan.sprint` with `agent: izzy`, `goal`, `stories`, `capacity` (`agents`, `humans`),
   `budget_limit_usd`, `summary` (order, risks, left out).
   - `SPRINT_INVALID`: nothing written; fix every problem of `details.problems`, never the rules:
     `unknown_story`, `unreadable`, `invalid_story`, `done`, `not_validated` (`why`: leave it out
     or have it validated), `dependency_missing`, `dependency_later`, `agent_inactive`,
     `no_capacity`, `owner_unavailable`, `over_budget`, `proposal_open`, `too_long` (shorten the
     summary to `max`, or plan fewer stories). A decision for the creator: back to step 4.
   - On success (`sprint` `S-…`, `checkpoint` `G-…`): Ask whether the sprint suits them only now,
     once, since the checkpoint is open; `chat.answer` with their words (constitution, "Checkpoints
     in the chat").
6. **Hand over.** `story.result` `complete` (sprint, checkpoint, assumptions, questions,
   conflicts); `agent.status` `idle`; `npx agentplugged next --json`, tell the creator what it says.
   Never call a developer: hand back to Noah (without Noah, the creator picks the next agent).

## Rules

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never invent an amount: budgets come from the stories (`state.get` `usage.estimates`); say what a total rests on (`history` or `reference`) and its range.
- Never plan a story that is not validated or is done, nor break the dependency order.
- Never write a sprint file nor edit a story's intent; never start or direct a developer.
