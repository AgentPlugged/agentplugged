---
name: check-requirements
description: Compare a started story's work with the requirements it cites, during the build and at the latest before the merge; report and verify each deviation. Run by the quality reviewer.
metadata:
  agent: quentin
  phase: build
---
# Check a story against its requirements

A story cites requirements (`EF-n`, `ENF-n`, and the decisions `AD-n` it must follow). This skill
compares what was actually built with what those requirements say, and records every gap as a
deviation in the journal: the creator then sees it on the story, on its pull request and on the
requirement, and the story is not merged while one is open. It never fixes the code: the story's
developer does.

This skill belongs to the quality reviewer. Run it under your own id: `agent: <your id>` in every
MCP call. Work in the creator's language; keep identifiers (`1-2`, `EF-n`, `AD-n`, `V-…`) as they
are.

- **Input:** one started story of `.agentplugged/stories/`, its branch, and the documents it cites.
- **Output:** a deviation (`V-…`) per gap found, recorded with `story.deviation`; the deviations
  you verified fixed, lifted with `story.lift_deviation`; and a structured result. No code change, no
  push, no merge.

## When

- **During the build:** when the story's developer reports progress on a criterion, or when the
  creator asks, compare what is already committed.
- **Before the merge, at the latest:** once the story is in review and its pull request is open,
  compare the whole branch. A story whose deviations are not all lifted is never merged.
- **After a fix:** when the developer moves the story back to review, compare again: lift what is
  fixed, report what is still wrong or newly wrong.

## Steps

1. **Start.** Call `agent.status` (`working`, the story as `story`). Read `state.get`: the story
   must be started (`stories.<id>.started`) and not done; its open deviations are in
   `deviations.open`. Otherwise say so and go to step 8 with `partial`.
2. **Read the story, and only what it cites.** The story file, entirely (its `requirements` and
   its four sections). Each requirement it lists, in the PRD: the requirement itself and the
   journey it belongs to. Each decision `AD-n` it cites, in the architecture. Never the rest of the
   repository "to get a feel".
3. **Read the trace.** Call `state.trace` with each requirement of the story: its status, its stories,
   the tests that cite it (`path:line`), the pull requests of its stories and its deviations. A
   test cites a requirement by writing its id in its name, in a comment or in its file's name:
   `EF-18`, or `EF_18` where a name takes no dash, in a test file. `state.trace` reads the tests of
   the working copy the MCP server runs in, usually the main checkout: the tests of a story not
   merged yet live on its branch. Look for them there too, in the story's worktree
   (`stories.<id>.started.worktree`) or with `git grep -n -i -E "(EF|ENF)[-_]18" <branch> --`,
   before you conclude anything about them. When `tests.status` is not `read`, the trace says
   nothing about the tests.
4. **Read what was built.** In the story's worktree (`stories.<id>.started.worktree`), or from its
   branch (`git diff <base>...<branch>`, `git log <branch>`): the code the story changed, and the
   tests it added or changed. Note the commit you compare (`git rev-parse <branch>`).
5. **Compare, requirement by requirement.** For each requirement the story cites:
   - what it asks, as written (every condition, limit, error case and non-functional bound);
   - what the code does, with the file and line that show it;
   - which test proves it: a test that cites the requirement and checks that very behaviour. A
     requirement of the story that no test on the story's branch cites is a deviation
     (`no test cites EF-n`), unless the story says how it is checked otherwise; never conclude it
     from the main checkout alone.
   Then for each acceptance criterion: met, with its test, or not. A gap between the code and a
   requirement or a criterion is a deviation; a matter of taste is not. When the requirement
   itself is ambiguous, do not guess: say so in your result (an open question).
6. **Report each deviation.** One `story.deviation` per distinct gap: the `story`, the
   `requirements` it drifts from (only requirements the story cites), a one-line `summary` of what
   differs, a `detail` with what the requirement says, what the code does and where (file and
   line), and the `commit` you compared. The engine attaches it to the story's pull request when
   there is one, and sends a story in review back to its developer. Never report the same gap
   twice: read `deviations.open` first.
7. **Verify the fixes.** For each open deviation you reported on the story: when the code and its
   test now satisfy the requirement, call `story.lift_deviation` with the deviation and how it was
   fixed (the commit). Lift only the deviations you reported, and only once verified; another
   agent's deviation is its own to lift, and the creator may lift any, in the chat. A
   deviation on a story you built yourself is never yours to lift (`DEVIATION_NOT_ALLOWED`); when
   the agent that reported one is no longer active, ask the creator to lift it.
8. **Report.** Call `story.result` with the story: `complete` when the comparison ran to the end
   (whatever it found), `partial` when something kept you from it. A summary that lists, per
   requirement, `ok` or the deviation ids; your assumptions, open questions and conflicts. Then
   `agent.status` (`idle`) and `npx agentplugged next --json`, and tell the creator what it says.

## Proofs before a release

The release point is refused while a non-functional requirement lacks a valid proof:
`measure.requirements` (the gaps), then the proof: `measure.run` for a declared command
(`references/engine-proofs.md`), else `measure.proof`; then the creator decides the rest, one gap
at a time (`references/proofs-and-gaps.md`).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never change the code, the tests or the story: report, do not fix.
- Never report a deviation from a requirement the story does not cite (`not_linked`): a gap
  outside the story is a note for the creator in your result.
- Never lift a deviation you did not verify, nor one you did not report.
- Never merge, never approve a story: the creator validates.
- Never call, direct or wait for another agent: hand back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).
