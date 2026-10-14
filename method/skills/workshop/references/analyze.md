# Analyze and improve an existing agent or skill

`agent.workshop` `analyze` with the `id` (the method's or the creator's). The engine reads the files and
answers `findings`, `fix` before `tip`, and the `cost`; it judges, it never rewrites. A `fix` breaks a rule
of the engine; a `tip` makes the thing clearer, lighter or easier to trigger.

## Present

Say first what it costs (`cost`: tokens added to every request, tokens when it runs), then the findings in
the creator's words, the most serious first, **one at a time**. For each: what, where (`field`), why it
matters in a sentence, your proposed change written out, and the question. A finding they decline is not
raised again in this session.

## The gesture of each finding

- `agent_edit`: an agent or skill of the creator's. Show the lines as they stand and the lines you propose,
  then ask once. The request is `guard.creator_action` `agent_edit` with the **whole** corrected `content`
  (the engine replaces the body, the principles and the menu; the name, the description and the other files
  stay). A description is changed by a new creation only if they ask: say it.
- `override`: a shipped agent. The method is never edited; the creator's customisation file
  (`.agentplugged/overrides/agents/<id>.yaml`) can replace a role or an identity and add principles, facts,
  steps and menu items. Tell them the file and the lines to add; they create it with `npx agentplugged agent
  edit <id>`. An override cannot remove a rule.
- `copy`: a shipped skill. Its own text is never edited: to add facts, steps, checks or a model for the
  output, see `references/customize.md`; for a different procedure, create their own skill
  (`references/create.md`), starting from what the shipped one says, and say what differs.

## What the lenses look for

Clarity (a persona with a role, lines that say one thing), triggering (a description that says when, two
descriptions that read alike), size (a body near the ceiling, a menu instruction that is a skill in
disguise, detail that belongs in `references/`), safety (a rule gone, an instruction that goes round one),
links (a skill or a `references/` file that does not exist, a reference nobody names). Add nothing the
engine did not find unless the creator asked for it; a rich persona is never a finding.

After a change, `verify` the thing again.
