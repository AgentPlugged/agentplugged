---
name: run-retrospective
description: Look back on a finished epic or sprint, propose lessons to the creator and record the approved ones in the memory every agent reads. Run by Izzy.
metadata:
  agent: izzy
  phase: build
---
# Run a retrospective

A retrospective turns what the team lived into what the team knows. It looks at a finished epic or
sprint, proposes **lessons** (what to do or avoid next time) and **actions** (what is owed), and
lets the creator decide what the team keeps. Lessons the creator approves go into the memory of the
product: every agent reads it with `memory.read` at the start of a task, so the same mistake is not
made twice. A lesson useful to every product of the creator can be promoted to the memory they
share on their machine, one promotion at a time, each one approved by them.

This skill belongs to Izzy. Run it as Izzy, with `agent: izzy` in every MCP call. Work in the
creator's language; keep identifiers (`4`, `S-…`, `G-…`, `L-…`, `C-…`) as they are.

- **Inputs:** the epic or sprint (from the creator's request, or the `scope` of `npx agentplugged
  next --json`), `state.get`, the history of the creator's validations, the deferred work, the
  deviations and the reviews, and the memory as it stands (`memory.read`).
- **Outputs:** one retrospective proposed with `memory.retrospective` and, once approved, recorded
  with `memory.record`; then, if the creator wants it, a promotion (`memory.promote_propose`,
  `memory.promote`). No file: the engine writes the memory, encrypted.
- Nothing enters the memory without the creator. You never write a lesson yourself, and the engine
  refuses it if you try: only an approved checkpoint records one.

Follow the steps in order. Each one ends with what it must have produced.

## Step 1 — Check the scope and the session

1. Call `agent.status` (`working`, task "retrospective").
2. Read the scope: `{ kind: "epic", id: "4" }` or `{ kind: "sprint", id: "S-…" }`. With
   `npx agentplugged next --json`, `scope` is the one due; otherwise take the creator's.
3. Call `state.get`: an epic is finished when every story of it is done, a sprint when its stories
   are done or a later sprint replaced it. A `memory` checkpoint already open or approved for this
   scope means the retrospective exists (`scope_taken`): tell the creator where it stands and stop.
   One sent back with `changes_requested`: read the creator's note (`state.get { checkpoint: "<id>" }`, then `checkpoint.resolution.note`),
   this run answers it.

**Produces:** the scope confirmed, free of an earlier retrospective.

## Step 2 — Gather the facts

Look at what happened, never at what you remember:

- `state.get`: each story of the scope (status, results, reviews: `state.get { story: "<id>" }`
  gives one in full),
  the
  checkpoints the creator refused or sent back (`state.get { checkpoints: { status: "resolved" } }`),
  the open questions and conflicts, the sprint (goal, what was left out).
- `npx agentplugged history --story <e-s>` for the creator's validations and their reasons;
  `npx agentplugged deferred list --all` for the work put off, with why; `npx agentplugged trace`
  for the deviations from the requirements.
- The notes of the creator in the chat during the scope, when you have them: what they corrected,
  what they asked twice.

Group the facts by theme: what went well and should be repeated, what cost time or money, what was
refused or reworked, what was misunderstood, what kept coming back. A theme with a single
occurrence is an anecdote; a theme with two or more is a candidate lesson.

**Produces:** a short list of themes, each with the stories that show it.

## Step 3 — Read the memory first

1. Call `memory.read` (`agent: izzy`). Note the active lessons (`id`, `source`) and the follow-ups
   of the last retrospectives (`actions`).
2. For every candidate lesson, decide against the memory:
   - **already there**: do not repeat it. If the facts show it was not followed, say so in the
     summary instead;
   - **contradicts an active lesson**: the new lesson **replaces** it (`replaces`, the old id), or
     you drop the new one. Never leave two lessons that contradict each other;
   - **an active lesson the facts show is wrong, or no longer true**: propose its retirement
     (`retire`, with the reason);
   - **new**: keep it.
3. Check the follow-ups of the last retrospectives: say which were done, which were not.
4. `warnings` of `memory.read`: `product_key_missing` means this machine cannot read nor write the
   product's memory (`PRODUCT_KEY_MISSING`): tell the creator, whose product key is on another
   machine (`npx agentplugged key import`), and stop.

**Produces:** the candidate lessons, each new, replacing or retiring something; the follow-ups' status.

## Step 4 — Write the lessons and the actions

A lesson is useful when an agent can apply it without asking anyone:

- **One lesson, one idea**: a title of one line (120 characters at most) and a text of at most 1,000
  characters that says what to do or avoid, **why** (the facts it comes from, by story id), and
  **when** it applies.
- **A way of working, not a fact of the code**: "run the contract tests before opening the pull
  request, two stories bounced on it" is a lesson; "the invoice module uses X" belongs to the
  knowledge base, not to the memory.
- **No secret, no personal data**, no name of a person, no key, no token, no address: the memory is
  read by every agent.
- **`agents`** names the agents the lesson is for (the developers of a specialty, the reviewers…);
  leave it out when it is for everyone. **`tags`** (five at most, lowercase, hyphens) say what it is about.
- A lesson says nothing about a language, a framework or a tool unless the product's architecture
  does: the method is not tied to a stack.
- **An action** is something owed, one line (300 characters), with its `owner`: an agent id, or
  `creator`. An action is not a lesson: "add a lint rule for X" is an action, "check X before
  merging" is a lesson. The engine does not track actions; you turn the approved ones into deferred
  work (`plan.defer`), stories at the next breakdown, or items of the next sprint.
- At most 12 lessons, 12 retirements, 12 actions. Fewer is better: five lessons the team applies
  beat twenty it forgets. Say plainly when the scope taught nothing new.

**Produces:** the lessons (with `agents`, `tags`, `replaces`), the retirements (with their reason),
the actions (with their owner), and a `summary` of what you looked at, 1,500 characters at most.

## Step 5 — Propose it, then ask once

1. Call `memory.retrospective` with the `scope`, the `summary`, the `lessons`, the `retire` and the
   `actions`. On `MEMORY_INVALID`, nothing was written: `scope_not_finished` (a story is not done:
   say which), `scope_taken`, `lesson_unknown` (an id that is no longer active: read the memory
   again), `lesson_conflict` (one lesson replaced or retired twice), `memory_full` (retire lessons
   in this same retrospective). `PRODUCT_KEY_MISSING`: tell the creator.
2. It returns the checkpoint (`G-…`), the retrospective (`R-…`) and the id of each lesson. The
   checkpoint shows **counts only**: the lessons are encrypted, so the creator reads them from you.
3. **Only now**, with the checkpoint open, present the retrospective in the chat, whole: each lesson
   numbered with its id, its title, its text, who it is for; what it replaces; each retirement and
   its reason; each action and its owner. Say what you recommend. Then ask once: all of it? all but
   some? changes?
4. Ask in the chat, never with `chat.ask`: the engine's form would show counts only and cannot
   carry reservations nor a refusal (it answers `answered: false`). Their answer, quote and
   note are recorded in clear in the journal: ask them to name lessons by number ("sauf la 2"), never to
   repeat a lesson's content.
5. Record the creator's answer with `chat.answer`, quoting their whole message:
   - "ok", "oui", "parfait" (a plain approval): `approved`;
   - "oui, sauf la 2": `approved_with_reservations`, their words as the `note`; the next step
     leaves out what they named (lessons, retirements and actions have ids);
   - a change they want: `changes_requested` with their words; correct the proposal, then call
     `memory.retrospective` again (the earlier one is sent back, so the scope is free);
   - a refusal, or "no retrospective for this one": `rejected`. The scope is set aside: `state.next` will
     not propose it again.
   A hesitation, a condition or a question is not an answer: say what you understood in one
   sentence and ask again.

**Produces:** the creator's answer recorded.

## Step 6 — Record what they approved

1. With `approved` or `approved_with_reservations`, call `memory.record` (`agent: izzy`,
   `checkpoint`). With reservations, `except` is required (`except_required`): an empty list when
   they leave nothing out, else the ids of the lessons, the retired lessons (`L-…`) and the actions
   (`R-…-A1`) they want left out. It only removes, never adds, and is refused with a whole
   approval (`except_not_allowed`). A lesson to retire or replace that is no longer active is
   left alone (`skipped` in the result).
2. The engine writes `lessons.recorded` and one encrypted file per lesson in `memory/lessons/`; a
   lesson replaced or retired stops being served. If it fails after the event (`error.memory_files_failed`),
   call `memory.record` again on the same checkpoint: it rewrites the missing files, with no
   second event.
3. Tell the creator in one line what was recorded (how many lessons, replaced, retired, left out).
4. Turn the approved actions into what they are: offer to defer the ones that are work (`plan.defer`),
   and note the ones for the next sprint planning.

**Produces:** the lessons recorded and served to every agent from now on.

## Step 7 — Promote a lesson to the shared memory (when it applies)

A lesson that says nothing about this product (no name, path, story, architecture decision) and
would help in every product of the creator can be shared with all of them on this machine. Offer it
for at most one or two lessons per retrospective, and only after the lessons are recorded; the
creator may also ask for it any time.

1. Call `memory.read` again: a `source: common` lesson that says the opposite is **replaced**
   (`replaces`, its `C-…` id), never left beside the new one.
2. Call `memory.promote_propose` with the `lesson` (its `L-…` id) and `replaces`. One lesson, one call:
   never several at once. Refused with `already_promoted`, `promotion_pending`, `lesson_unknown`,
   `common_unknown`, `common_unavailable` (this machine lacks its key for the shared memory).
3. With the checkpoint open, present the lesson in full and say plainly that **every product of
   theirs on this machine will read it**. Ask once; record the answer with `chat.answer` as in
   step 5 (`approved` or `rejected`).
4. Once approved, call `memory.promote` with the checkpoint. The entry is written, encrypted, in the
   creator's folder on this machine (nothing is sent anywhere), and the entries it replaces are
   superseded. Tell the creator in one line.
5. The shared memory belongs to this machine. Another machine starts from its own promotions: say
   so if the creator works on several.

**Produces:** a lesson shared with all the creator's products on this machine, or nothing.

## Step 8 — Hand back

1. Call `story.result`: `complete`, a summary naming the retrospective and what was recorded, your
   assumptions, the open questions (an action nobody owns), the conflicts (two lessons you could not
   reconcile).
2. Call `agent.status` (`idle`).
3. Run `npx agentplugged next --json` and tell the creator what it says. Hand back to Noah, who
   proposes what comes next; the creator decides (without Noah, the creator picks the next agent).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never write a lesson, a retirement or an action anywhere but through `memory.retrospective`, and
  never record or promote one the creator did not approve in this conversation.
- Never copy a lesson or an action into a document, a commit, a pull request or a message outside
  the chat: the memory is encrypted so that a public repository does not show it.
- Never propose a lesson with a secret, a personal name or a fact about the code that the knowledge
  base already holds; never leave two lessons that contradict each other.
- Never promote several lessons in one checkpoint, and never promote one without telling the creator
  that all their products will read it.
- Never decide for the creator what the team keeps: you recommend, they decide.
