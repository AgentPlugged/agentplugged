# Proofs and gaps of the non-functional requirements

**What counts as a proof** (`measure.proof`: `requirement`, `source`, and `passed` or `measured`).
The register says which kind each requirement expects (`id:why:proof` in its gaps); you give no
kind. A command the project declares is run by the engine itself (`references/engine-proofs.md`):
prefer it. Otherwise what you report is the result of the project's own command, that you ran,
marked `reported`. Never record a proof you did not get.

- `test`: the source is `path:line` of a test that cites the requirement (its id in the name or a
  comment); the engine looks for it. `passed` is what the project's own test command said.
- `ci`: the source is the id of a story (`1-2`) whose CI the engine read; it decides from that read
  (green or not), you give no `passed`. When stories cite the requirement, it is one of them.
- `analysis`: a scan or an analysis; the source is the command the project declares for this
  requirement. `passed` is its result.
- `measure`: the source is the declared command; give `measured` in the unit of the requirement's
  budget (`≤ 300 ms` takes milliseconds). The engine compares and decides; you never say pass.
- `review`: never typed in: it comes from the audit (skill `audit-pillars`, `verified`), for the
  requirements that expect a review.

A requirement whose wording is unclear (two budgets in one sentence, `1,000` that could be one or a
thousand) is a finding for the PRD's author, not a proof to invent: the register then expects a
test or an analysis. A proof stays valid while the requirement says the same and no story that
covers it is delivered after it (all stories, for a requirement none cites); then run it again.

**When the release point is refused** (`RELEASE_NOT_READY`, the requirements `id:why`). The end of
the delivery phase is held the same way.

1. Run `measure.requirements` again first: the register follows the PRD and the architecture as
   they are now, and tells what it no longer holds (`removed`).
2. Get each missing proof: `measure.run` for a declared command, else run the project's command
   and record the real result.
3. For each requirement still failing or without proof, open one `decision` point with
   `checkpoint.open`, its title naming the requirement ("Gap on ENF-3"), two lines on what is
   missing and what it costs, and exactly the options `fix` (a story is proposed; the release
   waits), `accept` (the creator takes the risk and says why), `defer` (to a version they name).
   Recommend `fix`. A point serves one gap and is used once; a failure recorded after it needs a
   new point.
4. Ask the creator through the chat, one point at a time. Once they chose, relay it with
   `checkpoint.gap`: the `requirement`, the `option`, the point's id and their reason in their own
   words (for `defer`, the version they named).
5. When none is left, the release point can be approved (by the creator, or by the agent they left
   this kind of point to): the engine refuses it otherwise, and says which.

Never accept, defer or fix a gap on the creator's behalf, and never reword their reason. A gap the
creator accepted stays accepted until the requirement changes; a new failing proof reopens it.
