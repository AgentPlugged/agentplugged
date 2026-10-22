---
name: diagnose-bug
description: Find a bug's cause by hypotheses the engine keeps, fix it behind a red-then-green test, leave no probe.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Diagnose a bug

## Overview

- **Step:** build, as the story's developer (`agent: <your id>` in every MCP call), in the stack the
  architecture names. Reproduce, a failing test, hypotheses one at a time, a minimal fix, no
  probe left; the engine keeps the score. A bug
  plainly small, its cause seen at once, is the quick lane of `develop-story`
  (`develop-story/references/quick-lane.md`); this skill is for a cause you must search.
- **Produces:** the cause, its test and the fix, committed on the story's branch, then review.
- **Reads:** one story of `.agentplugged/stories/` that is yours (symptom, requirement,
  criterion), the decisions it cites, the code of the symptom. No story: ask
  the creator to have Izzy write it, never start without.
- **Annexes:** `references/hypotheses.md` (listing, confidence, evidence, all ruled out),
  `references/probes.md` (the marker and how to take it out).

## Steps

1. **Start.** `agent.status` (`working`), `state.get` (`phase.current` must be `build`),
   `story.start`; work only in its `workdir`.
2. **Reproduce.** The smallest way to see the bug, in one line in `story.progress`. Cannot: tell the
   creator what you tried and need; never fix what you did not see.
3. **A test that fails.** From the criterion's words (`develop-story/references/acceptance-tests.md`),
   named `AC-<story>-<n>`; `story.criterion` records the red, for the symptom's reason. Commit it alone, first.
4. **Hypotheses.** 3 to 5 in `story.progress`, each with a confidence and where to look; test them
   one at a time, the likeliest first, through `story.loop`: `seen: hypothesis`,
   `note: "7/10 <the hypothesis>"` puts one forward; `seen: ruled_out` or `seen: confirmed`,
   `note: <what you saw that settles it>` closes it. The engine refuses a hypothesis already ruled
   out, two at once, and any fix before a cause is confirmed (`cause_unconfirmed`). A probe carries
   the marker of `references/probes.md`.
5. **All ruled out.** Widen once: 5 to 7 new sources, keep 1 or 2, probes on them before any fix
   (`references/hypotheses.md`). Still nothing: a `decision` checkpoint telling the creator what is
   known, not a fourth round.
6. **Cause confirmed.** Say it in one line. Outside the story's scope (another module, a decision
   to revisit): open a `decision` checkpoint before changing anything.
7. **Fix, minimally.** Declare it with `story.loop` (`story`, `note: <the fix>`), make the smallest
   change that removes the cause, `story.criterion` for the green, then `story.loop` `seen: green`
   or `seen: failed` with `note`. **After three fixes that failed the engine opens a point for the
   creator** and refuses a fourth and new hypotheses: stop, end with `blocked`, say what the three
   taught you. A failed fix is never tried again.
8. **Take the probes out** and search your diff for the marker. The engine refuses the review while
   an added line still carries it in a comment (`debug_instrumentation_left`); it cannot see a probe
   without the marker.
9. **Verify and hand over** as `develop-story` does (steps 6 and 7): only this bug's change in the diff, the rest to
   `plan.defer`. Commit `fix(<story>): … (EF-n)`,
   `story.result` (the cause, the test and the fix in the first lines), `agent.status` `idle`,
   `npx agentplugged next --json`.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never fix before the failing test, nor before a cause is confirmed; never put forward again a cause that was ruled out.
- Never leave a probe in the code; never write a hypothesis' result nor a count of failures.
- Never edit the story's intent, refactor in the same change, push or merge.
- Never call, direct or wait for another agent: hand back to Noah.
