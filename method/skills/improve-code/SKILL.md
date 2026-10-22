---
name: improve-code
description: Clean up, speed up, harden or restructure code from a finding, the engine's commands showing behaviour unchanged.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Improve code

## Overview

- **Step:** build, as the story's developer (`agent: <your id>` in every MCP call), in the stack the
  architecture names. An improvement must prove it changed nothing the product shows: the proof is
  the engine's commands, run before the first change and after the last, never your word.
- **Produces:** the improvement, committed in small steps on the story's branch, the engine's runs
  before and after, and a result that moves the story to review (the usual independent review:
  Quentin, and Chloé for `security`).
- **Reads:** one story of `.agentplugged/stories/` that is yours, born of a finding: an audit
  (`audit-pillars`, a `story` finding), duplicated code the engine listed (`reuse`), a gap of the
  tests (`review.tests` `propose`), or a review finding sorted `defer`; its Context cites the finding
  (`D-…`). The files it names are the whole scope. No story: ask the creator to have Izzy write one.
- **Axis** (one per story): `cleanup`, `performance`, `security`, `architecture`; the story does not
  name it: ask once. What each looks for and must not do: `references/axes.md`.
- **Validation point:** none; review and merge follow.

## Steps

1. **Start.** `agent.status` (`working`), `state.get` (`phase.current` must be `build`),
   `story.start`; work only in its `workdir`.
2. **Commands.** The project's declared commands (`.agentplugged/proofs.yaml`, accepted by the
   creator): tests, linter, type check, build, and for `performance` a measure with a budget. The
   engine runs only a command that `proves` a requirement of the register. None covers the scope:
   `check-requirements/references/engine-proofs.md` says how to declare them and ask the creator
   once; do not go on without one.
3. **Before: the baseline.** `measure.run` for each command covering the scope; they must pass. One
   that fails is a bug, not an improvement: stop, tell the creator, go to `diagnose-bug`.
4. **Pin.** Where the scope has no test of what you will touch, write tests of its behaviour seen
   from outside (never from the code you will change), commit them alone, redo step 3.
5. **Change, small steps.** One kind of change per commit, within the axis, message
   `refactor(<story>): …` (`perf`, `fix` for security) citing the requirement. Tests after each step;
   a red step is undone, not patched. Public inputs and outputs (exports, routes, messages, file
   formats) stay: one that must change is a `decision` checkpoint.
6. **After.** On the last commit, clean tree, `measure.run` of the same commands: the same pass as
   the baseline. A performance gain is the measure run before and after, the two numbers quoted
   from each run's `log`, never an estimate. Both commits and the engine's lines go in
   `story.progress`. A criterion no test can show red ("the behaviour is the same") is declared
   `story.criterion` `seen: untestable`, those two commits as the reason.
7. **Security only:** behaviour may change on purpose. Say each change in `story.progress` and write
   the test that fails on the old code (`story.criterion`: red, then green); without it, not done.
8. **Outside the scope** goes to `plan.defer`, never into this change.
9. **Verify and hand over** as `develop-story` does (steps 6 and 7): `story.result` whose summary
   says the axis and the before and after in two lines, `agent.status` `idle`,
   `npx agentplugged next --json`.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never say behaviour is unchanged on your word: the engine ran the commands, or it is not said.
- Never mix two axes, nor add a feature, a dependency or a test for something else.
- Never change a public interface, nor edit a test to make a step pass.
- Never edit the story's intent, push, merge or review your own work.
- Never call, direct or wait for another agent: hand back to Noah.
