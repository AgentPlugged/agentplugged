---
name: check-requirements
description: Compare a started story's work with the requirements it cites, before the merge at the latest; verify each deviation. Run by the quality reviewer.
metadata:
  agent: quentin
  phase: build
---
# Check a story against its requirements

## Overview

- **Step:** build, as the quality reviewer (`agent: <your id>` in every MCP call). You never fix the
  code: the story's developer does.
- **Produces:** a deviation (`V-…`) per gap, with `story.deviation`; fixed ones lifted with
  `story.lift_deviation`; a structured result.
- **Reads:** the story file (its excerpts hold the requirements and `AD-n` it cites), `state.trace`, the code of its
  branch; never the rest of the repository.
- **Validation point:** none (the creator validates the story).
- **When:** during the build on a developer's report or the creator's ask; at the latest before the
  merge, on the whole branch; after a fix, when the story returns to review.

## Steps

1. **Start.** `agent.status` (`working`, the story). `state.get`: the story must be started
   (`stories.<id>.started`) and not done; its open deviations are in `deviations.open`. Otherwise
   say so, `partial`, step 7.
2. **Trace.** `state.trace` with each requirement (tests that cite it as `path:line`). A test cites a requirement with its id in a name,
   comment or file name: `EF-18`, or `EF_18` where a name takes no dash. `state.trace` reads the
   working copy the server runs in, usually the main checkout: the tests of a story not merged yet
   live on its branch; look there too (`stories.<id>.started.worktree`, or
   `git grep -n -i -E "(EF|ENF)[-_]18" <branch> --`) before concluding.
3. **Read the build.** In the worktree, or `git diff <base>...<branch>`: the code and tests the
   story changed. Note the commit compared (`git rev-parse <branch>`).
4. **Compare.** Per requirement: what it asks, what the code does (file and line), which test proves
   that very behaviour. A requirement no test of the branch cites is a deviation (`no test cites EF-n`) unless the story says how else it is checked. Per
   acceptance criterion: met with its test, or not.
   An ambiguous requirement is an open question, never a guess.
5. **Report.** One `story.deviation` per distinct gap: `story`, `requirements` (only those the story
   cites), a one-line `summary`, a `detail` (what it says, what the code does, file and line), the
   `commit`. The engine sends a story in review back to its developer. Read `deviations.open` first: never report a gap twice.
6. **Verify the fixes.** When code and test now satisfy the requirement, `story.lift_deviation`
   with the deviation and the fixing commit. Lift only what you reported and verified; the creator
   may lift any in the chat. A deviation on a story you built is never yours to lift
   (`DEVIATION_NOT_ALLOWED`); if its reporter is inactive, ask the creator.
7. **Report.** `story.result`: `complete` when the comparison ran to the end (whatever it found),
   else `partial`; a summary with `ok` or the deviation ids per requirement. `agent.status` `idle`; `npx agentplugged next --json`, tell the creator what it says.

## Proofs before a release

The release point is refused while a non-functional requirement lacks a valid proof:
`measure.requirements` (the gaps), then the proof: `measure.run` for a declared command
(`references/engine-proofs.md`), else `measure.proof`; then the creator decides the rest, one gap
at a time (`references/proofs-and-gaps.md`).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never change the code, the tests or the story: report, do not fix.
- Never report a deviation from a requirement the story does not cite (`not_linked`): note it for
  the creator.
- Never lift a deviation you did not report and verify; never merge nor approve a story.
- Never call, direct or wait for another agent: hand back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).
