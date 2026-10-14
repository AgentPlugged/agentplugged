# Verdicts and the closed form of the QA

`review.qa` takes `story`, `agent` and `check`. The check covers every criterion of the story once,
either in `scenarios` or in `outside`; the engine refuses one that does not.

```json
{
  "check": {
    "scenarios": [
      { "criterion": 1, "verdict": "passed",
        "proofs": [".agentplugged/.cache/qa/AC-18-5-1-empty-cart.png",
                   ".agentplugged/.cache/qa/AC-18-5-1-empty-cart.webm"] },
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
  really showed, or why the scenario could not be played. One line of your own words, never a copy
  of what the page said.
- `run: true` alone (no verdict, no proofs): the engine plays it with the accepted `browser-qa` command and
  takes the verdict and the proofs itself.
- `proofs`: the files you saved, each named with the criterion's id. A `passed` scenario whose
  files do not exist is recorded `blocked` (`no_proof`): nothing is "passed by QA" without
  something to see.

## What the engine answers

`line` (`passed 3, failed 1, blocked 0, outside 1`), `results` (one line per criterion), `no_proof`
(the scenarios turned `blocked`) and `dir`. A new check replaces the previous one: after a fix, play
the failed scenarios again and send the whole story again. A failed or blocked scenario joins the
findings of the story, shown at the merge beside the reviewers' findings; the proofs of each
criterion are listed in the walk through the change the creator reads.

## Refusals

`not_started`, `done`, `builder` (you built the story), `unknown_criterion`, `not_whole` (names
the criteria missing), `listed_twice`, `no_command_to_run`, `not_accepted`. Fix what it names, once.
