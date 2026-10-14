# Solving a problem, the course

Diagnose before you solve; a good question is worth more than a quick answer. Symptoms lie, structure does not.
Balance rigour and momentum: do not stay in analysis when the cause is clear. Start from the documents
(PRD, architecture, research, the hypotheses already followed). The sections of the file are the steps;
a step not run keeps its section with one line saying why.

1. **Problem.** Ask: what exactly is wrong, how it was first noticed, who lives it, when and where, what it
   costs, what success looks like. Write one statement of the gap between today and the wanted state, and
   say why it is worth solving. Name the kind (technical, product, adoption, organisation, decision).
2. **Boundaries.** Where, when, who and what it is and is not. Contrast the cases where it happens with
   the near cases where it does not; the pattern between them is the first clue.
3. **Causes.** Symptom, cause, cause of the cause, until the answer is something that can be acted on.
   Offer two or three methods of the diagnosis group (`solve-methods.md`), say when each fits; run them.
   Separate the root cause from the contributing factors and name the loops that keep the problem alive.
   Mark each cause `[verified]` (seen in the code, a log, a number) or `[to verify]` (guessed).
4. **Forces.** What drives toward a solution and what holds it back; which are strongest, which the
   creator can move. The main constraint, and which limits are real and which only assumed. End with the
   two or three insights that change what to try.
5. **Options.** Ask their energy first, then change gear: from analysis to making. Offer two to four
   methods of the creative and synthesis groups; at least ten options, small and large, and a few wild
   ones that break an assumption. The creator's ideas first, yours after.
6. **Choice.** Criteria first, chosen with the creator (effect on the root cause, feasibility, cost,
   risk, reversibility). One or two evaluation methods. Recommend one option with the reason, the
   confidence, what still worries, and the assumptions it rests on. The creator decides.
7. **Plan.** Strategy (a trial first, in steps, or all at once) and why; the actions in order with their
   dependencies, who does each (the creator, an agent, a tool), what each needs. No dates: order and
   checkpoints. Learn in loops: plan, do, check, adjust.
8. **Checks.** How we will know it worked: the measures and their targets, how and how often they are
   read; the proof wanted, the trial to run first; what could go wrong, plan B, and the sign that says to
   change course.
9. **Lessons** (optional, `## Lessons`). What held up, what to drop next time, what surprised, what to remember.

Choose by need: a bug that returns, steps 1 to 4; options known, steps 5 to 8; a plan under way that
stalls, steps 4 and 8. Then the gestures (`gestures.md`).
