# Closing: synthesis and gesture

When the creator ends the conversation (never before, never in their place):

1. **The best ideas**, a few lines, then the **synthesis**, five lines at most for each part: what
   they agree on, where they differ (who holds which side), and your recommendation. A guest's lead
   in law, health or finance stays a lead to check. Show it as it will be recorded.
2. **Gesture**, one closed question, four choices:
   - **decision**: a point of decision. `subject` the question, `owner` an agent of the team who
     spoke (never a guest); that agent opens it with `checkpoint.open`, the synthesis as context.
   - **story**: Izzy writes a story from it. `subject` its title.
   - **document**: its author updates a document. `subject` its path in `.agentplugged/docs/`.
   - **none**: nothing follows.
   Objections to follow, aimed at a brief, PRD, UX spec or architecture: Quentin
   (`agent.delegate`) runs `critique-deliverable` on it with them as the points to test; those kept
   become hypotheses (H-…).
3. **Record** with `chat.table` on their answer: in `table`, `agents` (all of the team who spoke:
   `id`, `why`), `guests` (`id`, `role`, `why`, `field`), `synthesis` (`topic`, `agreed`,
   `disputed`, `advice`), `gesture`, and for a saved room `room` and `memory`; their words in
   `quote`. A refusal lists what is missing: fix it, ask again only what is unclear.
4. The engine answers `owner` and `advice`: hand both over with `agent.delegate`, in the owner's own
   words. `owner: creator` (no author in the team): give the creator the points, change nothing. If
   refused (no Izzy, no such document), say why in one line and offer another, or `none`.
5. Offer once to keep a new guest in a saved room (`references/rooms.md`).
