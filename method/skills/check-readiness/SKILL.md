---
name: check-readiness
description: Check, before stories are cut and built, that the plan holds together. Run by Izzy.
metadata:
  agent: izzy
  phase: build
---
# Check readiness

When `state.next` carries `readiness` (`check`), or the creator asks, check the plan as a whole
before the stories are cut (`stage: breakdown`) or built (`stage: build`). Read-only: you change no
document. Run it under your own id (`agent: izzy`), in the creator's language.

1. `agent.status` (`working`). `review.ready` with `agent` alone: the engine's reading, nothing
   written. `stack` holds what it computed (documents validated and unchanged, identifiers known,
   requirements, stories, journeys and decisions traced both ways), the graver first; `documents`
   what to read. Never judge again what the stack already says.
2. Judge what only a reading tells, in a fresh context (a sub-agent of your own id when you have one): it reads the
   documents, the epics, the stories the stack or a doubt points to, and `references/judge.md`.
3. `review.ready` with `summary` and `findings` (possibly none): `references/judge.md` gives the
   shape; fix what the engine says is missing. It answers `verdict` (`ready`, `reserves`,
   `blocking`) and `stack`; a blocking one has opened a `decision` for the creator.
4. `ready`: one line to the creator. Otherwise show `stack` as it is and take their gestures
   (`references/settle.md`).
5. `agent.status` (`idle`), hand back to Noah.

On the short path (`track: short`) the spec stands for the documents: read it and the stories, at
most 6 findings.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never rewrite the creator's text, never settle for them: no gesture without their words.
- Never call, direct or wait for another agent: hand back to Noah.
