---
name: quick-lane
description: Carry a small change (one story, no public interface, no migration, fewer than 5 files) through the quick lane, with its story, review and validation. A mode of the developer.
metadata:
  agent: sam ethan hugo lina jade
  phase: build
---
# The quick lane

Some changes are too small to go through framing, planning and design: a fix, a wording, a
forgotten case. The quick lane carries them straight to a tested pull request. What it skips is
the paperwork upstream, never the story, the tests, the independent review nor the creator's
validation before the merge, and it hands a change back the moment it stops being small.

The quick lane is a mode of the developer the story goes to, carried by the story (the fast track
of the engine, `fast_track` in `state.get`): there is no dedicated agent. The developer of the
story's specialty (backend, frontend, mobile, or a specialty the creator added) runs this skill
under their own id: `agent: <your id>` in every MCP call. Work in the creator's language; keep
identifiers (`1-2`, `EF-n`, `AD-n`, `G-…`) as they are.

- **Input:** one story of `.agentplugged/stories/`, if only one line long, whose `owner` is you.
- **The creator's Git workflow:** the story lands where `git` in `state.next` says (the integration branch, or the main branch), with or without a branch of its own, a pull request, a CI or a review, as the creator chose; the quick lane never changes that.
- **Output:** the change and its test, committed on the story's branch (`feat/<story>-<slug>`, the
  one its header names) in its own working copy, then its pull request; or, when the change is not
  small, the way back to the full lane with a checkpoint that explains it to the creator.

## Triage a reported bug

When the creator reports a bug, ask for the symptom, where it shows and how often. Reproduce it,
find the cause and size the fix against the limits of the quick lane below. Report the cause, the
files involved, the test that would prove the fix and whether it fits the quick lane or needs the
full lane, before changing anything. When one reading of the code and one run of the
reproduction do not give the cause, the bug is not trivial: do not start the quick lane, do not
guess; say so and follow `diagnose-bug` (hypotheses kept by the engine), in the full lane.

## The limits

A change fits the quick lane only when all of these hold. The engine reads what it can in the
repository; you declare what only you can know.

| Limit | Who checks it |
|---|---|
| it fits in one story | the engine: the story has its file, is validated and is yours |
| it touches fewer than 5 files, tests included (a renamed file counts twice) | the engine, on the diff of your branch |
| it adds no dependency | the engine: no dependency manifest nor lockfile is touched; you declare a dependency a manifest does not show |
| it needs no data migration | the engine: no migration nor schema file is touched; you declare the rest |
| it changes no public interface | the engine reads the files of an interface's contract (API descriptions, schemas, type declarations); you declare the rest |
| its goal has a single reading | you declare it |
| no step of it is irreversible | you declare it |

A quick change always has a story, if only one line long: when none exists, ask the creator to
have Izzy write it (or to write it themselves) before you start. Check the limits before starting;
the engine checks them again at every pull request and every CI read.

The review before merging always happens: by Quentin, and Chloé for security, or by the creator
when the product's profile has no quality agent. The creator validates the merge, the engine
merges: the quick lane changes nothing there.

## Leaving the quick lane

The way back to the full lane is final, and there are two ways to it:

