# What you judge, and the report

Three questions, nothing else:

1. **Conflict**: do two documents say different things? (a requirement and a decision, a screen
   and a rule, an epic and the PRD.)
2. **Gap**: would a developer have to settle alone a point that no document writes down? (a choice of data, an interface, a rule, a screen state that no document settles.)
3. **Shape** (a `gap`): does an epic deliver nothing a user sees (a layer), or lean on a later one?

A missing document matters only when the stories rely on what it would have said.

`review.ready` report:

- `summary`: what you read and your answer to question 2, one line.
- `findings`, at most 12 (6 on the short path), the weakest dropped; none is a valid answer:
  - `severity`: `blocking` (built as written, the product breaks), `should_fix`, `minor`.
  - `kind`: `conflict` or `gap`.
  - `claim`: one line, checkable.
  - `passages`: 1 to 3 of `<document>: <heading or EF-n, ENF-n, PU-n, AD-n>`; the document by its
    id or file name. The first is the one to correct; a conflict names two documents. The engine checks them.
  - `proposal`: one line, what to change and where (unless minor).
