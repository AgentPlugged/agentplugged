---
name: develop-story
description: Build one validated story in its own branch, tests first, criterion by criterion, to a result that moves it to review. Run by developers.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Develop a story

## Overview

- **Step:** build; one story per run, under your id (`agent: <your id>` in every MCP call).
- **Produces:** code and tests on the story's branch, a result that moves it to review.
- **Reads:** your sheet alone (`sheet` in `story.start`, a `stale` excerpt's text now with it),
  never a document whole; `legacy`: only what it cites (`EF-n`, `AD-n`, screens), by section.
  Then the mock-up it names, `.agentplugged/docs/index.md` and the pages you touch; one
  marked `agentplugged:late` (or in `late_pages`): read the code, assert nothing from that page.
- **Validation point:** independent review, then the creator's merge.

## Before you start

- Forget the conversation: only your sheet, `state.get`.
- No story named: `npx agentplugged next --json` (`step: build`); one whose `agent` is not you is
  not yours. Inactive: step 7, `partial`.
- **Modes:** **build**; **resume** (`story.start` answers `resumed`; `state.get` and
  `git log` give the first criterion without a passing test); **fix** (step 8); **quick lane**
  for a small change: read `references/quick-lane.md` first.
- Read `git` in `state.next`: the creator's workflow wins (`story_branch: false`, `not_wanted`).

## Decisions

- **Open:** two readings, a contradiction, a change of scope, an irreversible step:
  `checkpoint.open`, `type: decision`, `story`, the passages quoted, two to four options, your
  `recommendation`, `blocks` with `story.review` and `story.complete`. Never guess; meanwhile
  build what it does not touch. Dependencies: "Installing dependencies".
- **Apply:** read its `resolution` and apply it as "Applying a resolution" says (reference `skill-rules`). A story you marked `blocked`: `story.status` with `in_progress` again first.
- Never edit the `## Intent` section: review is refused while the branch changes
  it (`STORY_INTENT_CHANGED`). Never rewrite other sections to fit the code.

## Steps

1. **Start.** `agent.status` (`working`); `phase.current` is `build` (or null), else `partial`;
   a checkpoint waiting on this story in `npx agentplugged next --json`: `partial`.
2. **Working copy.** `story.start`; work only in the `workdir` it returns. `STORY_NOT_STARTABLE`
   or `STORY_LOCKED`: say why, `partial`.
3. **Read** (Overview), then the code you change. `npx agentplugged docs check`.
4. **Plan.** `story.start`'s `profile`: the commands. Before a new helper:
   `npx agentplugged docs bricks <words>`. Per criterion, a
   scenario drawn from its words alone; nothing to observe: declared untestable with its reason
   (`story.criterion`, `seen: untestable`).
5. **Build, criterion by criterion** (`references/acceptance-tests.md`): the test first, never
   the code, named `AC-4-2-1` (`AC_4_2_1` where a name takes no dash); cite the requirement it proves (`EF-18`);
   `story.criterion`: the engine runs the project's test command and records the red; watch it
   fail for the right reason. Then the code; `story.criterion` again: the green. Commit as
   `feat(2-3): sign-in form (EF-12)`; `story.progress`. Two failures of one cause: change
   method or open a decision.
6. **Review gate.** The whole verification, as the CI runs it. The `## Intent` is the approved
   one (`git show <blob_sha>` of its last approved `document` point; else copy back only that
   section); every criterion `green` or `untestable` by the engine; every change serves a
   criterion; nothing outside the story's scope or in `.agentplugged/` but what it asks.
7. **Hand over.** `git status` clean. `story.result`: a
   summary of 800 characters at most, the outcome first (the long account goes in
   `story.progress` and the pull request; it never hides a failure), assumptions, questions,
   conflicts. `complete` moves the story to review; refused with `CHECKPOINT_OPEN`,
   `STORY_INTENT_CHANGED` or `CRITERIA_NOT_PROVEN`: fix the cause. No cost (`measure.cost`: only
   what the tool shows). `agent.status` `idle`.
8. **Fix** on the same branch: a closed review pass first (`review.get`, `review.triage` of each
   finding: `fix`, `defer` with `plan.defer`, `reject` with its reason, and its root cause); a
   deviation `V-…`; a red CI; `merge_changes` (the creator's note verbatim, within the
   intent); `merge_conflict`: skill `resolve-merge-conflict`. Then deliver again.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never leave the `workdir` nor work on the main branch; never push, force-push, open the pull
  request or merge: only the engine merges, once the creator approves.
- Never mark a criterion done without a test the engine saw failing, then passing.
- Never call, direct or wait for another agent: hand back to Noah.
