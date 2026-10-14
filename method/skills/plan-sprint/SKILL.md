---
name: plan-sprint
description: Propose the next sprint from the validated stories (goal, order, budget, capacity), check it with the creator, then record it. Run by Izzy in the build phase.
metadata:
  agent: izzy
  phase: build
---
# Plan a sprint

A sprint is a promise the creator can hold the team to: what will be delivered, in what order,
for how much, and by whom. This skill builds that promise from what already exists — validated
stories, their budgets and their dependencies, and the people and agents available — and records
it in the journal, where `state.next` and every agent read it. The engine checks the proposal and adds
up the budgets; it estimates nothing itself, and it refuses (`budget_out_of_range`) a story budgeted
more than three times off the product's measured range or the method's reference. The judgement
is yours, and the decision is the creator's.

This skill belongs to Izzy. Run it as Izzy, with `agent: izzy` in every MCP call. Work in the
creator's language; keep identifiers (`1-2`, `S-…`, `G-…`) as they are.

- **Inputs:** the stories of `.agentplugged/stories/` and their epics, `state.get` (statuses,
  done stories, the sprint in force), `.agentplugged/method.yaml` (`profile.specialties` and
  `profile.max_parallel_stories`).
- **Output:** one sprint, recorded with `plan.sprint`. No file: the journal holds the sprint.
- The creator may ask for the next sprint at any time, even while the current one runs. A story
  started and not finished may move on to the next sprint.

Follow the steps in order. Each one ends with what it must have produced.

## Step 1 — Check where the product stands

1. Call `agent.status` (`working`, task "sprint planning").
2. Call `state.get`:
   - `phase.current` must be `build` (or null when the profile has no phases). Otherwise, say
     which phase is current and what closes it, and stop.
   - `sprint.latest` with `status: proposed`: a proposal already waits for the creator. Tell
     them its checkpoint (`checkpoint`) and stop: `plan.sprint` refuses a new one meanwhile.
   - `sprint.latest` with `status: refused`: read the creator's note on its checkpoint
     (`state.get { checkpoint: "<id>" }`, then `checkpoint.resolution.note`). This run answers that note.
   - `sprint.current`: the sprint in force. List its stories still `todo`, `in_progress`,
     `in_review` or `blocked`: they are the first candidates for the next sprint.
3. Run `npx agentplugged docs check`. A story that fails it cannot enter a sprint: name it and
   its problem, and leave it out (its owner, or you for the breakdown, fixes it first).

**Produces:** the phase confirmed, the state of the last sprint, and the list of stories that hold.

## Step 2 — List the candidates

A story is a candidate when all of these hold:

- it is **validated**: an approved `document` checkpoint lists its file (the end of the
  breakdown) at its current content: a story edited since, even its header, must be validated
  again. `plan.sprint` refuses any other with `not_validated`;
- it is **not done**: no `story` checkpoint of it was approved after its last status;
- its header is complete: `owner`, `budget_usd`, `depends_on`.

For each candidate, note its owner, its budget and its dependencies, and whether each dependency
is done. Build the order from the dependency graph: a story comes after every dependency that is
not done yet. When several orders are possible, prefer, in this order: what unblocks the most
other stories, what carries the most user value for the epic in progress, what reduces a risk the
architecture or the creator named.

**Produces:** the candidates, in a valid order, each with its owner, budget and dependencies.

## Step 3 — Ask for the capacity and the budget

Ask the creator, in one message:

- **the developer agents** who will work in this sprint. Propose the active ones:
  `profile.specialties` in `method.yaml` lists the active specialties (`sam` and `ethan` for
  backend, `hugo` and `lina` for frontend, `jade` for mobile, and any developer the creator added
  with a specialty of their own). One developer may build several stories at once, each one an
  instance of its own (the pair developer and story), up to `profile.max_parallel_stories` stories
  in progress when it is set; small changes go to the developer of their story, in the quick lane.
  Name only agents that are active;
- **the humans** who will build stories themselves (stories whose `owner` is `creator`), as a
  number;
- **the budget ceiling** for the sprint, in US dollars, if they want one.

Never assume a capacity the creator did not confirm. When the answer is "same as last time",
reuse `sprint.current.capacity`.

**Produces:** `capacity.agents`, `capacity.humans`, and the ceiling or none.

## Step 4 — Propose the sprint

1. Write a **goal**: one line of at most 112 characters, what a user will be able to do at the
   end of the sprint. Not a list of stories.
