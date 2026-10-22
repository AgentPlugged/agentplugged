# Pillars and the report

**Whose.** `quality`, `architecture`, `tests`, `performance`, `interface`, `accessibility`: Quentin;
`security`, `dependencies` (licences included): Chloé; each takes the other's when that agent is not
active.

**Method.** Commands come from the project (`ENF-n` lines, README, manifests), never an assumed tool;
run one only as `guard.check` `run_checks` allows. Per `ENF-n` and budgeted `AD-n`: not held, a
`gap` finding with its `requirement`; held and the register expects a review (`id:why:review`),
list it in `verified` (verdict `pass`, with reads); any other expected proof is `measure.run` or
`measure.proof`: an audit stands in for none.

**Report** (`review.audit`, whole). `results`, one per pillar: `pillar`, `verdict` (`pass`,
`issues`, `not_applicable` + reason), `reads` (1 to 40 paths), `summary`,
`verified`. `findings`, few and located: `pillar`, `severity` (`blocking`, `should_fix`, `minor`),
`where` (`path:line`), `what` (one line, proof included), `fix` unless minor, `action`
(`gap` with `requirement`; `story` work to propose; `note` minor). A requirement is
`verified` or failed, never both. No secret, no verdict on the whole product. A
`gap` is settled by the creator at the release point: do not ask now.

**quality.** Biggest modules, lint settings: duplicated logic, swallowed errors, a broken `AD-n`.

**architecture.** The places that should obey each `AD-n`: crossed boundaries, two writers of one
datum, a decision nobody follows.

**tests.** Test strategy and `state.trace`: a requirement no test cites, a test that cannot fail or
is flaky, a wrong level. Test quality itself is the tests lens of
`review-story` (`review-story/references/tests.md`).

**performance.** The promised `ENF-n` and budgets, the path carrying each. Measure with the declared command in the budget's unit; none declared is a `story`
finding; never invent a number.

**security.** `threat-model.md` against the code: entry points, access, input, secrets, personal
data in logs (never copy a secret). Name the asset at risk.

**dependencies.** Manifests and lock files only: abandoned or vulnerable ones, a licence unfit for the distribution; list licences with counts; never install to audit.

**interface.** Each screen in its four states (data, empty, loading, error); a state not built is a
`story`. **accessibility.** Interface code and the declared checker; a `review` proof, never a
claim of conformance you did not test.
