# The grid

One answer, whole; the engine refuses one that is not and lists what is missing. It gives the marks.

- `reads`: the test files you read (at least one, 60 at most), relative paths.
- `criteria`: one entry for each of the eight, none twice: `ok`, `issues` (at least one finding) or
  `not_applicable` (say why in `note`: no test of this kind here).
- `findings`: each has `criterion`, `row`, `test` (`path:line` and the test's name, a file you read),
  `reason` (one line: what you saw), `fix`. The row decides the weight, not you.

| Criterion | Rows (a test that…) |
| --- | --- |
| `active` | `skipped` is disabled; `focused` runs alone and silences the others |
| `assertions` | `no_assertion` checks nothing; `tautology` compares a value with itself; `self_mock` asserts the mock it set up; `unreachable` asserts where it never runs; `shape_only` checks a type or a presence, not the value; `conditional` asserts inside an `if`, a loop or a swallowed error; `unawaited` does not wait for its async call |
| `determinism` | `hard_wait` waits on a timer; `wall_clock` builds an expiry from the live clock; `uncontrolled` uses an unseeded random, an unordered result or a real network; `navigate_then_read` loads a page and checks what it shows before waiting for the data call or a sign that it is ready; `fragile_selector` finds an element by a CSS class, an XPath, a position or a wording a rewrite changes, when a role, a label or a test id is there |
| `isolation` | `shared_state` writes state nothing resets; `order_dependent` needs another test first; `leftover` leaves files, rows or processes; `real_service` calls a real outside service |
| `readability` | `oversize` file over 1 000 lines; `multi_concern` checks three unrelated things; `deep_nesting` over three levels; `ungrouped` no suite name; `vague_name` says "works" or a method name, not the behaviour; `magic_value` an unexplained number |
| `speed` | `slow` too slow to run before a push; `heavy_setup` builds far more than it needs |
| `data` | `real_data` uses production or personal data or a secret; `repeated_payload` builds the same object inline three times; `hidden_data` depends on data defined far away |
| `risk` | `denied_untested` a rule of rights has no refused case; `happy_path_only` no error or boundary case beside the normal one; `wrong_level` proves at a level too low or too high; `raw_event` dispatches a bare DOM event when the project's runner offers a call that acts as a person does (click, type) |

The guard before a write already refuses `focused`, `skipped` with no reason, `hard_wait`, `tautology`
and `oversize` in what is written now: report them in tests that were there before.

A defect that fits no row is a prose note in your answer to the creator, without a mark. Report each
test once per row, with the line that shows it. A criterion with no test of its kind is
`not_applicable`, not `ok`. Never copy a secret into a report.
