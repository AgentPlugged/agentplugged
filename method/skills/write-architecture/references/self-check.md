# Self-check of the architecture

Answer each question with the document open. A "no" is fixed before handing over, or written
down as an open question with the reason it cannot be fixed now.

## Header and identifiers

- Does the header hold `id`, `kind: architecture`, `owner: alex` and `links` to the PRD and the
  UX specification, and nothing about status, cost or progress?
- Is every decision a heading `### AD-n — <title>`, numbered without gaps created by
  renumbering, and is every retired one still in place with `(retired)` first?

## Decisions

- Does every active decision state its three fields: **Binds**, **Prevents** and **Rule**?
- Would two developers building apart really diverge without it? If not, move it to Deferred.
- Can a reviewer check a diff against its rule? "Keep the code clean" cannot be checked;
  "only the `billing` module writes invoices" can.
- Does any decision contradict another one, the PRD or the UX specification?
- Is a plain "no dependency" or "never import" decision written as a `Guard` line
  (`references/guard.md`), so that the engine stops a write that breaks it?

## Coverage

- Does every requirement that needs a technical answer (`ENF-n` above all) have one: a
  decision, a convention, a part of the diagram, or an open question?
- Can every flow of the UX specification be built with these units and interfaces?
- Is each dimension decided, deferred or open: runtime, data, interfaces, security,
  deployment and environments, operations and observability, test seams?
- Could two developers obey every decision to the letter, each building one of two units that
  share an interface, and still build parts that do not fit? For a high-stakes architecture,
  ask a sub-agent for the method `divergence` (skill `critique-deliverable`).
- Does the data section say, for each important entity, which unit owns and writes it?

## Stack

- Is every technology named in the document in the Stack table?
- Is every version either checked, with its source and date, or marked `to verify` and listed
  under Open questions?
- Is any version past or near its end of life?

## Form

- Are the template's guidance comments all gone, and the empty sections removed (except
  Deferred and Open questions)?
- Are the diagrams valid mermaid, and does each one show something the prose does not?
- Does `npx agentplugged docs check` report no problem?
