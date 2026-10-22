# The creator's gestures on the objections

No checkpoint: `review.critique` records the gestures with the creator's words.

1. Ask once, in the chat, with `stack` as the engine gave it, one gesture per objection:
   **correct** (`gesture: fix`, the author corrects the document), **hypothesis** (`gesture:
   hypothesis`, followed until its proof), **drop** (`gesture: discard`, with their reason). They
   may answer some now; `review.critique` with `item` (K-…) alone answers `stack` and `fix`.
   Never choose for the creator.
2. Settle: `review.critique` with `item`, `items` (`n`, `gesture`, `reason` for a `discard`) and
   `quote` (their words). The engine answers `fix`: `owner` and `proposals`. Hand them to the
   author, who changes the document and has it validated again (`owner` `creator`: offer the proposals only). Tell the creator the hypothesis id (H-…).
3. A hypothesis lives on in `state.get` (`critique`). When `state.next` brings it back
   (`hypotheses_due`) ask: proved, refuted, dropped or still open; close with `item` (H-…), one
   `items` entry (`gesture` `proved`, `refuted`, `dropped`, `still_open`, `reason`) and `quote`.
4. A new critique of the same version is refused while its stack is unsorted
   (`critique_unsorted`): sort it first.
