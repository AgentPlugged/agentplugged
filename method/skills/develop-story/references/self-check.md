# Self-check before handing over a story

Run each check in the story's `workdir`. Fix what fails, then run the list again. A check you
cannot run is written in the result as an open question, never skipped in silence.

## The intent

- [ ] The `## Intent` section of the story is the one the creator approved, in its latest
      approval: in `state.get`, the last approved `document` checkpoint listing the story file
      gives its `blob_sha` (`state.get { checkpoints: { type: "document", status: "resolved" } }`,
      newest first; `before` goes further back). `git show <blob_sha>` prints that version; its `## Intent` section and
      the one of the story on your branch are the same, word for word. If they differ, copy the
      approved section back over yours, and only that section (never restore the whole file:
      the other sections may hold changes the creator asked for), then commit.
- [ ] `npx agentplugged docs check` reports no problem, and no `STORY_INTENT_CHANGED` above all.

## The scope

- [ ] Nothing is copied from elsewhere in the repository: each piece the plan said "I reuse" is
      reused, each "I create" has its reason in the result.
- [ ] Every change serves an acceptance criterion of the story. What does not is removed, or
      named in the result as a note for the creator.
- [ ] No file of `.agentplugged/` changed besides what the story asks for; no method file, no
      generated file.
- [ ] No decision of the architecture is worked around; a decision that seemed wrong was raised,
      not bypassed.

## The tests

- [ ] Each acceptance criterion maps to at least one test, named in the result.
- [ ] Each of those tests was seen failing before the code, then passing, by the engine
      (`story.criterion`: `trace` shows every criterion `green`, or `untestable` with its reason).
- [ ] The whole verification passes: type checks, linter, every test suite, the build.

## The branch

- [ ] Every commit cites the story and at least one of its requirements.
- [ ] `git status` is clean: nothing left uncommitted, nothing outside the `workdir`.
- [ ] Nothing was pushed, and no pull request was opened by this skill.

## The result

- [ ] Every `decision` checkpoint opened on the story is resolved and its answer built; otherwise
      the result is `partial`.
- [ ] No cost is announced: the engine measures it (`measure.cost` only for what the tool shows, never an amount).
- [ ] The result lists the assumptions, the open questions and the conflicts, each in one line.
