---
name: split-into-stories
description: Break the approved PRD, architecture and UX into epics and self-contained stories, check coverage and dependencies, then open the breakdown checkpoint. Run by Izzy.
metadata:
  agent: izzy
  phase: build
---
# Split into stories

This skill takes the approved plan of the product and turns it into work that a developer agent
can pick up, finish and hand over for review with nothing but the story in hand. It writes the
epics in `.agentplugged/epics/` and the stories in `.agentplugged/stories/`, proves with
`npx agentplugged docs check` that the breakdown holds, and ends with a checkpoint the creator
answers. It never plans a sprint: that is a separate step.

Work through the steps in order. Do not jump ahead: each step relies on what the previous one
settled with the creator.

## Rules that hold throughout

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Write only in `.agentplugged/epics/` and `.agentplugged/stories/`. The PRD, the architecture and
  the UX specification are read, never edited: a gap in them goes back to their owner (Maya, Alex,
  Stella) through the creator.
- Identifiers: an epic is `epic-<n>`, a story `<n>-<s>` (`2-6` is the sixth story of epic 2), the
  same id the journal uses. Story numbers follow the delivery order inside the epic, and epics
  follow each other in the order they can be built. Never renumber an id once the creator has
  seen it: add a new one, or mark the old one `(retired)` in its title.
- The order of the ids is the order of the work: `1-9` before `1-10` before `2-1`. A story may
  depend only on stories that come before it in that order. `docs check` refuses anything else.
- Report through the `agentplugged` MCP server: `agent.status` (`working`) when you start,
  `checkpoint.open` at the end, `story.result` with your assumptions and open questions, then
  `agent.status` (`idle` or `waiting`).

## The short path: a prototype to carry over

When the creator gave a complete prototype and chose the short path (no PRD, a light
architecture), cut it into a few stories, not a long list: one story per page or per group of
screens, each one naming the sections of the prototype to reproduce, the check that the rendering
matches (on a computer and on a phone, in each language the prototype has), and what stays as it
already is. Three to six stories usually carry a whole site. A story's budget is read in
`state.get` `usage.estimates` (the product's measured stories, else the method's reference), never a
figure guessed. Where `docs check`
asks for requirement identifiers the short path does not have, say it once to the creator and
cite the prototype's sections instead: never write requirements nobody asked for just to
satisfy it. The full breakdown stays possible if the creator prefers it.

## The short path: one spec

When `journey.skipped` holds `full_path`, `spec.md` stands for the PRD, the architecture and the
UX specification: read it whole instead of Step 1's documents, with the creator's approval of the
spec as the only gate (no closed phases to check). Its Stories part is your first draft of the
epics and stories; refine it with the creator and write them from the same templates.

## Step 1: check that the plan can be cut

1. Read `.agentplugged/docs/prd.md`, `architecture.md` and `ux.md` in full (skip `ux.md` only
   when the profile has no UX domain).
2. With `state.get`, check that the planning and design phases are closed (`phase.phases`): their
   `phase_end` checkpoints resolved `approved` (`state.get { checkpoints: { type: "phase_end", status: "resolved" } }`). A draft is not an input. If one is missing, say which and who
   owns it, and stop.
3. Check that the requirements carry stable identifiers (`EF-n`, `ENF-n`) and are testable, that
   the architecture answers what stories will need (stack, data, interfaces, decisions `AD-n`),
   and that the key flows of the UX specification are described. List each gap with its owner.
   Small gaps can be noted as assumptions; a gap that changes what gets built goes to the creator
   before you cut anything.
4. Check that the developers the plan needs are at work. Read `profile.specialties` in
   `.agentplugged/method.yaml` and compare it with the platforms the architecture and the PRD decide (a mobile
   app needs `mobile`, a website or a web app `frontend`, a service or an API `backend`). When a
   specialty is off, say it before you cut anything: you do not name an inactive developer as a
   story's owner (the engine refuses a sprint that does), and you do not give the work to another
   specialty to get around it. Hand back to Noah, who asks the creator to turn it on
   (`guard.creator_action`, `profile` or `agent_enable`); cut the plan once it is on, or, if the
   creator prefers, with the story owned by `creator`.

