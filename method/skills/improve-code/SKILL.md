---
name: improve-code
description: Clean up, speed up, harden or restructure code from a finding, the engine's commands showing behaviour unchanged.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Improve code

Improving code is a change that must prove it changed nothing the product shows. This skill takes
a finding that someone already made, applies it on one axis and holds the proof of "unchanged" to
the engine's commands, run before the first change and after the last, never to your word.

Run it under your own id (`agent: <your id>`), in the creator's language, in the stack the
architecture names.

- **Input:** a story of `.agentplugged/stories/` that is yours and is born of a finding: an audit
  (`audit-pillars`: a `story` finding), duplicated code the engine listed (`reuse`), a gap of the
  tests (`review.tests` `propose`), or a review finding sorted `defer`. Its Context cites the
  finding (`D-…`) and names the axis. No story: ask the creator to have Izzy write one from the
  finding, never start without.
- **The axis** (one per story; two findings of two axes are two stories): `cleanup` (names,
  duplication, dead code, size, nesting), `performance`, `security`, `architecture` (the
  boundaries the decisions `AD-n` set). The story does not name it: ask once.
- **Output:** the improvement, committed on the story's branch in small steps, the engine's runs
  before and after, and a result that moves the story to review. The review is the usual one,
  independent: Quentin, and Chloé for the `security` axis.
- **Annex** (`references/axes.md`): what each axis looks for, and what it must not do.

## Steps

1. **Start.** `agent.status` (`working`), `state.get` (`phase.current` must be `build`),
   `story.start`, and work only in its `workdir`. Read the story and the finding it cites: the
   files they name are the whole scope. Nothing beyond it is touched.
2. **Find the commands.** The project's declared commands (`.agentplugged/proofs.yaml`, accepted by
   the creator): tests, linter, type check, build, and for `performance` a measure with a budget.
   The engine runs only a command that `proves` a requirement of the register. None declared, or
   none that covers the scope: the guide `engine-proofs.md` of `check-requirements` says how to
   declare them and ask the creator once; do not go on without at least one.
3. **Before: the baseline.** `measure.run` for each command that covers the scope. They must pass.
   One that fails is not an improvement but a bug, and its failed proof is a gap the creator will
   settle: stop, tell them, and go to `diagnose-bug`. Note the commit you stand at
   (`git rev-parse --short HEAD`); the engine inscribes the real one with each run.
4. **Pin what is not pinned.** Where the scope has no test of what you will touch, write the tests
   of its behaviour as it is seen from outside (never from the code you are about to change),
   commit them alone, then run step 3 again. These tests are the proof and are in the scope.
5. **Change, small step by small step.** One kind of change per commit, in the axis (`axes.md`),
   with a message `refactor(<story>): …` (`perf(<story>): …` for performance, `fix(<story>): …` for
   security) citing the requirement. After each step run the tests again; a red step is undone, not
   patched. The public inputs and outputs (exports, routes, messages, file formats) stay as they
   are: one that must change is a `decision` checkpoint, not yours to settle.
6. **After.** On the last commit, clean (`git status`), `measure.run` of the same commands: the same
   pass as the baseline, all of them. A performance gain is the project's measure run before and
   after (the budget held both times, the engine's verdict), the two numbers read in each run's
   `log` and quoted as they are, never an estimate. Put both commits and the lines the engine returned in
   `story.progress`. A criterion of the story that no test can show red ("the behaviour is the
   same") is declared untestable (`story.criterion`, `seen: untestable`) with those two commits as
   the reason: the review reads them.
7. **Security only:** behaviour may change on purpose. Say each change and why in `story.progress`,
   and write the test that fails on the old code (`story.criterion`: the engine saw it red, then
   green); a security change with no such test is not done.
8. **What you saw outside the scope** goes to deferred work (`plan.defer`), never into this change.
9. **Verify, then hand over** as `develop-story` does (steps 7 to 9, `self-check.md`): the whole
   verification, a clean tree, `story.result` whose summary says the axis, the before and the after
   in two lines, then `agent.status` (`idle`) and `npx agentplugged next --json`.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never say that behaviour is unchanged on your word: the engine ran the commands, or it is not said.
- Never mix two axes, add a feature, a dependency or a test for something else, in the same story.
- Never change a public interface, nor edit a test to make a step pass.
- Never edit the story's intent, never push or merge, never review your own work.
- Never call, direct or wait for another agent: hand back to Noah.
