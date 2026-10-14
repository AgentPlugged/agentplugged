---
name: audit-pillars
description: Audit one pillar of the product, or all, read-only, and submit a fixed report; findings become gaps on requirements or stories to propose. Run by Quentin and Chloé.
metadata:
  agent: quentin chloe
  phase: build
---
# Audit the pillars of the product

On request, audit one pillar or all, read-only (never change the code or the documents), and
submit one report the engine validates, under your own id (`agent: <your id>`). Pillars, and whose
they are: `references/method.md`.

## Steps

1. `agent.status` (`working`), then `measure.requirements`: the register and its gaps.
2. For each pillar, read only its file `references/<pillar>.md` in
   `.agentplugged/skills/audit-pillars/` (never the other pillars' files) and `references/method.md`
   once; then only the files they point to, 40 at most.
3. `review.audit` (`references/format.md`); fix what the engine says is missing.
4. Tell the creator the verdict and the count per pillar, the gaps, the stories proposed.
   `agent.status` (`idle`), hand back to Noah.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never settle, accept or defer a gap: only the creator does, at a decision point.
- Never call, direct or wait for another agent: hand back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).
