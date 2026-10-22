# Reviewing the design part of the spec (short path)

Read when `state.next` says `step: security_review` and `full_path` is in `journey.skipped`: no
architecture exists, `.agentplugged/docs/spec.md` stands for it (its `AD-n`, `ENF-n`, scope). The
phase is not `design`: ignore that check. Same result and consequences as the architecture.

## Steps 1 to 4, for the spec

1. `agent.status` (`working`), `state.get`. Read the spec and nothing else. Spec not committed or
   changed in the working copy: Maya commits it first; you never edit nor commit it.
2. **Size the pass** from the spec alone, and say which in the review's first line:
   - *Short pass*: no `AD-n`, `sensitive` empty in its scope, no security `ENF-n`, and no mention
     of personal data, payments, accounts or credentials (else a full pass): secrets, input at a
     trust boundary, dependencies (versions to verify), what is logged. Ten to fifteen lines in all.
   - *Full pass* otherwise: the map (assets, entry points, trust boundaries, actors) read from the
     spec, then each `AD-n` and each missed dimension, with `sensitive` kinds and security `ENF-n`
     as what is protected.
   A short pass is a review, never a skipped one: the file and the result are always there.
3. Write `.agentplugged/docs/security-reviews/spec.md` from the template: `id: spec-security-review`,
   `kind: note`, `owner: chloe`, `links` naming the spec's `id`; findings cite `AD-n`, `ENF-n` or
   "missing decision". Same checks, same commit. The reviewed id is
   `git rev-parse HEAD:.agentplugged/docs/spec.md`; the engine reads the file back: in the working
   copy, `owner: chloe`, the version the result cites.

## The result

The same first line, unchanged: in `architecture=<blob>`, put the spec's Git blob id. The engine
calls you again when the spec changes before the stories are cut: update the same review.

## Consequences

- No blocking finding: Noah proposes the breakdown; the findings stay in the review.
- Blocking findings: the engine holds the stories. After the result, open a `decision` checkpoint
  (high risk, no story, findings in the summary) with options whose ids are exactly `fix` (Maya
  corrects the spec, you review the new version), `full` (`step_resume` `full_path`: the spec
  becomes the base of the brief, PRD and architecture) and `accept` (the creator accepts the risk
  in their own words; the only answer that releases the stories). Never cut nor change anything.
