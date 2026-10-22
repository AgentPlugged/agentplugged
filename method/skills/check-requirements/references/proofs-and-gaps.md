# Proofs and gaps of the non-functional requirements

**What counts as a proof** (`measure.proof`: `requirement`, `source`, and `passed` or `measured`).
The register says which kind each requirement expects (`id:why:proof` in its gaps). A command the
project declares is run by the engine (`references/engine-proofs.md`): prefer it. Otherwise report
the result of the project's own command you ran (`reported`). Never record a proof you did not get.

- `test`: source `path:line` of a test that cites the requirement; `passed` is the test command's word.
- `ci`: source the story id (`1-2`) whose CI the engine read; it decides, you give no `passed`.
- `analysis`: source the declared command; `passed` is its result.
- `measure`: source the declared command; give `measured` in the unit of the budget. The engine compares; you never say pass.
- `review`: never typed in: it comes from the audit (skill `audit-pillars`, `verified`).

A proof
holds while the requirement is unchanged and no story covering it is delivered after it.

**When the release point is refused** (`RELEASE_NOT_READY`, the requirements `id:why`; the end of
the delivery phase is held the same way):

1. `measure.requirements` again (the register follows the PRD and architecture as they are now).
2. Get each missing proof: `measure.run`, else the project's command and its real result.
3. For each requirement still failing, one `decision` point with `checkpoint.open`, titled for it
   ("Gap on ENF-3"), two lines on what is missing and its cost, exactly the options `fix` (a story
   is proposed; the release waits), `accept` (the creator takes the risk and says why), `defer` (to
   a version they name). Recommend `fix`. One point per gap, used once.
4. Ask in the chat, one point at a time; relay their choice with `checkpoint.gap`: `requirement`,
   `option`, the point's id, their reason in their own words (`defer`: the version).
5. When none is left, the release point can be approved; the engine refuses otherwise, and says which.

Never accept, defer or fix a gap for the creator, nor reword their reason.
