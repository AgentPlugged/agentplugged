---
name: run-retrospective
description: Look back on a finished epic or sprint, propose lessons to the creator and record the approved ones in the shared memory. Run by Izzy.
metadata:
  agent: izzy
  phase: build
---
# Run a retrospective

## Overview

- **Step:** build, as Izzy (`agent: izzy` in every MCP call), on a finished epic or sprint.
- **Produces:** one retrospective proposed with `memory.retrospective`, recorded with
  `memory.record` once the creator approves; optionally a promotion (`memory.promote_propose`,
  `memory.promote`). No file: the engine writes the memory, encrypted, and only a retrospective the creator approves.
- **Reads:** `state.get`, `npx agentplugged history --story <e-s>`, `deferred list --all`, `trace`,
  `memory.read`: facts, never your recollection.
- **Validation point:** the `memory` checkpoint opened by `memory.retrospective`.

## Steps

1. **Scope.** `agent.status` (`working`); Izzy not active: `story.result` `partial`. Scope
   `{ kind: "epic", id }` or `{ kind: "sprint", id: "S-…" }` (from `npx agentplugged next --json`, else
   the creator's), finished per `state.get`. A `memory` checkpoint open or approved
   for it (`scope_taken`): say where it stands, stop. Sent back (`changes_requested`): read the note
   (`checkpoint.resolution.note`); this run answers it.
2. **Facts.** The stories of the scope (`state.get { story: "<id>" }`) and the sources above. Two
   occurrences make a candidate lesson.
3. **Memory first.** `memory.read`: active lessons and the last follow-ups (`actions`; say which
   were done). A lesson already there is not repeated; a contradicting one `replaces` it (old id) or is dropped; a wrong one is `retire`d with a reason. Warning
   `product_key_missing`: tell the creator (`npx agentplugged key import`),
   stop.
4. **Write.** A lesson: title 120 characters at most, text 1,000 at most (what to do or avoid,
   **why** by story id, **when**); a way of working, not a fact of the code; no secret nor personal
   data; `agents` when not for everyone, `tags` (five at most). An action: one line of 300 characters with its `owner` (an agent
   id or `creator`). At most 12 each of lessons, retirements, actions; fewer is better. `summary`: 1,500 characters at most.
5. **Propose, then ask once.** `memory.retrospective` with `scope`, `summary`, `lessons`, `retire`,
   `actions`. `MEMORY_INVALID` wrote nothing: `scope_not_finished`, `scope_taken`, `lesson_unknown`,
   `lesson_conflict`, `memory_full`. It returns the
   checkpoint `G-…`, `R-…` and the lesson ids; the checkpoint shows **counts only** (encrypted). **Only now**, with the checkpoint open, present the
   retrospective whole in the chat (numbered lessons with id, title, text; replacements; retirements; actions with owner), say what you recommend, ask once. Never with
   `chat.ask` (counts only: `answered: false`). Ask them to name lessons by number (their words are in clear). `chat.answer` with their whole message: `approved`; "oui, sauf la 2"
   `approved_with_reservations` (words as `note`); a change `changes_requested` (correct, call
   `memory.retrospective` again); a refusal `rejected`.
6. **Record.** `memory.record` (`checkpoint`). With reservations `except` is required
   (`except_required`): an empty list, or the ids to leave out (lessons, retired `L-…`, actions
   `R-…-A1`); a whole approval refuses it (`except_not_allowed`). On `error.memory_files_failed`, call it again. Offer `plan.defer` for the actions that are work.
7. **Promote (optional).** At most two lessons, after the record, free of any product name, path or story. `memory.read` again (a
   `source: common` lesson saying the opposite is `replaces`d by its `C-…`), then
   `memory.promote_propose` with `lesson` and `replaces`, one lesson per call. With the checkpoint
   open, present it in full and say plainly that every product of theirs on this machine will read
   it; ask once; `chat.answer`; once approved, `memory.promote` with the checkpoint.
8. **Hand back.** `story.result` `complete` (what was recorded, assumptions, questions, conflicts);
   `agent.status` `idle`; `npx agentplugged next --json`, tell the creator. Hand back to Noah, who
   proposes what comes next; the creator decides (without Noah, they pick the next agent).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never write a lesson except through `memory.retrospective`, nor record or promote one the creator did not approve in this conversation.
- Never copy a lesson or an action into a document, a commit, a pull request or a message outside the chat: the memory is encrypted.
- Never promote several lessons in one checkpoint, nor one without telling the creator all their products will read it.
