---
name: run-acceptance
description: Replay the real journeys before a release and have the result validated. Run by Quentin.
metadata:
  agent: quentin
  phase: delivery
---
# Run the acceptance

## Overview

- **Step:** `acceptance` in `state.next` (delivery phase, before Omar prepares the release), as
  Quentin (`agent: quentin` in every MCP call); Omar answers for the environment and the release.
- **Produces:** `.agentplugged/docs/acceptance.md`, 60 lines at most, every line backed by a proof.
- **Reads:** the PRD journeys and requirements by section (`docs read`), the mockups of the screens
  the stories changed, `.agentplugged/profile.md` (section `Acceptance`), `.agentplugged/docs/test-strategy.md`.
- **Validation point:** a `document` checkpoint citing the report. Approved, the engine knows the acceptance
  passed and hands the release to Omar; refused or sent back, you are called again with the note.

## Steps

1. **Start.** `agent.status` (`working`). Quentin not active: `story.result` `partial`. Called again after a refusal: read the creator's note on the last refused point (`state.get { checkpoint: "<id>" }`) and answer it.
2. **Place.** Read `Acceptance` in the profile. Set: use it. `(not set)`: in one line, say that you will
   look for where to replay the product *with* them, start on their machine, and add a free hosting offer
   (a preview deploy on the host they already use or a free tier) only if there is one. Their words decide;
   record it with `npx agentplugged docs profile accept <local|staging> [how]`. Never create an account,
   never deploy, never ask for a token: a hosting step is Omar's, asked as a creator action.
3. **Journeys.** From the PRD, list the journeys a user takes, main one first, then the edge cases and
   the failures the requirements name. Replay each one for real, as the user does: through the
   interface when there is one (the browser tools of your host, else the command named `browser-qa`
   once accepted by the creator), through the commands or the API otherwise. One proof per line:
   screenshot, output, or the file in `.agentplugged/.cache/qa/` named by the journey.
4. **Screens.** For each screen of a changed story, compare the rendering with its mockup. A gap is a
   finding with the two images named. A gap the creator already accepted in the story is not one.
5. **Quality.** Short, measured, never guessed: accessibility (keyboard path, focus, labels, contrast on
   the main screen, using the product's own tool when it has one), speed (the load time or response time
   of the main journey, against the PRD's target; no target: report the figure and say so), and the
   security checks of the profile. A check you cannot run is `unknown`, with why. Never `pass` without a
   proof.
6. **Write.** Template in `references/template.md`: place, version tested (commit), a table
   journey, proof, result (`pass`, `fail`, `unknown`), then findings sorted by severity with what would
   settle each, then the verdict: `passed`, `passed with reservations` (each named) or `not passed`.
   A previous report exists: say which of its findings are fixed.
7. **Findings.** A blocking finding on a merged story is a ticket: `plan.defer` (`origin: deliberate`,
   `owner` the story's developer, `title` one line, `detail` the proof). Do not fix the product.
8. **Validate.** Commit the report; `checkpoint.open` `type: document`, low risk, no story, the report
   in `documents` (`path`, `branch`, `blob_sha`). Open it first, then ask once, with the verdict and the
   findings in three lines: « Recette passée ? ». Their answer through `chat.answer`, in the chat, one gesture.
   `not passed`: still ask; they may accept the risk, which is theirs.
9. **Report.** `story.result` `complete` (verdict, place, proofs, open findings); `agent.status` `idle`.
   Hand back to Noah, who proposes the release when the report is approved.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never claim a pass without its proof, never weaken a scenario to pass it, never fix the product.
- Never start a server, deploy, create an account or use a real person's data or a real secret.
- Never impose staging or a hosting offer: the place is the creator's choice, explained in one sentence.
