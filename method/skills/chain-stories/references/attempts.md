# Approaches and attempts (the developer's side)

Put this in the brief of the developer you hand a story to. The success condition is the story's
acceptance criteria (`until`): the tests of its criteria, run by the engine (`story.criterion`).
While one fails, the developer tries again, within a limit, and never repeats a failed approach.

- **Before an approach:** `story.loop { agent, story, note }`, one line saying what you will
  try ("recompute the total at checkout"). The engine refuses an approach that is one already
  tried and failed (`approach_failed`, with those approaches), a second one while the first is not
  reported (`attempt_open`), and any once the limit is reached (`attempts_exhausted`).
- **After it:** `story.loop { agent, story, seen: "failed", note }` with the line that mattered
  (the test, the message), or `seen: "green"` once every criterion holds: the engine checks
  them itself and refuses (`CRITERIA_NOT_PROVEN`) while one does not.
- **The limit is three failed approaches.** The third opens a point for the creator in the same
  write; stop there and say so in your result (`blocked`). They may allow three more; the approaches
  that failed stay failed.
- An approach is a way of doing, not a try of the same way: another file, another algorithm,
  another cut of the problem. A close rewording is the same approach, and the engine refuses it.
- Never declare an approach for a story you did not build, and never to hide a test.
