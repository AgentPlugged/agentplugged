# Reviewing the design part of the spec (short path)

Read when `state.next` says `step: security_review` and `full_path` is in `journey.skipped`:
there is no architecture, `.agentplugged/docs/spec.md` stands for it (its `AD-n` decisions, its
`ENF-n` requirements, its scope). The phase is not `design`: ignore that check of step 1. Same
skill, same result, same consequences as for an architecture; only the input and the size change.

## Steps 1 to 4, for the spec

1. `agent.status` (`working`, task "security review of the spec"), then `state.get`.
2. Read the spec and nothing else: no PRD, no UX specification, no architecture, no threat
   model exist. When the spec is not committed, or the working copy differs from the commit, say
   that Maya commits it first and stop; you never edit nor commit it yourself.
3. **Size the pass** from the spec alone, and say which one in the review's first line:
   - *Short pass* when the spec has no `AD-n` decision, `sensitive` is empty in its scope, no
     `ENF-n` concerns security and its text never speaks of personal data, payments, accounts or
     credentials (if it does, it is a full pass, whatever the scope says): one pass over what
     any product has, namely secrets (never in the code nor a log), input crossing a trust
     boundary (files, forms, arguments, an external service), dependencies (maintained, versions
     to verify) and what is logged. Two lines for the map, the findings or "no finding", the
     verdict: ten to fifteen lines in all.
   - *Full pass* otherwise: step 2 of the skill (assets, entry points, trust boundaries,
     actors) read from the spec, then step 3 for each `AD-n` and each dimension the decisions
     missed, with the scope's `sensitive` kinds and the security `ENF-n` as what is protected.
   A short pass is a review, never a skipped one: the review file and the result are always there.
4. Write `.agentplugged/docs/security-reviews/spec.md` from `assets/architecture-review-template.md`
   with `id: spec-security-review`, `kind: note`, `owner: chloe`, `links` naming the spec's `id`;
   the findings cite `AD-n`, `ENF-n` or "missing decision". Same checks, same commit as step 4.
   For step 4.7 the id of the reviewed document is
   `git rev-parse HEAD:.agentplugged/docs/spec.md`. The engine reads the file back: it must be
   in the working copy, say `owner: chloe`, and be the version the result cites.

## Step 5, the result

The first line is the one of step 5, unchanged (the engine reads it): in
`architecture=<blob>`, put the spec's Git blob id. The engine calls you again when the spec
changes before the stories are cut: update the same review and submit again.

## Consequences

- No blocking finding: Noah proposes the breakdown; the findings stay in the review for the
  stories' own security reviews.
- Blocking findings: the engine holds the stories until the creator answers. After submitting
  the result, open a `decision` checkpoint (high risk, no story, the findings in the summary)
  with three options whose ids are exactly `fix` (Maya corrects the spec, you review the new
  version), `full` (the full path, `step_resume` `full_path`: the spec becomes the base of the
  brief, the PRD and the architecture) and `accept` (the creator accepts the risk in their own
  words; the only answer that releases the stories). Never cut nor change anything yourself.
