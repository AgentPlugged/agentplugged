# Proofs the engine produces

The engine runs the commands the project declares, itself, and inscribes the proof: exit code,
duration, commit tested, whether the copy was clean, a short masked summary. Such a proof is marked
`engine`; one you report with `measure.proof` is `reported`. `measure.requirements` counts both
(`engine`, `reported`) once the engine has produced one. Never run a declared command yourself to
report its result.

**1. Declare.** Write or complete `.agentplugged/proofs.yaml` (a proposal: it runs nothing yet):

```yaml
commands:
  - name: tests            # lower case, - or _
    run: npm test          # a program and its arguments, as in a terminal
    timeout: 600           # seconds, 300 without, 3600 at most
    proves: [ENF-2]        # the requirements a passing run proves
  - name: bench
    run: node bench.mjs
    cwd: perf              # inside the project, `.` without
    proves: [ENF-1]
    measured_after: "p95_ms="   # a measure: the number after this text on the last line that has it
```

Use the project's own commands, never a tool you assume. A line that only a shell reads (a pipe,
`&&`, `$VAR`) goes through the shell: prefer a plain line or a script of the project.

**2. Ask the creator once.** `guard.creator_action` with `{kind: proof_commands}`: the engine reads
the file and asks for every line that is new or modified. Show `preview` to the creator as it is,
line by line (name, exact line, folder, limit, requirements); never reword it. `later` lines did not
fit: ask again after the answer. A line they refuse stays refused: name it (`commands: [name]`) only
when they ask again. Changing a line, its folder, its limit or what it proves asks again. To demand
at the release that proofs be the engine's own: `{kind: proof_commands, require: engine}` (`any`
takes it back).

**3. Run.** `measure.run` with `source` = the command's name. You get `ok`, `seconds`, `proved`,
`failed`, `skipped` (`id:why`: a review comes from the audit, a CI from the CI, a test proof needs a
test that cites the requirement, a measure needs a budget), `unclean` (changes not committed: commit,
then run again before a release) and, on a failure, `lines`; the whole output is in `log`, a local
file. A failure, a timeout or a command that never started is a failed proof: a gap, never a proof.
Do not retry in a loop: fix the cause, or ask the creator.

Refusals say what to do: `not_accepted` (step 2), `refused_by_the_creator` (their word stands),
`nothing_to_prove` (the command proves nothing the engine can prove by running it).