## Step 2: take the inventory

Build, for yourself, the full list of what the breakdown must carry:

- every active `EF-n` and `ENF-n` of the PRD, with a short label (a requirement marked
  `(retired)` is out);
- the architecture decisions (`AD-n`) that shape the work: a starter or template to set up first,
  the data model, the interfaces between parts, the infrastructure;
- the UX elements: flows, screens with their sketches, responsive rules, and each `UX-n` of the
  table "Elements to build" of `ux.md` (components, states, accessibility fixes), none dropped.

Show the inventory to the creator in a compact form, and ask whether anything is missing or
should be left out on purpose.

## Step 3: design the epics

1. Group the requirements into epics by user value: each epic lets a user do something they could
   not do before. Never cut by technical layer ("database", "API", "front end"): such an epic
   delivers nothing a user can see.
2. Order the epics so that each one works on top of the previous ones alone, never waiting on a
   later epic. When the architecture names a starter or template, the first story of the first
   epic sets it up.
3. Map every active `EF-n` and `ENF-n` to an epic. A requirement the creator decides to leave out
   of this breakdown goes into the `out_of_scope` list of the epic it would belong to, so that the
   choice is written down rather than forgotten.
4. Present the list: for each epic, its title, the user value in one sentence and the requirements
   it covers. Refine it with the creator until they agree.
5. Write one file per epic from `assets/epic.md.tmpl`: copy the template, keep its header keys,
   replace every value and every `<…>` placeholder (`docs check` refuses one left behind). In
   `links`, name only documents that exist: drop `ux` when the profile has no UX domain. Mention a requirement in backticks (`` `EF-1` ``),
   never as `EF-1 : …` at the start of a line: that would define it a second time, next to the
   PRD's definition, and `docs check` refuses it.

## Step 4: write the stories, one epic at a time

For each epic, in order, propose its stories to the creator, then write one file per story from
`assets/story.md.tmpl`, replacing every `<…>` placeholder and keeping in `links` only documents
that exist (no `ux` without a UX domain). Each story:

- is small enough for one developer agent to finish and one reviewer to check, ideally in a day of
  agent work; split anything larger;
- delivers something observable: a user can do it, or a later story can build on it;
- creates or changes only the data, files and interfaces it needs now, never "everything the next
  epics will use";
- carries the full header: `id`, `kind: story`, `owner` (the developer who will build it: an active
  developer of the specialty the story concerns, for example `sam` or `ethan` for the server and
  the data, `hugo` or `lina` for the interface, `jade` for the mobile applications; a small change
  goes to that same developer, who builds it in the quick lane), `links` (the documents it builds
  on), `title`, `epic` (`epic-<n>`, the epic of its id), `reviewer` (`quentin` for QA, or
  `creator` without a quality
  agent), `requirements` (the `EF-n`, `ENF-n`, `AD-n` it implements: at least one), `budget_usd`
  (the story's estimate in US dollars at the API's public prices, above zero: the `expected` of
  its lane in `state.get` `usage.estimates`, `standard` or `fast` for a small change, never a figure
  of your own; `plan.sprint` refuses a budget three times off that range), `branch` (`feat/<id>-<slug>`) and
  `depends_on` (earlier stories only). Never a status, a progress or a cost spent: the journal
  holds those;
- has the four sections, as level 2 headings:
  - `## Context`: everything the developer needs, by identifier: requirements, architecture
    decisions, screens, flows and the `UX-n` it builds, and the page of its screen in
    `ux-mockups/` if one is drawn (opened for visual detail only). Cite; do not paste whole
    documents;
  - `## Intent`: why the story exists and what it must achieve, in a few plain sentences. Once the
    creator approves the breakdown, this section belongs to the creator;
  - `## Acceptance criteria`: testable criteria, one per line, in "given, when, then" form,
    covering the error cases and edges, not only the happy path. A story that builds a screen
    takes that screen's sketch in `ux.md` as a criterion, by region number;
  - `## Out of scope`: what the story does not do, and which story does it, by id.

