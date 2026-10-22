# The quick lane

A mode of the developer carried by the story (`fast_track`), never an agent. It skips framing and
design only.

- **Limits**, all of them: one story (a quick change always has a story, if one line long: else
  ask the creator for one); fewer than 5 files, tests included; no dependency; no data migration;
  no public interface; the goal has one reading; nothing irreversible. The engine reads what it
  can in the repository; you declare what only you can know.
- **A bug** whose cause one reading and one reproduction do not give: `diagnose-bug`, full lane.
- **Enter:** `story.start` with `fast_track` (`summary`, `declared`: `single_reading`,
  `reversible`, `no_public_interface`), on the branch `feat/<story>-<slug>`. Never enter the quick
  lane for a story already started (`already_started`).
- **Build** as `develop-story` (a criterion a test already covers needs no red); `story.pr` says whether it still fits (`fast_track`). The review before merging always happens (by the
  creator when the product's profile has no quality agent).
- **Leave** the moment the goal can be read two ways, a step could not be undone, the change keeps
  growing or needs an interface, a migration or a dependency: `story.leave_fast_track` with
  `reasons` and `detail` (it opens the creator's point), then `story.result` `partial`. The way
  back to the full lane is final. Never bend a limit to keep a change in the fast track.
- Never skip the test, the full verification, the independent review nor the creator's validation before the merge.