- **The engine** sends the story back when it reads a commit of your branch that no longer fits
  (5 files or more, a dependency manifest, a migration, an interface's contract): the result of
  `story.pr` or `story.ci` says `fast_track` with `left: true`, and the story is
  `blocked`.
- **You** leave the moment the goal can be read two ways (`ambiguous_intent`), a step could not be
  undone (`irreversible_action`), the change keeps growing (`growing_scope`), or it needs a public
  interface change (`public_interface`), a data migration (`data_migration`) or a new dependency
  (`new_dependency`). Stop at once, never bend a limit to keep a change, and:

1. Call `story.leave_fast_track` with the `reasons` (each once) and a `detail` that says what you found.
   The engine records the exit, blocks the story and opens, in the same write, the `decision`
   checkpoint that explains it to the creator (continue in the full lane, or stop). Do not open a
   checkpoint of your own, do not call `story.status`.
2. Call `story.result` with status `partial`: what is done, what you found, what is left.
3. Recommend the full lane: framing or design when needed, then the story built with the
   `develop-story` skill. The creator decides; the story stays blocked until they answer.
4. Leave the branch as it is, with a note of what it holds.

Whether a change may take the quick lane when in doubt, and any step out of it, belong to the
creator: you recommend, the creator decides.

## Steps

1. **Start.** Call `agent.status` (`working`, the story as `story`). Read `state.get`:
   `phase.current` must be `build` (or null when the profile has no phases); otherwise say which
   phase is current and what closes it, build nothing, and go to step 8 with `partial`. When
   `state.get` shows that you are not an active agent of the product, say so and go to step 8
   with `partial`.
2. **Read the story.** Read the change's story entirely, the requirements and decisions it cites,
   the parts of the architecture (`.agentplugged/docs/architecture.md`) the change touches —
   the product's stack and conventions are there, whatever they are — and the knowledge base
   pages about it (`.agentplugged/docs/index.md` first; a page with an `agentplugged:late` notice is
   behind the code: read the code, assert nothing from that page). When there is no story, stop and ask the
   creator to have Izzy write a one-line story (or to write it themselves): no quick change
   without a story. A story already started in the full lane stays there (`already_started`, whoever started it). Run
   `npx agentplugged docs check` and report what it finds instead of working around it.
3. **Check the limits.** Restate the change in one sentence, then check it against each limit
   out loud: which hold, which do not. When one fails, the change belongs to the full lane: say so
   to the creator and build nothing.
4. **Take the working copy.** Call `story.start` with `fast_track`: `summary` (the sentence of
   step 3) and `declared` (`single_reading`, `reversible`, `no_public_interface`, each `true`).
   The engine creates the story's branch from the main branch in a working copy of its own and
   records that the story is in the quick lane; it refuses (`FAST_TRACK_NOT_POSSIBLE`,
   `declaration`) when you cannot declare one of the three, and never enters the quick lane for a
   story already started. Work only in the `workdir` it returns; never on the main branch nor in
   another story's working copy.
5. **Build.** Write a test that reproduces the problem or proves the change, watch it fail, then
   make it pass, fixing the cause, not only its symptom (`story.criterion`).
   A criterion a test already covers needs no red: a passing test is enough. Commit with a message that cites the
   story and the requirement it touches, for example `fix(2-3): empty name refused (EF-12)`.
   Call `story.progress` as you go.
6. **Verify.** Run the project's whole verification, as its CI does, even for a one-line change:
   type checks, linter, every test suite and the build. Then check the limits again on what you
   actually changed; when one gave way, go to "Leaving the quick lane".
7. **Open the pull request.** Call `story.pr`: the engine pushes the branch (never the
   main branch, never a force-push), opens the pull request with the fixed template — the story,
   the linked requirements, the acceptance criteria checked, the test results —
   and reads the changes of your branch against the limits (`fast_track` in its result). If it
   says `left: true`, go to "Leaving the quick lane" step 2 onwards: the exit is already recorded.
   Call `story.status` (`in_review`). Read the CI with `story.ci` as the full lane does. Never
   merge: the review before merging always applies, and the creator validates and the engine
   merges.
8. **Report.** Announce no cost (the engine measures it in the tool's traces), then `story.result` with the story:
   `complete`, `partial` or `blocked`, a summary, your assumptions, open questions and conflicts
   (empty lists when there are none). Call `agent.status` (`idle`), run
   `npx agentplugged next --json` and tell the creator what it says.

## Budget

The story carries a budget (`budget_usd`): an estimate, never a ceiling. You write no cost: the
engine measures what your session consumed and keeps it in the journal.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never take a change without its story, nor bend a limit to keep a change in the quick lane.
- Never enter the quick lane for a story already started, nor go back to it after leaving it.
- Never skip the test, the full verification, the independent review nor the creator's validation before the merge.
- Never push to the main branch, force-push nor merge.
- Never leave a quick change half done: it is finished or handed back, with the reason.
- Never call, direct or wait for another agent: hand back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).
