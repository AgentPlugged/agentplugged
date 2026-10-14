# The creator's gestures on the stack

`stack` is sorted by the engine, the most structuring first (decisions, requirements, passages,
documents, stories under way then to do then done, criteria, hypotheses, pages). Ask once, in the
chat, with the lines as they are; one gesture each. They may answer some now and the rest later:
`step: show` with `item` (C-…) says what is left and what is still incoherent.

- **update**: it changes; its author does it (`handoff` says who). `gesture: update`.
- **retire**: for a requirement or a decision that goes: the identifier stays, marked retired
  (`(retired)` before its text), never deleted, never reused. `gesture: retire`.
- **keep**: it stays as it is, with their reason. `gesture: keep`, `reason`.

`step: decide` with `item`, `items` (`n`, `gesture`, `reason` for a keep) and `quote` (their words).
A story under way is held until its decision is taken: tell its developer (`blocked`).

Close with `step: close`: the engine finds every element marked update changed, every
retirement marked, no story citing a retired requirement, no
proof still valid for a requirement whose text changed (Quentin brings the register of proofs up
to date: hand it to Noah). While something is wrong it answers `problems` and writes nothing; an
update that is not needed becomes a keep, with a reason. Once whole, the course is closed.
