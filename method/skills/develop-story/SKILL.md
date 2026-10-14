---
name: develop-story
description: Build one validated story from the story alone, in its own branch, tests first, criterion by criterion, up to a result that moves it to review. Run by the developers.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# Develop a story

A story is written so that a developer who reads nothing else can build it. This skill holds you
to that: you start from a fresh context, read the story and only what it cites, build it in its
own working copy, prove each acceptance criterion with a test, and hand back a structured result.
What the story does not say is never filled from memory or from a conversation: it is a question
for the creator.

This skill belongs to the developers: Sam and Ethan (backend), Hugo and Lina (frontend), Jade
(mobile), and any developer the creator added with a specialty of their own. Run it under your
own id: `agent: <your id>` in every MCP call. Each run is one instance of a developer, the pair
(developer, story), for example "Sam · story 4-2". Work in the creator's language; keep
identifiers (`1-2`, `EF-n`, `AD-n`, `G-…`) as they are. Build in the stack the architecture and
the knowledge base describe, whatever it is.

- **Input:** one validated story of `.agentplugged/stories/`, and the documents it cites.
- **The creator's Git workflow, not the method's:** read `git` in `state.next` or `state.get` before you start. The story lands on the branch it names (the integration branch when there is one, else the main branch). With no branch per story, `story.start` returns the main working folder (`story_branch: false`): build and commit there, and there is no pull request. With `git.merge` `direct`, `story.pr` answers `not_wanted`: send the story to review, the engine merges the branch itself. With no CI (`git.ci` `none`) read none; with no review (`git.review` false) the story goes straight to its merge point.
- **Output:** the code and the tests of the story, committed on its branch (`feat/<id>-<slug>`),
  and a structured result. No pull request, no push and no merge here: the pull request is a later
  step, the review belongs to Quentin and Chloé, the merge to the creator.
- **Annex:** `references/self-check.md`, in this skill's folder (also under
  `.agentplugged/skills/develop-story/`): the checks to pass before handing over.

## Before you start

- Forget the conversation that led here. What you know of the story comes from its file, the
  documents it cites and the journal (`state.get`); anything else is an assumption, and an
  assumption that changes what gets built is a decision for the creator.
- One story per run. When the creator names none, `npx agentplugged next --json` gives the story
  and the agent (`step: build`); a story whose `agent` is not you is not yours to take.
- Not an active agent of the product (`state.get`)? Say so and go to step 9 with `partial`.
- A small change (one story, no public interface, no data migration, no dependency added, fewer
  than 5 files touched) may take the quick lane instead, with the `quick-lane` skill: the story
  then carries the mode (`fast_track` in `state.get`). A story that left the quick lane
  (`fast_track.status` is `left`) is built here, in the full lane, once the creator answered the
  checkpoint that explains the exit: the way back is final. Whichever lane, the tests, the
  independent review and the creator's validation before the merge are the same.

## Decisions

The creator owns the intent of the story; you own how it is built.

- **Open:** when the story can be read two ways that lead to different code, when its intent,
  its acceptance criteria, its context or a document it cites contradict each other, or when the
  work needs a change of scope, a new dependency or anything irreversible: `checkpoint.open`
  with `type: decision`, a risk, `story` set to the story, a title, a summary that quotes the
  passages in conflict, two to four options (each with an `id`, a `label` and its
  `consequence` for the people who use the product), your `recommendation`, and `blocks` with
  `story.review` and `story.complete`. Never guess, never pick the option that is easiest to code.
- **Dependencies:** install what the work needs, without opening a decision; the creator's
  setting (`installs.mode`), the plain form of the command in the story's working copy
  (`cd <working copy> && <command>`, installations grouped) and what the architecture plans
  (`installs.declared` of `state.get`) are in the constitution, "Installing dependencies". Say what you installed and why in your result.
  A package the architecture does not plan and that lasts is an update of the architecture,
  approved again: never edit its `dependencies` to get around that. A change of scope, or a
  dependency that changes what the product is, stays a decision, as above.
- **Meanwhile:** go on with the criteria the decision does not touch, say which wait in
  `story.progress`; when nothing else is left, end with `partial`.
- **Apply:** once `state.get` shows the checkpoint resolved, read its `resolution` in full (`state.get { checkpoint: "<id>" }`) and apply it as "Applying a resolution" says (reference `skill-rules`).

  When you had marked the story `blocked` (`story.status`) while it waited, call `story.status`
  with `in_progress` again before you go on: only a story in progress moves to review with your
  result.
