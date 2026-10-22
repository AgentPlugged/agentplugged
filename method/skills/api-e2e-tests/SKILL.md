---
name: api-e2e-tests
description: Set up the test framework from the validated stack, then write API and end-to-end tests from a story's criteria. Run by developers.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# API and end-to-end tests

## Overview

- **Step:** build, as the story's developer (`agent: <your id>`), on the creator's ask or when a
  story's plan puts a criterion at these levels. Modes: **frame** (once per product, or when a level
  has no framework) and **cover** (the tests of a feature).
- **Produces:** the framework, the tests in the story's branch, `.agentplugged/proofs.yaml`.
- **Reads:** the stack of the architecture (`docs read @stack`) or `spec.md` (language, `dependencies`), the test
  strategy, the tests already there; in cover mode the story and its journeys; the feature's code
  only for names, never to decide what to test.
- **Validation point:** the creator accepts the proof command (step 4).

## Steps

1. **Start.** `agent.status` (`working`). `state.get`: `phase.current` is `build`, else say so and
   stop. The work lands in a story's branch: `story.start` on the story that asks for it. None: hand back to Noah.
2. **Frame.** `npx agentplugged tests setup` reads the product's files: the runner of each level,
   the one command that runs a criterion's tests, what to install; it writes
   `.agentplugged/proofs.yaml` as a proposal when none exists. The validated stack wins: when a
   runner is only proposed and the architecture names another, run it again with `--runner` and
   `--e2e` (`none` without a screen). A runner already in use is never replaced. No language, no framework is imposed. Layout:
   the stack's convention; a path holding `test`, `spec` or `e2e` is read as a test (else
   `no_test`). `test` stays the quick run; `test:api`, `test:integration`, `test:e2e` run slower levels.
3. **Install.** The architecture plans the test tools in its `dependencies`. A framework it does not
   plan is a package that lasts: hand back to Noah (the architecture is approved again; never edit
   its `dependencies`). Then install as "Installing dependencies" says: at the creator's `validate`
   mode it is one point of the stack, one gesture.
4. **Declare.** Ask the creator once to accept the command of `.agentplugged/proofs.yaml` (the
   `{criterion}` line): `guard.creator_action`, `kind: proof_commands`. Never accept it yourself.
   Then one sample test per level, run until it passes.
5. **Cover.** Per criterion and journey, the lowest level that proves it (unit, API, end to end for the few
   journeys a user cannot do without); P0 (money, data, security, sign-in) and P1 first. Write the scenario
   from the words of the criterion before looking at the code; one linear test checks one
   behaviour; the test named `AC-<story>-<n>`, seen red then green by `story.criterion`
   (`develop-story/references/acceptance-tests.md`). API: error and limit cases, the answer's
   shape. End to end: locate by role, label or `data-testid`, wait for a condition never a
   duration, sign in once through the API. Each test builds and removes its data.
   - Code already exists: break the behaviour uncommitted, `story.criterion` red (`unclean`
     expected), undo, green. A test green with the behaviour broken proves nothing.
   - Not testable (real third party, hardware, captcha): `story.criterion`, `seen: untestable`,
     the reason in `note`; offer the level that holds.
   - Unstable: find the cause, fix it, run it five times; never a retry, a skip or a weaker assertion.
6. **CI.** `npx agentplugged ci setup` lists the test scripts the CI does not run (`Not checked by
   the CI`); when none, `state.next` calls Omar. `references/ci.md`.
7. **Report.** `story.result`: framework and installs, tests per level, trace line, journeys not
   testable and why, the five-run checks. `agent.status` `idle`.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never write a test from the code it checks, nor weaken or skip a test to turn it green.
- Never install outside the rules above, nor put a secret or a real person's data in a test.
- Never call, direct or wait for another agent: hand back to Noah.
