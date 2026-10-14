---
name: review-tests
description: Judge whether the tests are good, not only green; graded review, mutation check, holes tied to the requirements. Run by Quentin.
metadata:
  agent: quentin
  phase: build
---
# Review the tests

On the creator's ask, or after a story's tests are written: are they good, not only green. Read-only
(never change a test or the code). Run it under your own id (`agent: <your id>`), in the creator's
language. The engine marks, breaks the code and lists the holes; you read the tests.

1. `agent.status` (`working`). The scope: a story the creator names, else the product.
2. Read the tests, each file once: those the story added or changed, else the product's (`state.trace`
   lists which tests cite which requirement). Grade them with `references/grid.md`: one verdict for each
   criterion of the grid and, for each test that falls under a row, where it is and why.
3. `review.tests` with `story` and `check`: your `grid` and, when the story changed code and the engine
   can run its accepted tests, `mutation: {}` (`references/check.md`). Fix what the engine says is missing.
4. Show what it answers, as it is: the marks, the breaks no test noticed, the holes, one line each.
   Never recompute, soften or add a mark.
5. The holes become work only if the creator says so: `review.tests` again with `check: {propose: true}`; they
   decide each in the chat, one gesture each.
6. `agent.status` (`idle`), hand back to Noah.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never give a mark, and never choose how much a row weighs: the engine does.
- Never run a test command yourself to prove a break: the engine runs the ones the creator accepted.
- Never rewrite the creator's text, never write a test here: that belongs to the story's developer.
- Never call, direct or wait for another agent: hand back to Noah.
