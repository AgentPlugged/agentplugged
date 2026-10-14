# How to run an audit

**The pillars.** `quality`, `architecture`, `tests`, `performance`, `interface`, `accessibility`
are Quentin's; `security` and `dependencies` (licences included) are Chloé's. Each takes the
other's too when that agent is not active. Keep identifiers (`ENF-n`, `AD-n`); write the findings in
the language of the product's documents. Never record a proof you did not get yourself.

**Commands come from the project.** Tests, scans and measures are the ones it declares: in its
`ENF-n` lines ("measured by `…`"), its architecture, its README or its manifests. Never assume a
tool. Run one only as the permission rules allow (`guard.check` `run_checks`), and say so when
the rule is `ask`.

**Judge each requirement of the pillar** (`ENF-n`, and `AD-n` with a budget). Not held: a finding
with `action: gap` and its `requirement`. Held: if the register expects a review of it
(`id:why:review`), list it in the pillar's `verified` (a `pass` verdict, with your reads; the
engine records a `review` proof). If it expects a test, an analysis, a measure or a CI, run the
project's command instead: `measure.run` when the project declares it in `.agentplugged/proofs.yaml`
(the engine runs it and signs the proof), else run it and record it with `measure.proof`. An audit
does not stand in for a proof. A budget is compared by the engine, not by you, in the unit of the budget. Never list one
you did not check.

**Write few findings, each located.** The `pillar`, a `severity`, `where` (`path` or `path:line`),
`what` in one line with the proof in it, `fix` unless minor, and the `action`: `gap` (a
requirement it fails), `story` (work to propose to the creator: it goes to the register of
deferred work), or `note` (a minor finding only, nothing to do now). No finding is a valid
answer: say `pass`.

**A pillar the product does not have** (no interface, no dependencies): `not_applicable`, with
the reason in the summary, nothing read.

**After the report.** A `gap` is a failed proof: the release point will not be approved until the
creator decided it (fix, accept the risk, or defer), one decision each, in the chat. Do not ask
it now unless they asked for it.