- **The intent stays as it is.** Never edit the `## Intent` section of the story (`## Intention`
  in French), not even a typo: it belongs to the creator once the breakdown is approved, and
  moving the story to review is refused while its branch changes it (`STORY_INTENT_CHANGED`).
  When the intent itself is wrong, open a decision; when the creator changes it, a new `document`
  checkpoint on the story makes it count. A gap in the other sections goes to Izzy through the
  creator; never rewrite them to fit what you built.

## Resume

A story may take several runs. Each run starts fresh: never rely on what a previous run kept in
mind.

- `story.start` resumes a story you started (`status: resumed`) and gives its `workdir` again;
  another developer's story is refused (`started_by_other`).
- Where it stands comes from `state.get` (`state.get { story: "<id>" }` gives all of `stories.<id>`) and from `git log` of its
  branch: the commits say which criteria are done. Pick up at the first criterion without a
  passing test.
- After a review or a red CI, fixing findings is another item of your menu (`FX`), on the same
  branch. When a review pass is closed (`state.next` gives `review_triage`, or `state.get` shows
  `review.untriaged` on the story), read its findings with `review.get` and sort each one with
  `review.triage` before anything else: `fix` (you fix it on the branch), `defer` (record it
  first with `plan.defer`, `origin: review`, the story, and give its `D-…`), or `reject` (with
  your reason), each with its root cause in one line, the same words for findings of one cause.
  The merge waits until every finding is sorted. Never review your own story. A deviation
  reported on the story (`deviations` in `state.get`, `V-…`) is such a finding: fix it on the
  same branch; the agent that reported it verifies the fix and lifts it.
- When the creator refused the story's merge or asked for changes (`state.next` gives
  `merge_changes`, or `state.get` shows `merge_feedback`), nothing was merged: read their note
  (`state.get { story: "<id>" }`, then `state.merge_feedback.note`), word for word, and take it up
  as your instruction, within the story's intent, on the same branch (`story.start` resumes the
  worktree). Then deliver again (`story.pr`), read the CI, and send the story to review. A note
  that would change the story's intent is the creator's call: say so, never rewrite the intent.
- When `state.next` gives `merge_conflict` for your story, or a merge failed on a conflict
  (`MERGE_FAILED` `conflict`, `conflict_unqualified`), the main branch moved under your story:
  follow the `resolve-merge-conflict` skill, which qualifies the conflict, merges the main branch
  into your story's branch and sends the story to review again. The merges of stories that touch
  the same files are ordered by the engine (`state.merge_order`): never merge, never reorder.

## Steps

1. **Start.** Call `agent.status` (`working`, the story as `story`). Read `state.get`:
   `phase.current` must be `build` (or null when the profile has no phases); otherwise say which
   phase is current and what closes it, build nothing, and go to step 9 with `partial`. Run `npx agentplugged next --json`: when it
   names a checkpoint waiting for the creator on this story, say so and go to step 9 with
   `partial`.
2. **Take the working copy.** Call `story.start` with `agent: <your id>` and the story. Work only
   in the `workdir` it returns, with your tool opened there: never in the main checkout, never
   in another story's worktree. On `STORY_NOT_STARTABLE`, tell the creator the `reason` it gives; on
   `STORY_LOCKED`, name the open item
   of deferred work that locks it. Either way, build nothing and go to step 9 with `partial`.
3. **Read the story, and only what it cites.** In the `workdir`:
   - the story file, entirely: its header (`requirements`, `links`, `depends_on`, `budget_usd`,
     `branch`) and its four sections;
   - each requirement it lists, in the PRD (`.agentplugged/docs/prd.md`): the `EF-n` and `ENF-n`
     themselves and the journeys they belong to, not the whole document;
   - each decision `AD-n` it cites, in `.agentplugged/docs/architecture.md`, and the stack and
     conventions the code must follow; the test strategy, `.agentplugged/docs/test-strategy.md`,
     when it exists;
   - the screens and flows it names in `.agentplugged/docs/ux.md`, when the story has a UX link;
   - the stories it depends on, only to know what they already deliver;
   - the knowledge base: `.agentplugged/docs/index.md` first, then the pages about what the story
     touches (conventions, the getting-started guide), each in full. A page with an
     `agentplugged:late` notice, or listed in `late_pages` of `state.next` (look before you rely on
     a page), is behind the code: read the code, assert nothing from that page. Read
     `reference/reusable.md` (what can be reused) in full when it exists.
   Then read the code the story will change, and nothing beyond what it needs; never another
   story's branch. Run `npx agentplugged docs check` and report what it finds instead of working
   around it.
