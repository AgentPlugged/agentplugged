---
name: resolve-merge-conflict
description: Qualify and settle a conflict between a story's branch and the main branch, on the story's own branch, then send it to review again. Run by the story's developer.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Resolve a conflict with the main branch

> **The creator's Git workflow, not the method's.** Read `git` in `state.next` or `state.get` before you act: the branch a story lands on is `git.branches.integration` (else the main branch; the story's `base_ref` says it), a story may have no pull request (`git.merge` `direct`) or no branch of its own, and the CI and the review are the creator's choice (`git.ci` `none`, `git.review` false). Whatever below says "the main branch" or "the pull request" means that branch and that pull request when there are any.

The main branch moved while your story waited for its merge, and the two now change the same
place. Resolving that is your job, on your story's branch, in your story's worktree, and nobody
else's. But a conflict is not always a matter of text, and you do not get to decide alone which
one it is: the engine reads the conflict itself, sets a ceiling you can keep or raise but never
lower, and checks at the merge that what you did matches what you declared.

This skill belongs to the developers. Run it under your own id: `agent: <your id>` in every MCP
call. Work in the creator's language; keep identifiers (`1-2`, `G-…`) as they are.

- **Input:** your story (`state.get`), its worktree (`story.start` resumes it), the main branch.
- **Output:** a qualification (`story.merge_conflict`), the story's branch updated with the main
  branch and the conflict resolved, a new pull request text, the story sent to review again.

## When

- `state.next` gives `merge_conflict` for your story: a conflict you qualified is waiting to be resolved,
  or the creator answered the decision you opened.
- A merge failed with `MERGE_FAILED` `conflict` (the branch conflicts with the main branch),
  `conflict_unqualified` (you resolved one nobody qualified), `conflict_unverified` or
  `not_mergeable` (the forge saw a conflict the engine did not: your copy of the main branch is
  behind, fetch it first).

## Steps

1. **Resume.** `story.start` for your story resumes its worktree; work only there. Run `git fetch`
   first: the engine reads the main branch as your repository knows it, and a stale copy hides the
   conflict (a network command: record it with `guard.external_read` as the constitution says). Read
   `state.merge_order` (with `story`): its `conflict` says which files conflict and their class, and
   the `ceiling`.
2. **Qualify it first, before you resolve anything** (`story.merge_conflict`, your story):
   - **`textual`** only when the engine's ceiling allows it **and** you checked it yourself: in
     each file the two sides only add lines at the same place (two imports, two entries of a list,
     two functions side by side), or differ by spaces, and neither side changes the logic of a
     function the other one also changes. When in doubt, it is substantive. Give your `rationale`
     in a sentence.
   - **`substantive`** in every other case, and whenever you cannot tell: give your
     `recommendation` (`keep_story`, `keep_main` or `combine`) and a `rationale` the creator can
     judge. You may always raise a conflict to substantive; the engine refuses a textual
     declaration above its ceiling (`forced_substantive`).
   - A conflict that was already resolved on the branch without being qualified is qualified
     after the fact, the same way: the engine reads it from the merge commit.
3. **For a conflict of substance, wait for the creator.** The engine opened a decision with both
   versions and your recommendation; `state.next` shows it to the creator, Noah presents it, the creator
   chooses `keep_story`, `keep_main` or `combine`. The story cannot go back to review before. If
   they refuse every option, qualify again with a new recommendation.
4. **Resolve it on the story's branch.** In the worktree: `git merge <the main
   branch>` into your branch (`origin/main`, as `stories.<id>.started.base_ref` says). Never
   `git rebase`, never `git pull --rebase`, never rewrite the history, never force a push: the
   engine reads each merge commit and what it settled, and refuses a rebased branch. Then:
   - **textual:** keep every line of both sides, in the order that reads well. Dropping a line of
     either side is a choice, and a choice is not textual: the engine reads it (`conflict_dropped`).
   - **substantive:** apply the creator's option and nothing more: `keep_story` keeps the story's
     lines where the versions differ, `keep_main` the main branch's, `combine` both, carefully.
   - Remove every conflict marker (`<<<<<<<`, `>>>>>>>`): one left refuses the merge.
5. **Prove it.** Run the story's tests and the whole suite the repository runs; fix what the merge
   broke. Commit the merge on the story's branch with its usual message (it cites the story and a
   requirement).
6. **Deliver again.** `story.pr` updates the pull request on the new commit. Read the CI
   (`story.ci`): it must cover the new commit. Send the story to review (`story.status`
   `in_review`): a new pass follows, on the new commit, and the merge checkpoint the creator sees
   is refreshed with that pass and that commit, and says which conflict was settled and how.
7. **Report.** `story.result` with what you resolved, your assumptions and any open question.
   Then `agent.status` (`idle`) and `npx agentplugged next --json`, and tell the creator what it
   says.

## Never

- Never merge the story, never open or answer the creator's decision, never choose in their place.
- Never call a conflict textual to avoid asking: a choice between two versions is the creator's.
- Never rebase, never force a push, never rewrite the history of the story's branch.
- Never leave a conflict marker, and never lose a line you promised to keep.
- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
