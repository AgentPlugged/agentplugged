---
name: order-merges
description: Tell the creator in which order the stories ready to merge will merge, what holds each back, and which conflicts with the main branch. Run by Izzy.
metadata:
  agent: izzy
  phase: build
---
# Order the merges

> **The creator's Git workflow, not the method's.** Read `git` in `state.next` or `state.get` before you act: the branch a story lands on is `git.branches.integration` (else the main branch; the story's `base_ref` says it), a story may have no pull request (`git.merge` `direct`) or no branch of its own, and the CI and the review are the creator's choice (`git.ci` `none`, `git.review` false). Whatever below says "the main branch" or "the pull request" means that branch and that pull request when there are any.

When several stories are ready to merge and touch the same files, the second one merged finds the
main branch moved: a conflict, and a merge that would have gone through an hour earlier. The
engine orders the merges so that this happens as little as possible, and refuses a merge out of
its order. This skill reads that order and puts it in front of the creator, in words. You never
choose an order, never merge, and never resolve a conflict: the order comes from what the creator
validated (the stories' dependencies, the sprint), the merge from the creator's answer, the
conflict from the story's developer.

This skill belongs to Izzy. Run it as Izzy, with `agent: izzy` in every MCP call. Work in the
creator's language; keep identifiers (`4-2`, `G-…`) as they are.

- **Input:** `state.merge_order`, `state.get`, and `next --json` (`merge_queue`).
- **Output:** a short statement for the creator and a structured result. No file, no event of
  your own: the engine already holds the order.

## When

- `state.next` shows `merge_queue`: at least two merge checkpoints wait for the creator.
- The creator asks which story to merge first, or why a merge was refused (`MERGE_FAILED` with
  `out_of_order`, `dependency_unmerged`, `dependency_cycle` or `conflict`).

## Steps

1. **Start.** Call `agent.status` (`working`, task "ordering the merges").
2. **Read the queue.** Call `state.merge_order`. Each story of `queue` has:
   - `position`: its place. 1 merges first. A position of 0 is a dependency loop: it has no place.
   - `waits_for`: the stories that merge before it. `dependency`: it depends on that story.
     `overlap`: they change a file in common (the one in front of the other merges first, because
     the order says so; two stories with no file in common merge in any order).
   - `blocked`: `dependency_unmerged` (a dependency of the story is neither delivered nor ready:
     name it, `dependency`) or `dependency_cycle`.
   - `conflict`: what merging the story into the main branch would conflict on, as the engine
     reads it. `status: conflict` lists the files and their class; `ceiling` says what the story's
     developer may declare: `textual` (only added lines at the same place, or spaces) or
     `substantive` (the creator chooses between two versions). `status: unknown`: Git cannot read
     it here, say so.
   - `open_conflicts`: conflicts a developer already qualified and that are not settled yet.
3. **Say it.** In a few lines: the order (1, 2, 3 …), then for each story after the first what
   holds it back, in one short phrase each, and each conflict (the story, the files, the ceiling).
   End with the one thing that is next: the first story's merge checkpoint, and the creator's
   question about it. Never present the order as your choice: it is the engine's.
4. **A story in conflict.** It is not yours to resolve. Tell the creator which story conflicts and
   that its developer qualifies it (`story.merge_conflict`), resolves it on the story's own
   branch, and sends it back to review; Noah hands it to that developer. A conflict of substance
   becomes a decision the creator takes in the conversation, with both versions and the
   developer's recommendation.
5. **When the order is not what the creator wants.** Say what decides it (the dependencies, the
   sprint, the opening of the checkpoints) and what could change it: a dependency or a sprint the
   creator validates again, or a story the creator sends back for changes (it then leaves the
   queue). Never offer to skip the order, and never touch the stories' headers yourself to change
   it: a header changed after its validation is refused.
6. **Report.** Call `story.result` (`complete`) with the order in the summary. Then
   `agent.status` (`idle`) and `npx agentplugged next --json`, and tell the creator what it says.

## Never

- Never merge, nor ask another agent to; never call `gh` or `glab`.
- Never reorder, never promise an order the engine did not give, never hide a conflict.
- Never resolve a conflict, nor qualify one on a story you did not build.
- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