Write each story as if its developer will read nothing else. If a criterion only makes sense with
another story in hand, the cut is wrong: move the boundary.

## Step 5: check the breakdown

1. Run `npx agentplugged docs check` and fix everything it reports. Beyond the headers and the
   identifiers, it checks the breakdown:
   - `REQ_NOT_COVERED`: an active `EF-n` or `ENF-n` of the PRD is in no story's `requirements`
     and in no epic's `out_of_scope`;
   - `STORY_DEPENDENCY_FORWARD`: a story depends on a later one. Reorder the stories, or split
     the earlier one;
   - `STORY_DEPENDENCY_CYCLE`: stories depend on each other in a loop, or a story on itself;
   - `STORY_SECTION_INVALID`: one of the four sections is missing, empty or given twice;
   - `LAUNCH_DOCUMENT_INVALID` with reason `ux_element_uncovered`: a `UX-n` of `ux.md` is named in
     the Context or criteria of no story;
   - `DOC_PLACEHOLDER_LEFT`: a `<…>` marker of a template is still in a title or a section;
   - `DOC_HEADER_INVALID` and `DOC_LINK_DANGLING`: a field outside the contract, an epic, story or
     requirement that does not exist.
2. Then review what the command cannot see:
   - every story traces to at least one requirement, and its acceptance criteria actually cover
     the requirements it lists;
   - no story text refers to work that a later story does;
   - each epic works with the earlier epics only;
   - the budgets are plausible next to each other and read from `usage.estimates`. Tell the
     creator what they rest on (`basis`: `history`, the product's own measured stories, or
     `reference`, the method's prudent range because none is measured yet), always as a range
     (`low` to `high`), and the product's total as the sum of its stories, never a global figure.
     Never write an amount without that basis: an estimate without a base is not given.
3. Draw the dependency graph in each epic file (the `## Dependency graph` section of the
   template): one line per story with what it depends on, earlier stories only.

## Step 6: ask the creator to validate

1. Commit the epics and stories on your working branch, so that Git holds the exact files the
   creator will approve.
2. For each epic, open a checkpoint with `checkpoint.open`: `type: document`, `risk: medium`, no
   story and no blocks, a title naming the epic, a summary with the user value, the stories in
   order, the dependency graph, the requirements covered and those left out of scope, and your
   open questions. In `documents`, list the epic file and each of its story files, each with the
   branch and its Git blob (`git rev-parse HEAD:<path>`): at most 20 documents per checkpoint, so
   split a larger epic's stories over two checkpoints.
3. Only once the checkpoints are open, ask the creator whether the breakdown suits them, once.
   Several epics are one stack, never one question each: call `chat.stack_open` with the epics'
   checkpoints (2 to 16; a larger breakdown goes in several stacks), then `chat.stack_ask` when
   `validation.channels.available` holds more than `chat`. Otherwise (`answered: false` with
   `channel: "chat"`, or nothing to click) present the epics
   numbered, each with its title and a short summary, and record the creator's one message with
   `chat.stack_answer` ("j'approuve tout", "j'approuve 1, 2 et 4": constitution, "Stacks to
   validate"). A single epic, or one the stack refused, is answered with `chat.answer`
   (constitution, "Checkpoints in the chat").
4. End with `story.result` (`complete`), your assumptions and open questions, then
   `agent.status`, and hand back to Noah, who proposes what comes next; the creator decides
   (without Noah, the creator picks the next agent).

When the creator approves a checkpoint, the intent of each story it lists is frozen: `docs check`
fails as soon as that section differs from the approved version. From then on, never edit an
intent. When the creator wants to change one, they edit it themselves, or ask you to propose the
new wording; either way, the change counts only once a new `document` checkpoint listing the story
at its new blob is approved. Other sections may still be refined: say what changed in your result.
The creator's `review` card shows, for each story listed, the first lines of the intent it would
freeze and whether it replaces one already frozen; list the story files by their path under
`.agentplugged/stories/`, or the card and `docs check` cannot recognise them.
