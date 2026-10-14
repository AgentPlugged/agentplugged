# Design thinking, the last step: implementation

Read when the prototype exists. Write it in `## Implementation` of the synthesis, from the creator's words
and the test results, never invented. A step with nothing to say keeps one line saying why.

1. **Test plan** (if the test has not run). Who: five to seven people and how to reach them. What: one task
   each, one thing measured per assumption. The success criterion, fixed before the test ("4 of 5 finish
   alone"). When, and who watches. Offer a script: the task, the questions, what to observe.
2. **Feedback to collect.** What exactly (blocked, confused, liked, asked for), by which channel (call, notes,
   form, usage), and where it comes back in this file, dated.
3. **From learning to product.** One line per learning, "what we learned → what to do", with its source (test,
   date). The creator picks one gesture per line, you never choose:
   - **hypothesis**: the product follows it until its proof. Report them in one `review.critique`
     (`agent: stella`, `kind: idea`, `lenses: ["socratic"]`, `summary` the test in one line; one finding each:
     `severity: should_fix`, `claim` the learning as a checkable statement, `passage` `design-<slug>`,
     `argument` the observation, `proposal`, `proof` the measure and criterion of the plan). Then the gestures
     as in `.agentplugged/skills/test-idea/references/bets.md`. Refused `critique_unsorted`: sort the earlier
     stack first.
   - **story**: a proposal in one line ("<who> can <do what> so that <why>"), kept with `plan.defer`
     (`origin: deliberate`, `owner: creator`, `title` the line, `detail` the learning and its source). It is
     cut up at the next planning.
   - **drop**, with their reason in the file.
4. **Pilot** (a service, or a first real run): who, how long, who must be aligned (team, partners), the one
   metric and its date, what makes you stop.
5. Show the section, then the usual menu. When all is written, remove the `resume` comment, `docs check`.
