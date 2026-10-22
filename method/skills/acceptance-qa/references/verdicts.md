# Verdicts and the closed form of the QA

`review.qa` takes `story`, `agent` and `check`. The check covers every criterion of the story once,
in `scenarios` or in `outside`; the engine refuses one that does not.

```json
{
  "check": {
    "scenarios": [
      { "criterion": 1, "verdict": "passed",
        "proofs": [".agentplugged/.cache/qa/AC-18-5-1-empty-cart.png"] },
      { "criterion": 2, "verdict": "failed",
        "proofs": [".agentplugged/.cache/qa/AC-18-5-2-total.png"],
        "observed": "The total shows one item instead of two" },
      { "criterion": 3, "run": true }
    ],
    "outside": [{ "criterion": 4, "reason": "a mail is sent, nothing shows it in a page" }]
  }
}
```

- `verdict`: `passed`, `failed` or `blocked`. `observed` is required unless `passed`: what the page
  showed, or why it could not be played.
- `run: true` alone: the engine plays it with the accepted `browser-qa` command.
- `proofs`: the files you saved, each named with the criterion's id. A `passed` scenario whose files
  do not exist is recorded `blocked` (`no_proof`).

## What the engine answers

`line` (`passed 3, failed 1, blocked 0, outside 1`), `results` (one line per criterion), `no_proof`
and `dir`. A new check replaces the previous one: after a fix, replay the failed scenarios and send the
whole story again. A failed or blocked scenario joins the story's findings.

## Refusals

`not_started`, `done`, `builder` (you built the story), `unknown_criterion`, `not_whole` (names the
criteria missing), `listed_twice`, `no_command_to_run`, `not_accepted`. Fix what it names, once.
