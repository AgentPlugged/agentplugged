# The creator's gestures

Ask once, in the chat, with `stack` as the engine gave it: one gesture per finding.

- **correct** (`fix`): the author of the document corrects it.
- **accept** (`accept`): the creator keeps it as it is, with their own `reason`.

Beyond the twelve lines shown (`more`), settle these first, then check again. They may answer some now and the rest later. Settle: `review.ready` with `items` (`id` as in the
stack, `gesture`, `reason` for an accept) and `quote` (their words). The engine answers `fix`: for
each `owner`, the lines to hand over. The author changes the document and gets it validated again;
an `owner` of `creator` means the creator writes it: offer the lines, change nothing. After a
change, run the check again: a reading holds only for the documents it read (`judged: stale`).

A blocking verdict has opened a `decision`: correct first, or go on all the same. It is the
creator's alone; present it like any decision (`state.next` `decisions`).

The creator may skip the gate in a word (`step_skip` `readiness`): Noah records it, once.
