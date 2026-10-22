# Hypotheses

## List them before testing any

Three to five, written in `story.progress` before the first `story.loop`. Each one is a cause, not
a symptom, and says where it would show:

| Confidence | Hypothesis | Where to look | What would rule it out |
|---|---|---|---|
| 7/10 | the total is cached before a refund | `cart/total.ts`, the cache key | the test passes with the cache off |
| 4/10 | the tax rounds twice | `tax.ts`, line items and total | one cent off on one item only |

- A confidence from 1 to 10 says how likely it is given what you have seen so far (the symptom,
  the recent changes, the logs), not how easy it is to check. Two hypotheses at the same level
  are tested in the order that costs less.
- Ask "why" up to five times to get from an effect to a cause.
- A hypothesis is a sentence another reader could contradict. "Something with the cache" is not.

## Test one, then say what you saw

`story.loop` with `seen: hypothesis` and `note: "7/10 the total is cached before a refund"` puts
one forward. Then look: read the path of the call, run the failing test with the suspect part
changed or switched off, bisect between a version that worked and the one that did not.

Close it with `seen: ruled_out` or `seen: confirmed`; `note` is the evidence, a fact someone
can check: a test name and its result, a line and what it holds, a commit. "Seems fine" is no
evidence. The engine refuses to close without one.

A cause is confirmed when changing only it changes the symptom, both ways: with it, the test
fails; without it, the test passes.

## When every hypothesis is ruled out

Your list was wrong; do not stretch it. Widen:

1. Write 5 to 7 sources you had not considered, from other layers (input, configuration, data,
   timing, the environment, a dependency, a recent merge), none of them one `story.loop` answers
   in `ruled_out`.
2. Keep the 1 or 2 most likely given the evidence so far, with their confidence.
3. Put probes on those sources before any other change (`probes.md`), run the failing test, read
   what the probes say, then put the kept ones forward as above.

A second round that rules out everything is the creator's: a `decision` checkpoint that lists what
is known, what is ruled out and what you would try next.
