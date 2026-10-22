# Proofs the engine produces

The engine runs the commands the project declares and inscribes the proof (exit code, duration,
commit tested, clean copy or not, masked summary): marked `engine`; yours via `measure.proof` is
`reported`. Never run a declared command yourself to report its result.

**1. Declare.** Write or complete `.agentplugged/proofs.yaml` (a proposal: it runs nothing yet):

```yaml
commands:
  - name: tests            # lower case, - or _
    run: npm test          # a program and its arguments
    timeout: 600           # seconds, 300 without, 3600 at most
    proves: [ENF-2]        # what a passing run proves
  - name: bench
    run: node bench.mjs
    cwd: perf              # inside the project
    proves: [ENF-1]
    measured_after: "p95_ms="   # the number after this text on the last line that has it
```

Use the project's own commands, never an assumed tool; prefer a plain line or a script to a shell-only line (pipe, `&&`, `$VAR`).

**2. Ask the creator once.** `guard.creator_action` with `{kind: proof_commands}`: the engine reads
the file and asks for every line that is new or modified. Show `preview` to the creator as it is,
line by line; never reword it. `later` lines did not fit: ask again after the answer. A refused line stays
refused unless they ask again (`commands: [name]`). Changing a line, its folder,
its limit or what it proves asks again. To demand at the release that proofs be the engine's own:
`{kind: proof_commands, require: engine}` (`any` takes it back).

**3. Run.** `measure.run` with `source` = the command's name. You get `ok`, `seconds`, `proved`,
`failed`, `skipped` (`id:why`), `unclean` (changes not committed: commit, run again before a
release) and, on a failure, `lines`; the whole output is in `log`. A failure, a timeout or a command
that never started is a gap, never a proof.

Refusals: `not_accepted` (step 2), `refused_by_the_creator` (their word stands), `nothing_to_prove`.