4. **Check that the story can be built.** Every acceptance criterion is testable as written;
   the intent, the criteria, the context and the documents cited agree with each other; nothing
   needed is missing (an interface, a rule, a screen). Each gap that changes what gets built is a
   decision (see "Decisions"); a small one is an assumption you write down for the result. A selector,
   route or endpoint the code does not show yet: rate from 1 to 10 how sure you are of it; under 5,
   stop and ask the creator the one question that blocks most; from 5 to 6, write it and state the
   assumption.
5. **Plan.** First search what exists (the map `reference/reusable.md`, then the repository, by
   name and by what the code does) for each piece the story needs; the plan says "I reuse X" or
   "I create Y because…". The engine proves copied code, not two functions doing one job
   written differently: that search is yours. List each acceptance criterion with a scenario drawn
   from its words alone and the test that will prove it (its file, its name), and the files you
   expect to change. A criterion with no result to observe through the interface is declared
   untestable with its reason (`story.criterion`, `seen: untestable`): the review looks at it. Keep the plan inside the story's scope: what is
   useful but out of scope becomes a note for the creator. When the plan collides with a story in
   progress (`state.get`) on the same files, say so before you start.
6. **Build, criterion by criterion.** For each criterion, in order:
   1. write the test from the criterion's words, never the code; name it `AC-4-2-1` (story 4-2,
      criterion 1; `AC_4_2_1` where a name takes no dash) and cite the requirement it proves
      (`EF-18`, `npx agentplugged trace EF-18`); `story.criterion`: the engine runs the project's
      test command and records the red; watch it fail for the right reason
      (`references/acceptance-tests.md`);
   2. write the smallest code that makes it pass, following the conventions and the decisions,
      then call `story.criterion` again: the green;
   3. tidy up with every test still green;
   4. commit on the story's branch with a message that cites the story and the requirements the
      change touches, for example `feat(2-3): sign-in form (EF-12)` — the commit hook refuses any
      other message; never skip it;
   5. call `story.progress` with the percentage and the criterion done.
   Three failed attempts at one criterion mean the plan is wrong: open a decision or end with
   `blocked`, with what you tried.
7. **Verify everything.** Run the project's whole verification, as its CI does (type checks,
   linter, every test suite, the build). Fix what fails within the story's scope; report what
   fails outside it.
8. **Check before handing over.** Walk through `references/self-check.md` and fix what fails
   (the intent untouched, `npx agentplugged docs check` passing, a passing test per criterion).
9. **Hand over.**
   1. Everything you changed is committed: `git status` in the `workdir` is clean.
   2. Announce no cost: the engine measures it from the tool's traces. `measure.cost` stays for
      what the tool shows (a quota share).
   3. Call `story.result` with the story: `complete` when every criterion passes and no decision
      of the story waits; `partial` when something is left, with what; `blocked` when you cannot
      go on without the creator (it opens a checkpoint for you). A short summary the creator reads
      (800 characters at most, the outcome first: what is done, which test proves each criterion,
      what remains, what you expect from them; the long account goes in `story.progress` and the
      pull request; it never hides a failure); your assumptions, the open questions and the
      conflicts (empty lists when there are none). On a story you started that is `in_progress`,
      your `complete` result moves the story to review: refused with `CHECKPOINT_OPEN` while a checkpoint blocks the
      review, with `STORY_INTENT_CHANGED` while the branch changes the intent, with `CRITERIA_NOT_PROVEN`
      while a criterion lacks its red, its green or its declaration. Fix the cause,
      never work around it.
   4. Call `agent.status` (`idle`, or `waiting` when a decision waits).
   5. Run `npx agentplugged next --json` and tell the creator what it says: once the story is in
      review, the next step is its review, by Quentin, or by the creator when the profile has no
      quality agent. You never call another agent.

## Budget

`budget_usd` is Izzy's estimate, never a ceiling; you never write your cost.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never edit the story's intent, nor rewrite its other sections to match the code.
- Never build from a conversation, a memory or another story: only from the story and what it
  cites.
- Never work outside the story's `workdir`, never on the main branch, never in another story's
  worktree; never push, force-push, open the pull request or merge in this skill. Only the
  engine merges a story, once the creator approves its merge checkpoint; it then removes the
  story's worktree.
- Never mark a criterion done without a test the engine saw failing, then passing
  (`story.criterion`; your word is `reported`).
- Never call, direct or wait for another agent: hand back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).
