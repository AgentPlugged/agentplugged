# The creator's gestures on the objections

The stack is the one question that opens no checkpoint: `review.critique` records the gestures with
the creator's words.

1. Ask once, in the chat, with `stack` as the engine gave it: for each objection, one gesture.
   - **correct**: keep it; the document's author corrects it. `gesture: fix`.
   - **hypothesis**: keep it and follow it until its proof. `gesture: hypothesis`.
   - **drop**: with their reason. `gesture: discard`.
   They may answer some now and the rest later; to show what is left (a new session, a hand-over),
   call `review.critique` with `item` (the critique, K-…) alone: it answers `stack` (what is not
   sorted) and `fix` (what is kept for correction). Never choose for the creator.
2. Settle: `review.critique` with `item`, `items` (`n`, `gesture`, and `reason` for a `discard`)
   and `quote` (their words). The engine answers `fix`: `owner`, the author, and `proposals`, what
   to change. Hand them over; the author changes the document and gets it validated again (an
   `owner` of `creator` means the creator writes it: offer the proposals, change nothing). For a
   hypothesis, tell the creator its id (H-…).
3. A hypothesis lives on in `state.get` (`critique`). When `state.next` brings one back
   (`hypotheses_due`: a proof arrived, a story citing the passage was delivered), show the line
   and ask: proved, refuted, dropped, or still open. Close: `review.critique` with `item` (H-…),
   `items` with one entry (`gesture`: `proved`, `refuted`, `dropped` or `still_open`, and `reason`)
   and `quote`.
4. A new critique of the same version of a document is refused while its stack is not sorted
   (`critique_unsorted`): sort it, or drop what the creator does not keep, with their reason.
