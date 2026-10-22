# Acceptance tests first

- **Scenario** from the words of the criterion alone, one line above the test, never from code.
  Its error and limit cases name the criterion too. A criterion lived through an API or a screen:
  `api-e2e-tests`.
- **Name:** `AC-<story>-<n>` (story `4-2`, criterion 1: `AC-4-2-1`; `AC_4_2_1` where a name takes
  no dash), in the test's name or a comment beside it, with the requirement it proves (`EF-18`).
  Only test files count (`test`, `spec`, `e2e` in the path); else `no_test`.
- **Red:** `story.criterion` with `story` and `criterion`; the engine runs the command filtered on
  the criterion in your working copy and answers `result`, the `lines` and the `trace`. It must
  fail for the right reason (the behaviour missing). Passing at once (`never_red`) proves nothing.
- **Green:** the code, committed, then `story.criterion` again. Same commit as the red:
  `no_change`. From ten criteria on, end the id with a non-digit (`-t "{criterion}:"`).
- **The command** is declared in `.agentplugged/proofs.yaml` (`run: …` with `{criterion}` or
  `{criterion_}`) and accepted by the creator (`guard.creator_action`, `proof_commands`): propose
  it, never accept it. None accepted: say `seen: red` or `green` with the test in `note`, marked
  `reported` (your word).
- **Quick lane:** a passing test that already covers it is `covered`.
- Review only when every criterion is `green` or `untestable` (`CRITERIA_NOT_PROVEN` lists the
  rest); the judge takes the same trace and does not recompute it.
