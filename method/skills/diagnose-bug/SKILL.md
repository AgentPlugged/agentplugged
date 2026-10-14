---
name: diagnose-bug
description: Find a bug's cause by hypotheses the engine keeps, fix it behind a red-then-green test, leave no probe.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Diagnose a bug

A bug is fixed once its cause is known, not once a change makes the symptom go away. This skill
holds you to the order: reproduce, a failing test, hypotheses tested one at a time, a minimal fix,
no probe left. The engine keeps the score; what you say of it does not count.

Run it under your own id (`agent: <your id>`), in the creator's language, in the stack the
architecture names. A bug that is plainly small and whose cause you see at once is the quick lane
(`quick-lane`); this skill is for the one whose cause you must search.

- **Input:** a story of `.agentplugged/stories/` that is yours: the symptom (what happens, what
  should), a requirement it breaks, and an acceptance criterion written as `Given, when, then`. No
  story: ask the creator to have Izzy write it (or to write it), never start without.
- **Output:** the cause, the test that proves it and the fix, committed on the story's branch,
  and a result that moves the story to review. Then the usual path: review, the creator's merge.
- **Annexes** (`references/` of this skill): `hypotheses.md` (listing, confidence, evidence, when
  every one is ruled out), `probes.md` (the marker and how to take it out).

## Steps

1. **Start.** `agent.status` (`working`), `state.get` (`phase.current` must be `build`), then
   `story.start` and work only in its `workdir`. Read the story, its requirements, the decisions
   it cites and the code of the symptom, nothing beyond.
2. **Reproduce.** Find the smallest way to see the bug (an input, a call, a click) and say it in
   one line in `story.progress`. Cannot reproduce it: tell the creator what you tried and what you
   need (a log, a version, a dataset); never fix what you did not see.
3. **A test that fails.** Write the test from the criterion's words (the guide `acceptance-tests.md`
   of `develop-story`), name it `AC-<story>-<n>`, call `story.criterion`: the engine runs it and
   records the red. It must fail for the symptom's reason, not for another. Commit it alone, first.
4. **Hypotheses.** Write 3 to 5 in `story.progress`, each with a confidence and where to look
   (`references/hypotheses.md`). Test them one at a time, the likeliest first, through `story.loop`:
   - `seen: hypothesis`, `note: "7/10 <the hypothesis>"` puts one forward;
   - `seen: ruled_out` or `seen: confirmed`, `note: <what you saw that settles it>` closes it.
   The engine refuses a hypothesis already ruled out, two at once, and any fix before a cause is
   confirmed (`cause_unconfirmed`). To look, read, run, bisect; a probe (a log, a print) carries
   the marker of `references/probes.md`.
5. **Every hypothesis ruled out.** Do not guess further. Widen: 5 to 7 sources you had not
   considered, none already ruled out, keep 1 or 2, and put probes on them before any fix
   (`references/hypotheses.md`). Still nothing after that round: tell the creator what is known, in
   a `decision` checkpoint, instead of a fourth round.
6. **The cause is confirmed.** Say it in one line. When it lies outside the story's scope (another
   module, a decision to revisit), open a `decision` checkpoint before changing anything.
7. **Fix it, minimally.** Declare the fix with `story.loop` (`story`, `note: <the fix>`), write the
   smallest change that removes the cause, call `story.criterion` for the green, then `story.loop`
   `seen: green` (the engine checks the criteria) or `seen: failed` with `note` saying why.
   **After three fixes that failed the engine opens a point for the creator** and refuses a fourth:
   stop, end with `blocked`, say what the three taught you; it refuses new hypotheses too until they
   answer. A failed fix is never tried again.
8. **Take the probes out,** then look for the marker (`references/probes.md`) in your own diff. The
   engine refuses the review while a line you added still carries it in a comment
   (`debug_instrumentation_left`); it cannot see a probe without the marker.
9. **Verify everything,** as the CI does, and read your diff: only this bug's change. What you
   saw elsewhere goes to deferred work (`plan.defer`), never into this fix. Walk through
   `self-check.md` of `develop-story`.
10. **Hand over** as `develop-story` does: commit (`fix(<story>): … (EF-n)`), `story.result`
    (`complete`: the summary names the cause, the test and the fix in the first lines),
    `agent.status` (`idle`), `npx agentplugged next --json`. The pull request and the review come after.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never fix before the failing test, nor before a cause is confirmed; never put forward again a cause that was ruled out.
- Never leave a probe in the code, nor commit one on purpose.
- Never write a hypothesis' result, nor a count of failures: the engine keeps them.
- Never edit the story's intent, never refactor in the same change, never push or merge.
- Never call, direct or wait for another agent: hand back to Noah.
