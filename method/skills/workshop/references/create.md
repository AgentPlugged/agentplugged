# Create an agent or a skill

Agent or skill? An **agent** is someone: a persona, principles, a menu, who answers the creator. A **skill**
is a way of doing one thing, a short procedure an agent calls from its menu. If it is one procedure, make a
skill; if it is a role with several jobs, make an agent and give it skills.

## Ask (one question at a time, skip what they already said)

- **Agent**: the name and the job in one sentence; the domain (`product`, `ux`, `architecture`, `code`,
  `quality`, `security`, `delivery`, `docs`, `creativity`, `marketing`, `sales`) and the phase (`framing`,
  `planning`, `design`, `build`, `delivery`, `launch`); who they are (identity) and how they speak; what
  they produce and where; how they work; **what they never do**; their principles; the menu: a short code,
  what the item offers, and either the instruction or a skill it calls (`skill`).
- **Skill**: when it is called, in one line (that line is the description); the steps in order; what it
  produces and where; the rules it follows. Detail a step needs only sometimes goes in a **reference**
  (`references`: a name and its lines), and the step says `references/<name>.md` where it is needed.

## Keep it light (the creator pays for it in tokens)

- The **description** is listed at every request of every session: at most 180 characters, and it says
  *when* it is called (for what, in which phase, run by whom), not only what it is.
- The body is read only when it runs: short steps, no repetition of what a capable model does unasked.
  Long detail goes to a reference; a long menu instruction becomes a skill.
- Look for an existing thing first (`agent.workshop` `analyze` on the closest): sharpen it rather than add a
  second that reads the same.
- Say the cost in your question: `check` returns it, the preview shows it.

## The definition, in their words

Write the lines as they said them, in their language; do not polish them into yours. Short sentences, one
idea a line. For an agent: `overview` (who, for what), `produces`, `works`, `never` (at least one line: what
the agent must not do, at least the actions only the creator takes), `principles`, `menu`, and if they gave
them `identity`, `communication_style`, `persistent_facts`. For a skill: `steps`, `outputs`, `rules`, and
`references` if any.

A marketing or sales agent gets the publication boundary from the engine; you do not write it, and you
cannot remove it. The same goes for the constitution, the permissions and the hooks: they are written for
every tool by `sync`, outside the creator's text.

## After the yes

The engine writes `.agentplugged/agents/<id>/` (`SKILL.md`, `agent.yaml`) or `.agentplugged/skills/<id>/`
(`SKILL.md`, `references/`) and runs `sync`: the same render as the shipped ones, for Claude Code, Codex,
Cursor and Antigravity CLI. Then `verify` (its `evals` proposes behaviour cases: `references/evaluate.md`). To change it later, `analyze`, then a new `agent_edit`
with the whole corrected `content`, shown and approved the same way.
