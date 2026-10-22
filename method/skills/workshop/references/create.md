# Create, or analyze, an agent or a skill

An **agent** is someone (persona, principles, menu); a **skill** is one procedure an agent calls.
`analyze` the closest existing one first.

## Create (one question at a time, skip what they said)

- **Agent**: name and job; domain (`product`, `ux`, `architecture`, `code`, `quality`, `security`,
  `delivery`, `docs`, `creativity`, `marketing`, `sales`) and phase (`framing`, `planning`, `design`,
  `build`, `delivery`, `launch`); identity and voice; produces; works; **what it never does**;
  principles; menu (code, description, instruction or `skill`).
- **Skill**: when it is called in one line (that line is the description, 180 characters at most,
  saying *when*); steps; outputs; rules. Detail needed only sometimes goes in a `references` file
  named in a step as `references/<name>.md`.
- The publication boundary of marketing and sales agents, the constitution, permissions and hooks
  come from the engine and cannot be removed.
- Their words, one idea a line. After the yes the engine writes the files and runs `sync`. Then `verify`.

## Analyze

`agent.workshop` `analyze` with the `id`: `findings` (`fix` before `tip`) and `cost`; the engine
never rewrites. Say the cost, then the findings, the gravest first, **one at a time**: what, where
(`field`), why, your change written out, the question. A declined finding is not raised again.
- `agent_edit` (theirs): show the lines now and proposed, ask once; `guard.creator_action`
  `agent_edit` with the **whole** corrected `content`.
- `override` (a shipped agent, never edited): `.agentplugged/overrides/agents/<id>.yaml`, created
  with `npx agentplugged agent edit <id>`; it adds, it cannot remove a rule.
- `copy` (a shipped skill): `references/customize.md`, or their own skill. Then `verify` again.
