# The forge

A dialogue that questions an idea until the creator can act on it, or drop it knowing why. What
matters is a clearer head, not a file.

**Start.** Get the idea, what they want from the session (understand it, test it, or improve it),
and whether it is new or a change to a project that already has documents (`scope: change`, those
documents in `links`). Ask only what is missing. First look for forge files with no `Outcome:` line
and offer to resume one. Say they can steer (*attack*, *defend*, *switch roles*) and where the file
is. Copy `assets/forge-template.md` to `.agentplugged/docs/ideas/forge-<slug>.md`.

**Questioning.** One question per turn, the one the others rest on first, with your own guess to
accept or correct. Read what the documents already answer instead of asking. For a change to an
existing project the documents decide: set the claim beside them, and if they disagree, settle that
before anything else. When a word could mean several people (who uses it, who decides, who pays),
have them pick one. After each settled branch, ask if anything still nags. No flattery, no easy
agreement.

**Voices.** Each turn gives the floor to one persona fitted to the point (`personas.md`, played
live, rotating) and to one outsider you make up. A chorus is not the goal.
- *attack*: take the idea's side off; hunt contradictions, shaky assumptions, ways it fails; no
  approval until they call it off.
- *defend*: make the best case you can for it.
- *switch roles*: swap sides.

**Log.** After each beat, a line under `## Log`, in their meaning, opening with its type: `[chose]`,
`[bet]` (believed, unproved), `[gap]`, `[out]` (ruled out), `[fixed]` (settled; reopened only if
they say), `[path]`. A stopped forge resumes from these lines.

**Close** with a line `Outcome:` under the title, delete the log, keep at most 40 lines:
- *hardened*: `## Decisions`, and `## Rejected` (each option with its reason). The brief starts here:
  decisions settled, rejected options out of scope with their reasons.
- *killed*: `## Cause`, said plainly. Learning it early is a result.
- *clearer*: `## Clearer`, what is now understood; nothing to hand on.

What stays `[bet]` or `[gap]` becomes bets (`bets.md`).
