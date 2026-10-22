---
name: review-story
description: Review a story's pull request, or any change, independently with lenses the engine chooses and a judge in a fresh context, in one report. Run by the reviewers.
metadata:
  agent: quentin chloe
  phase: build
---
# Review a story

## Overview

- **Step:** build, by a reviewer under your own id (`agent: <your id>`): quality (`kind: qa`),
  security (`kind: security`) when the story concerns it. Read `git` in `state.next`: the
  creator's workflow decides on a pull request, a CI, a review.
- **Produces:** your review through `review.submit`, a note in `.agentplugged/docs/qa-reviews/`
  or `security-reviews/` (`<story>.md`, header `id`, `kind: note`, `owner`, `links`), a result.
  No code change, no push, no comment posted by you, no merge.
- **Reads:** only what `review.start` names: the diff file, the `files`, the story and its
  numbered `criteria` with their `trace`, the `requirements` and decisions it cites.
- **Validation point:** the engine closes the pass; without a blocking finding it opens the
  creator's merge point. After 2 passes closed without agreement, it asks the creator.

## Modes

- **Story** (below). **No story** (a change, a range, uncommitted work): `references/free-review.md`.
- **Another tool or model**, or no sub-agents: `review.export` (`references/export.md`) replaces
  steps 3 and 4.
- **Tests lens** (the creator asks whether the tests are good, not only green):
  `references/tests.md`.

## Independence

- Never review a story you built (`not_independent`). Before you submit, never read the other
  reviewer's note, the pull request's comments, the developer's reasoning, the journal nor
  `.agentplugged/.cache/` but the files named. Never run `gh` or `glab`: the engine posts.

## Steps

1. **Start.** `agent.status` (`working`); `review.start` with `story`, `kind` (`more`: lenses the
   creator asked). `REVIEW_NOT_POSSIBLE`: say why, step 6 `partial` (`ci_not_green`,
   `head_moved`: read the CI first; `security_not_required`: `complete`).
2. **Read** what it gives: `lenses` (each with why), `readers`, `previous` (your earlier findings,
   as the developer sorted them).
3. **Readers.** One named sub-agent per entry of `readers` but the judge (light model;
   `subagent_type` your own id, `description` its role, never `claude` nor `general-purpose`),
   at once, in the foreground: wait for every report in this turn. Each gets only its `diff`, the story, the `AD-n`, the page of
   the touched code, `format.md`, its `lens-<name>.md`, `judge.md` when `judge: true`, each
   `pass-<name>.md` with the `statements`, its `reuse` lines (in
   `.agentplugged/skills/review-story/references/`). Tests: only `test_command`. Silent after one
   ask: `{lens, silent: true}`, never an invented report. Never split or merge entries.
4. **Judge** (quality). A `judge` entry: once the readers are in, a named sub-agent (the strongest
   model) in a fresh context with the story, its diff, `references/judge.md` and the findings named
   `<lens>#<rank>`. Otherwise the reader with `judge: true` judges. Add or drop nothing.
5. **Review gate, then submit.** Every report whole and taken as it came; your earlier findings
   repeated, same words. `review.submit` with the same `story`, `kind`, `commit`, a `summary`, the
   `lenses` and `judge` reports, `findings` empty (`format.md`). `report_invalid`: complete, submit
   again. A security concern the engine did not see: `security: true`. Then write the note
   (lenses run, findings, the engine's verdict).
6. **Report.** `story.result` with the review's `R-…`, never its verdict nor its findings;
   `agent.status` `idle`, hand back to Noah.

A finding marked `story` is not a code defect: `references/amend-story.md`.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never change the code, the tests or the story: review, do not fix. Never approve nor merge.
- Never call, direct or wait for another agent but your readers: hand back to Noah.
