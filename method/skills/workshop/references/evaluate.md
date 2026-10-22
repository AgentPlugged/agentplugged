# Evaluate how a skill behaves

Cases sit in the skill's `evals/cases.yaml`, never copied to the AI tools.

1. `agent.workshop` `verify` gives `evals` (`cases`, `queries`, `problems`, `reference`, a `starter`
   when none). The creator runs `npx agentplugged eval init <id>` and writes the `TODO` lines in
   their words (cases; queries that must and must not call the skill). `eval check <id>` is free.
2. A real run costs tokens: say the plan (`eval run <id> --plan`), wait for their yes, run it once,
   never in a loop. `--mode`: `quality`, `baseline` (does it beat the bare model? if not, retire it),
   `variant` with `--without`, `trigger`.
3. Read pass rate, tokens, failed lines; `tokens not measured` is never zero.
4. `--record` keeps a good pass as the reference; a later failing case or a cost above the threshold
   is a regression. Change a threshold only if the creator decides.
