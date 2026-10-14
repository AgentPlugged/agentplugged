# Evaluate how a skill behaves

When: after a creation or a change, or when the creator asks whether a skill still does its job, fires on the
right requests, or beats the model without it. Cases sit next to the skill, in `evals/cases.yaml`: a file of
the creator's, which is never copied to the AI tools.

## 1. The cases

`agent.workshop` `verify` gives `evals`: `cases`, `queries`, `problems`, `reference` (`absent`, `none`,
`current`, `stale`) and, when there are none, a `starter` to start from. Show the starter. The creator runs
`npx agentplugged eval init <id>` (or says yes and you run it): it writes the starter once, never over a file.
Then every line left as `TODO` is theirs to write, in their words:

- a **case**: `input` as they would type it; `rubric` lines that a wrong output would fail (a number, a name, a
  thing it must not say); `checks` the engine makes itself and for free (`answer_has`, `file_has`,
  `tool_not_called`…); `files` the case starts from; `state` to put the skill in the middle of its work.
- **queries**: some that must call the skill and, as many, near misses that must not (they share its words).

`npx agentplugged eval check <id>` is free: it lists what is wrong and what proves little.

## 2. A real run costs tokens

Say the plan first (`eval run <id> --plan`: runs of the agent and of the judge), wait for the creator's yes,
then run it. One run, never a loop of your own. `--mode`: `quality` (the default), `baseline` (does the skill
beat the bare model? if not, retire it rather than patch it), `variant` with `--without "<section or file>"`
(does that part earn its place?), `trigger` (real firing; `--runs 3` for a steadier rate).

## 3. Read it

Pass rate, tokens, and the lines that failed with their evidence. `tokens not measured` means the tool gave
no count: say so, never say zero. « proves little » means a wrong output would pass too: sharpen the rubric.

## 4. Keep it, then guard it

When the results are right, `--record` keeps the pass as the reference. From then on a case that no longer
passes, or a cost above the threshold (`--max-cost-growth`, `--cost-floor`), is a regression and the command
exits with 1. Fix the skill; change a threshold only if the creator decides to.

## 5. A description that fires badly

Improve it from the failures of `--set train` only; check once on `--set test`; three rounds at most; keep the
description with the best test score. Each round is a run: say it.

The run has no engine tools: a case says in `state` what they answered, and judges what the skill writes.
