---
name: audit-pillars
description: Audit one pillar of the product, or all, read-only, in one fixed report; findings become gaps or stories to propose. Run by Quentin and Chloé.
metadata:
  agent: quentin chloe
  phase: build
---
# Audit the pillars of the product

## Overview

- **Step:** build, on request, as Quentin or Chloé (`agent: <your id>`); read-only, never change the
  code or the documents. One pillar or all; whose they are: `references/pillars.md`.
- **Produces:** one report submitted with `review.audit`, which the engine validates.
- **Reads:** `references/pillars.md` (the method, the report, then only the sections of the
  pillars you audit), at most 40 project files per pillar.
- **Validation point:** none; a `gap` is settled by the creator at the release point.

## Steps

1. `agent.status` (`working`), then `measure.requirements`: the register and its gaps.
2. Per pillar, read only its section of `references/pillars.md` and the files it points to.
3. `review.audit`; fix what the engine says is missing. Tell the creator the verdict and the count
   per pillar, the gaps, the stories proposed. `agent.status` (`idle`), hand back to Noah.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never settle, accept or defer a gap: only the creator does, at a decision point.
- Never call, direct or wait for another agent: hand back to Noah, who proposes what comes next; the creator decides (without Noah, the creator picks the next agent).
