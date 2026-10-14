# Acceptance tests first

Each acceptance criterion gets its test before the code; the engine sees it fail, then pass.

## Scenario, then test

- Write the scenario from the **words of the criterion alone**, as one line in a comment above the
  test: "Given an empty cart, when Ada checks out, then she is told it is empty." Never from the
  code you are about to write, nor from code that exists.
- At least one scenario per criterion; more for its cases (error, limit), all naming the criterion. A criterion lived through an API or a screen: `api-e2e-tests`.
- No result to observe through the interface (a sound, a look, a feeling, a duration measured by a
  person)? Declare it, with the reason: `story.criterion` with `seen: untestable` and `note`. It is
  no way out of a hard test: the review reads every reason.

## The name carries the id

The criterion is `AC-<story>-<n>`: story `4-2`, criterion 1 is `AC-4-2-1`. Write it where the
language allows, in the test's name or in a comment next to it, any case; with underscores where a
name takes no dash (`AC_4_2_1`). The engine finds the tests by it, in any language:

| Language | Example |
|---|---|
| TypeScript, JavaScript, Ruby | `it("AC-4-2-1 refuses an empty cart", ...)` |
| Python | `def test_AC_4_2_1_refuses_empty_cart():` |
| Go | `func TestAC_4_2_1_RefusesEmptyCart(t *testing.T)` |
| Rust, C | `fn ac_4_2_1_refuses_empty_cart()` / `void test_ac_4_2_1(void)` |
| Java, C#, PHP | `void AC_4_2_1_refusesEmptyCart()` |
| Shell (bats) | `@test "AC-4-2-1 refuses an empty cart" {` |
| Any other | `# AC-4-2-1` in a comment beside the test |

Also cite the requirement it proves (`EF-18`, for `npx agentplugged trace`). A test file's name may
carry the id (`tests/ac_4_2_1_test.go`). Only test files count (a path with
`test`, `spec` or `e2e`): a run whose test the engine cannot find is `no_test`.

## Red, then green: `story.criterion`

1. Write the test, no code yet. `story.criterion` with the `story` and the `criterion` number.
2. The engine starts the project's test command, filtered on the criterion, in your story's working
   copy, and records the run itself. You get `result` (`red`), `status`, the few `lines` that say why
   it failed, and `trace`, every criterion in one line. Read the lines: it must fail **for the right
   reason** (the behaviour is missing), not because of a typo or a missing import. A test that
   passes the first time (`never_red`) proves nothing: rewrite it until it fails without the code.
3. Write the code, commit it, `story.criterion` again: `green`. Same commit as the red, both
   copies clean: `no_change`, no proof; commit the test, then the code.
4. If the test breaks later, `story.criterion` shows `red` again: fix it before handing over.

A filter matches by prefix (`AC-4-2-1` also runs `AC-4-2-10`): from ten criteria on, end the id with
a non-digit in the test's name and in the line (`-t "{criterion}:"`).

The command is the project's, declared once in `.agentplugged/proofs.yaml`, and accepted by the creator at the chat (one gesture, see `guard.creator_action` with
`kind: proof_commands`). You may propose it, never accept it. `{criterion}` is the id in its line:

```yaml
commands:
  - name: criteria
    run: npx vitest run -t {criterion}      # AC-4-2-1
  - name: py-criteria
    run: python -m pytest -k {criterion_}   # AC_4_2_1
```

No command accepted (or none declared)? Say what you saw: `seen: red` or `green`, and `note` with
the test you ran. It counts, marked `reported`; the trace and the review say it is your word.

## The quick lane

A one-line fix whose criterion a test already covers needs no red: run it, a passing test is
enough, and the status says `covered`. Anything that is not covered gets its red like any story.

## Before you hand over

The story goes to review only when every criterion is `green` or `untestable`
(`CRITERIA_NOT_PROVEN` lists what is missing). The review's judge receives
the same trace and does not recompute it.