2. Pick the stories, in order, from the candidates:
   - every dependency of a story is done or comes earlier in the sprint;
   - every story's owner is in the capacity (`creator` needs at least one human). Otherwise,
     propose to change the story's owner with the creator, or leave it out;
   - the total of the budgets stays under the ceiling. Cut from the end of the order, never by
     breaking the order;
   - the load is plausible for the capacity: a developer agent finishes a story at a time, and a
     sprint gives each one a few stories, not dozens. Say plainly when the wish does not fit.
3. Present the proposal: the goal; the stories in order, each with its owner, budget and what it
   waits on; the total against the ceiling; the capacity; the risks (a long dependency chain, a
   story with open questions, an owner with too many stories); and what was left out and why.
4. Revise with the creator until they agree. A change of story owner is a change to the story:
   make it in the story's header (never in its intent), run `docs check`, and commit it.

**Produces:** a goal, an ordered list of stories, a capacity and a ceiling the creator agreed to.

## Step 5 — Record it

1. Call `plan.sprint` with `agent: izzy`, the `goal`, the `stories` in order, the `capacity`
   (`agents`, `humans`), the `budget_limit_usd` when there is a ceiling, and a `summary`: the
   reasons for the order, the risks, and what was left out. The engine composes the checkpoint
   the creator reads from the sprint it checked: the stories, owners, budgets, total and capacity.
2. On `SPRINT_INVALID`, nothing was written. Read every problem in `details.problems` and fix
   the proposal, never the rules:
   - `unknown_story`, `unreadable`, `invalid_story`: a wrong id, a file that cannot be read,
     or a story that fails `docs check` (`why` lists its problems);
   - `not_validated`: the story's breakdown was never approved (`why: never`), or the story
     changed since (`why: changed`); leave it out, or have the creator validate it again;
   - `done`: the story is already done; leave it out;
   - `dependency_missing`, `dependency_later`: add the dependency earlier, or move the story
     later;
   - `agent_inactive`, `no_capacity`, `owner_unavailable`: fix the capacity with the creator;
   - `over_budget`: cut stories from the end, or ask the creator to raise the ceiling;
   - `proposal_open`: a proposal already waits for the creator;
   - `too_long`: the checkpoint shows your summary and one line per story, never cut. Shorten
     the summary to `max` characters, or plan fewer stories (`field: stories`).
   If the creator must decide anything to fix it, go back to step 4 with them.
3. On success, `plan.sprint` returns the sprint (`sprint`: `S-…`) and its checkpoint
   (`checkpoint`: `G-…`). Ask whether the sprint suits them only now, once, since the
   checkpoint is open: present it in the chat and record the creator's answer with
   `chat.answer`, quoting their words (constitution, "Checkpoints in the chat"): they
   approve it, or ask for changes.

   When other checkpoints are open at the same time as the sprint's, present those that are
   plain approvals as one stack (constitution, "Stacks to validate"); the sprint's own checkpoint
   keeps its own answer, which sets the stories' ceilings.

**Produces:** a sprint recorded in the journal, and its checkpoint open.

## Step 6 — Hand over

1. Call `story.result`: `complete`, a summary naming the sprint and its checkpoint, your
   assumptions (a capacity you inferred, a budget you found low), the open questions, and the
   conflicts (a story that cannot fit any order).
2. Call `agent.status` (`idle`).
3. Run `npx agentplugged next --json` and tell the creator what it says. While the checkpoint is
   open, it is in `waiting`; its `step` is `validation` once the sprint in force, if any, has no
   story left to start. Once the creator approves it, the sprint is in force: `state.next` proposes its
   stories one by one, in order, each to the owner the sprint recorded (else the first active
   agent of its capacity, else the creator); when none is left to start and the started ones are
   done, it calls you again for the next sprint, or for the breakdown when no story left can be
   planned. You never call a developer yourself: hand back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never invent an amount: the budgets are the ones the stories carry (each read from `state.get`
  `usage.estimates`), a sprint's total is their sum, and when you tell it to the creator you say
  what it rests on (`history` or `reference`) and its range. The capacity is the one the creator
  confirmed.
- Never put a story that is not validated, or already done, in a sprint, and never break the
  dependency order.
- Never write a sprint file, nor edit a story's intent: the sprint lives in the journal.
- Never start, call or direct a developer agent: the sprint is a plan, not a launch.
