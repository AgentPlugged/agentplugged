# Closing, saved rooms, three views

## Closing
Only when the creator ends it. Show, as it will be recorded: the best ideas (a few lines), then
the **synthesis**, five lines at most each: agreed, disputed (who holds which side), your advice.
Then one closed question, four **gestures**:
- **decision**: `subject` the question, `owner` an agent of the team who spoke (never a guest);
  it opens the point with `checkpoint.open`.
- **story**: Izzy writes it, `subject` its title. **document**: its author updates it, `subject`
  its path in `.agentplugged/docs/`. **none**.
- Objections to follow, aimed at a brief, PRD, UX spec or architecture: Quentin (`agent.delegate`)
  runs `critique-deliverable` on it; those kept become hypotheses (H-…).

Record with `chat.table` on their answer: `table` (`agents` with `id`, `why`; `guests` with `id`,
`role`, `why`, `field`; `synthesis` with `topic`, `agreed`, `disputed`, `advice`; `gesture`; `room`
and `memory` for a saved room) and their words in `quote`. A refusal lists what is missing: fix
it. The engine answers `owner` and `advice`: hand both over with `agent.delegate`; `owner:
creator`: give them the points, change nothing. Refused: say why, offer another or `none`.
