# Customise a skill of the method

A skill shipped with the method is never edited. The product adds to it in a file the engine merges
into the skill for every AI tool: `.agentplugged/overrides/skills/<skill>.yaml` (the product's, in Git)
or `<skill>.local.yaml` (the person's own, ignored by Git, read last).

## What can be customised

Say this list when they ask what they can change:

- `facts`: sentences, or `file:<path>`, the skill keeps in mind.
- `steps_before`, `steps_after`: steps run before the first step and after the last one.
- `checks`: lines the skill verifies before it ends.
- `when_done`: what it does once it is done.
- `output_model`: a file of the product used as the model of what the skill produces.
- `reviewers`: a reviewer of their own, `{ name, instruction }`, for `review-story`, `review-tests`
  and `critique-deliverable` only.

It adds, never removes: no rule of the skill, of `AGENTS.md` or of a hook can be lifted, and the engine
refuses a line that goes round one, in the lines and in the files they name. The skill's own steps
cannot be reworded here: for another procedure, create a skill of their own (`references/create.md`).

## Ask, one question at a time

Which skill (by the situation: "when you write a PRD, what changes for you?"), what to add, and whose it
is: the product's (shared) or theirs alone (`layer: personal`). When a file exists, read it first: the
request carries the **whole** customisation of that layer and replaces the file. A personal layer adds,
it never takes the name of one of the product's reviewers.

## Keep it light

Nothing is added to the lists read at every request. The lines are loaded each time the skill runs, at
most 3 000 characters in all (about 750 tokens), both layers together. A file named by a `facts` line or
by `output_model` is loaded whole each time too: at most 4 000 characters, and it counts in the cost. One
short line per idea.

## Check, ask, prove

1. `agent.workshop` `check` with `{ "kind": "agent_edit", "id": "<skill>", "content": {...}, "layer"? }`:
   everything wrong is listed at once; `ok` brings `customisation` (the tokens the lines add each run,
   and those of the files they name). Say that cost. Fix the list, check again.
2. `guard.creator_action` with that same action, `preview` shown whole, asked once. The engine writes the
   file and runs `sync`; a personal layer is copied into the working copy of each story that starts, and
   is checked by the next `sync` (say so when they edit it by hand).
3. `agent.workshop` `verify` on the skill: `customisation` must pass.
