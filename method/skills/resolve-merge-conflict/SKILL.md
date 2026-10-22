---
name: resolve-merge-conflict
description: Settle a conflict between a story's branch and the main branch, on the story's branch, then back to review. Run by its developer.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Resolve a conflict with the main branch

> **The creator's Git workflow.** The story's `base_ref` (`git.branches.integration`, else the main branch) is the branch it lands on; it may have no pull request (`git.merge` `direct`). Below, "the main branch" and "the pull request" mean those.

## Overview

- **Step:** build, as the story's developer (`agent: <your id>` in every MCP call), on its own
  branch and worktree. The engine sets a ceiling you may keep or raise, never lower, and checks at
  the merge that what you did matches what you declared.
- **Produces:** a qualification (`story.merge_conflict`), the branch updated with the main branch,
  the conflict resolved, a new pull request text, the story back in review.
- **Reads:** `state.merge_order` (with `story`): `conflict` (files, class) and `ceiling`.
- **Validation point:** the creator chooses, in a decision checkpoint, for a conflict of substance.
- **When:** `state.next` gives `merge_conflict`; or `MERGE_FAILED` `conflict`,
  `conflict_unqualified`, `conflict_unverified`, `not_mergeable` (fetch: your copy is behind).

## Steps

1. **Resume.** `story.start` resumes the worktree; work only there. `git fetch` first (record it with
   `guard.external_read`), then `state.merge_order`.
2. **Qualify before resolving** (`story.merge_conflict`, your story).
   - `textual` only when the ceiling allows it and you checked: in each file the two sides only add
     lines at the same place (two imports, two list entries) or differ by spaces, and neither
     changes the logic of a function the other also changes. In doubt, it is substantive. Give a `rationale`.
   - `substantive` in every other case: a `recommendation` (`keep_story`, `keep_main` or
     `combine`) and a `rationale` the creator can judge. You may always raise to substantive; a
     textual declaration above the ceiling is refused (`forced_substantive`).
3. **Substantive: wait for the creator.** The engine opened a decision with both versions and your
   recommendation; Noah presents it; the creator chooses. The story cannot return to review before;
   if they refuse every option, qualify again.
4. **Resolve.** In the worktree, `git merge` the main branch (`stories.<id>.started.base_ref`) into
   yours. Never `git rebase`, `git pull --rebase`, rewritten history or forced push: the engine
   reads each merge commit and refuses a rebased branch.
   - textual: keep every line of both sides, in the order that reads well; dropping one is a choice
     (`conflict_dropped`).
   - substantive: apply the creator's option and nothing more (`keep_story`, `keep_main`,
     `combine`).
   - Remove every conflict marker (`<<<<<<<`, `>>>>>>>`): one left refuses the merge.
5. **Prove.** Run the story's tests and the repository's whole suite; fix what the merge broke.
   Commit the merge with the usual message.
6. **Deliver again.** `story.pr` on the new commit; `story.ci` must cover it; `story.status`
   `in_review`.
7. **Report.** `story.result` (what you resolved, assumptions, questions); `agent.status` `idle`;
   `npx agentplugged next --json`, tell the creator what it says.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never merge the story, nor open or answer the creator's decision: a choice between two versions is theirs, so never call a conflict textual to avoid asking.
- Never rebase, force a push or rewrite the history of the story's branch.
- Never leave a conflict marker, nor lose a line you promised to keep.
