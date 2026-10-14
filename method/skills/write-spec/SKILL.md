---
name: write-spec
description: Maya's short path for a small project. Write the one spec (brief, requirements, decisions, stories) in .agentplugged/docs/spec.md, then open its point of validation.
metadata:
  agent: maya
  phase: planning
---
One `spec` stands for the brief, the PRD and the architecture, with the same identifiers (`EF-n`,
`ENF-n`, `AD-n`): the trace, the register of requirements, the critique and the proofs read it as
they read those documents. Files: `assets/spec-template.md`, `references/spec-guide.md` (the
parts, the scope, how to write each, growing): read the guide before step 3.

1. **Start.** `agent.status` (`working`), as `agent: maya`. `state.next` must say `step: spec`
   with `full_path` in `journey.skipped`; otherwise say so and go to step 6 with `partial`.
2. **Scope.** Ask, one question at a time and only what the creator has not said: size, users in
   the first year, personal data, payment or accounts, external services, platforms. They go in
   the header as the creator said them; a risk stays in `sensitive`.
3. **Draft** from the template, in the creator's language; their words stay theirs.
4. **Check.** `npx agentplugged docs check` until it reports nothing.
5. **Validate.** Commit the spec, then `checkpoint.open` (`type: document`, low risk, a summary, no
   story, no blocks, the spec in `documents`: `path`, `branch`, `blob_sha`) and ask the creator
   once. A refusal comes back as `changes_requested`: correct, reopen with `supersedes`.
6. **Report.** `story.result`, then `agent.status` (`idle`).

Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`. Never renumber an identifier, never lower a risk, never call another agent: hand back to Noah, who has Izzy cut the stories.
