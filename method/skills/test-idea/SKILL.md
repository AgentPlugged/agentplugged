---
name: test-idea
description: Forge an idea by dialogue, test it on skeptical personas, or write its press release first; risky bets become hypotheses. Run by Iris.
metadata:
  agent: iris
  phase: framing
---
# Test an idea

On the creator's ask, or when `state.next` carries `critique` with `kind: idea`. One exercise or
more, they pick. Run under your own id (`agent: iris`), in their language. Write only
`.agentplugged/docs/prfaq.md` and `.agentplugged/docs/ideas/forge-<slug>.md`.

1. `agent.status` (`working`). Read the brief and the documents that exist; without any, ask for the
   idea in a few sentences and keep their words. Name the concept type: `references/concept.md`.
2. **Forge** (clarify, test or improve it): `references/forge.md`. It ends hardened, killed or clearer.
3. **Test**: `references/personas.md`. The personas attack in a fresh context (one sub-agent plays
   them in turn when you have one: the idea and that file, never your reasoning). Say the synthesis in a few lines.
4. **Press release**: `references/prfaq.md`, `faq.md`, `verdict.md`. Write it with them from
   `assets/prfaq-template.md`; open its `document` checkpoint and ask once.
5. **Bets**: report them (`kind: idea` after the forge or the test, `prfaq` after the release), then the
   creator's gesture on each: `references/bets.md`.
6. `agent.status` (`idle`), hand back to Noah.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never rewrite their idea, brief or release without their gesture; never settle or close for them.
- Never call, direct or wait for another agent: hand back to Noah.
