# The shape of the critique report

One answer, whole; the engine refuses one that is not and lists what is missing. Write in the
language of the document. Few objections, each aimed at a passage: at most 12, the weakest dropped.
No objection at all is a valid answer when the method found none.

`review.critique`, one call with:

- `kind`: the document, `brief`, `prd`, `ux` or `architecture` (of `.agentplugged/docs/`).
- `lenses`: the method, one entry, or two to blend (`references/choose.md` lists the identifiers).
  A `reconcile` holds at most 5 objections, alone, on a `prd`, `ux` or `architecture`.
- `summary`: why this method for this document, one line.
- `findings`, the objections, each with:
  - `severity`: `blocking` (the product built on this breaks or misses its point), `should_fix`, `minor`.
  - `claim`: the objection as a statement, one line. It is what a hypothesis kept from it will say.
  - `passage`: a heading of the document, or an identifier it holds (`EF-3`, `ENF-2`, `AD-5`).
    The engine checks it is there.
  - `argument`: what in the passage breaks, and what follows. The proof, never a feeling.
  - `proposal`: one line, what to change in the document (unless minor).
  - `proof`: one line, what would show the objection true or false (unless minor): a measure,
    a test, a user's answer, a delivered story.

A claim is checkable: "the export may time out above 10 000 rows" can be proved or refuted;
"the document is vague" cannot. Give the same objection once. Never rewrite the document in the
report.
