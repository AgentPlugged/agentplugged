# Lens: adversarial

Assume the change is wrong and find how. You read only the diff, the story and the decisions it
cites.

- What input, order, timing or state would make it fail, corrupt data, or do what nobody asked?
- What does it quietly assume (a caller, a format, a clock, one user at a time)?
- What breaks elsewhere because this changed: callers, other files of the diff, contracts?
- What would a hostile or careless user do with it?

- Efficiency: a call or a query per item of a loop; the same work done again; data loaded whole
  or without a limit to use a part; nothing bounding a size, a page or a retry.

A suspicion without a path to a wrong result is not a finding. Each finding says the steps
that lead to the failure. Answer shape: `format.md`.
