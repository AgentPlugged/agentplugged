# The shape of the critique report

One whole answer; the engine refuses an incomplete one and lists what is missing. In the
document's language. 12 objections at most; none is valid if the method found none.

`review.critique`, one call:

- `kind`: `brief`, `prd`, `ux` or `architecture` (of `.agentplugged/docs/`).
- `lenses`: the method, or two to blend (identifiers of `references/choose.md`). A `reconcile`
  holds 5 objections at most, alone, on a `prd`, `ux` or `architecture`.
- `summary`: why this method, one line.
- `findings`, each with `severity` (`blocking`: the product breaks or misses its point;
  `should_fix`; `minor`), `claim` (one checkable line: it is what a hypothesis will say),
  `passage` (a heading or an identifier the document holds: `EF-3`, `ENF-2`, `AD-5`; the engine
  checks), `argument` (what breaks and what follows; proof, not feeling), and unless minor
  `proposal` (one line, what to change) and `proof` (one line: a measure, a test, a user's answer).

A claim is checkable ("the export may time out above 10 000 rows"), never "it is vague". Each
objection once. Never rewrite the document in the report.
