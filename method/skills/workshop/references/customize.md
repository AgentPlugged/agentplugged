# Customise a skill of the method

A shipped skill is never edited; the engine merges `.agentplugged/overrides/skills/<skill>.yaml` (the product's, in Git) or `<skill>.local.yaml`
(the person's own, ignored by Git, read last).

Can be customised: `facts` (sentences, or `file:<path>`); `steps_before`, `steps_after`; `checks`;
`when_done`; `output_model` (a file of the product as the model of the output); `reviewers`
(`{ name, instruction }`, for `review-story` and `critique-deliverable` only). It adds, never
removes: no rule of the skill, of `AGENTS.md` or of a hook can be lifted; the engine refuses a line
that goes round one, in the lines and the files they name.

Ask which skill, what to add, whose it is (the product's, or `layer: personal`). When a file exists,
read it first: the request carries the **whole** customisation of that layer and replaces the file.
Lines load each run: 3 000 characters at most for both layers, 4 000 for a named file.

1. `agent.workshop` `check` with `{ "kind": "agent_edit", "id": "<skill>", "content": {...}, "layer"? }`;
   `ok` brings `customisation` (tokens added each run): say it.
2. `guard.creator_action` with that action, `preview` shown whole, asked once; the engine writes the
   file and runs `sync`.
3. `agent.workshop` `verify` on the skill: `customisation` must pass.
