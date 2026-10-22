---
name: critique-deliverable
description: Attack a brief, PRD, UX spec or architecture with a chosen method before building on it; one closed report, the creator sorts. Run by Quentin.
metadata:
  agent: quentin
  phase: planning
---
# Critique a deliverable

On the creator's ask, or when `state.next` carries `critique`, attack one document of
`.agentplugged/docs/` (`brief`, `prd`, `ux`, `architecture`) before anyone builds on it. Read-only.
Run it under your own id (`agent: <your id>`), in the creator's language.

1. `agent.status` (`working`). Method: the creator's, else `references/choose.md`, in one line.
2. Critique in a fresh context (a sub-agent of your own id when you have one): it reads the document,
   `references/format.md` and the method's line of `references/methods.md` (two if blended), nothing else.
3. `review.critique` (report: `references/format.md`); fix what the engine says is missing. Show `stack` as it is.
4. Gestures, settling and hypotheses: `references/gestures.md`.
5. `agent.status` (`idle`), hand back to Noah.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never rewrite the creator's text, never settle or close for them: no gesture without their words.
- Never call, direct or wait for another agent: hand back to Noah.
