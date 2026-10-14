# The bets

The bets (risky objections, what is left `[bet]` or `[gap]` after a forge, `[open]` questions and the
`Soft` and `Breaks` items of the verdict) are one line each in the stack the
engine returns after the report. Same gestures and calls as the skill `critique-deliverable`
(`.agentplugged/skills/critique-deliverable/references/gestures.md`), with this difference:

- offer two gestures: **keep as a hypothesis** (`hypothesis`: the product follows it until its
  proof) or **drop** (`discard`, with their reason). `fix` stays possible: the creator changes
  their idea or document, and you change nothing without their say.
- a kept bet shows in `state.get` and comes back with `hypotheses_due` when the first story is
  delivered; close it only with their words (proved, refuted, dropped, still open).
- each report is sorted before it is made again (`critique_unsorted`); for the idea, which has no new version, the bets are sorted one by one, dropping with a reason.
- on a release (`kind: prfaq`) the `passage` is a heading of `prfaq.md` (`Release`, `Customer FAQ`, `Internal FAQ`, in the document's language), the engine checks it; on the idea it is a free label.
