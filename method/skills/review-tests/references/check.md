# The mutation check and the holes

**What the engine does** (`check.mutation: {}`, no token from you). It copies the story's working copy to a
throwaway folder, changes the code the story added one small way at a time (a comparison turned over,
a condition negated, a boolean flipped, a constant moved by one, a return dropped), and each time runs
the test command the creator accepted (the one with `{criterion}`, filtered on the story's criteria; or
the declared command you name in `command`). The creator's folder is never changed. A break the tests
catch is killed; one they do not **survives**: a test that cannot fail there.

**When.** The story changed code, `proofs.yaml` declares a test command and the creator accepted it
(`guard.creator_action`, `proof_commands`; never accept it yourself). Without one the engine says so:
the grid and the holes still come. `max` (8 by default, 30 at most) and `seconds` (300, 1 800 at
most) of `check.mutation` bound it; raise them only for a small story whose tests are quick.

**Reading the answer.** `ran`, `killed`, `survived`; a status other than `done` says why (`baseline_red`:
the tests already fail, fix that first; `stopped`: time; `refused`: no copy, too big). Each survivor is
`file:line kind a -> b`. Read the code there: if the break changes behaviour a criterion promises, a
test is missing or too weak, and that is a hole. If it changes nothing observable (an equivalent
break), say so to the creator in one line; it is not a hole.

**The holes** (`gaps`), tied to what the tests should protect: a criterion with no test, whose test never
failed before the code, whose tests killed no break; a requirement the story cites that no test names;
a surviving break. One line each; at most 12 shown, the rest counted. With `check.propose: true` each becomes
work to decide in the register of deferred work (10 at most per call, none twice), a story or a
correction; the creator decides each in one gesture. Never decide for them.
