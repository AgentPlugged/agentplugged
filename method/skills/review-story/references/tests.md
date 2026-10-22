# The tests lens: are the tests good, not only green

Read-only, on the creator's ask or after a story's tests are written. The scope: the story named,
else the product (`state.trace` says which tests cite which requirement). The engine marks, breaks
the code and lists the holes; you read the tests, each file once.

1. `review.tests` with `story` and `check`: your `grid` and, when the story changed code and the
   creator accepted its test command (`proof_commands`, never by you), `mutation: {}` (`max` 8,
   `seconds` 300 by default). Fix what the engine says is missing in your answer.
2. **The grid**, whole: `reads` (the files read), `criteria` (each of the eight once: `ok`,
   `issues` with a finding, `not_applicable` with a `note`), `findings` (`criterion`, `row`,
   `test` as `path:line` and name, `reason`, `fix`). The row decides the weight, never you:
   - `active`: `skipped`, `focused`;
   - `assertions`: `no_assertion`, `tautology`, `self_mock`, `unreachable`, `shape_only`,
     `conditional`, `unawaited`;
   - `determinism`: `hard_wait`, `wall_clock`, `uncontrolled`, `navigate_then_read`,
     `fragile_selector`;
   - `isolation`: `shared_state`, `order_dependent`, `leftover`, `real_service`;
   - `readability`: `oversize`, `multi_concern`, `deep_nesting`, `ungrouped`, `vague_name`,
     `magic_value`;
   - `speed`: `slow`, `heavy_setup`; `data`: `real_data`, `repeated_payload`, `hidden_data`;
   - `risk`: `denied_untested`, `happy_path_only`, `wrong_level`, `raw_event`.
3. **The answer:** marks, survivors (`file:line kind a -> b`: a test that cannot fail there, unless
   the break changes nothing observable), holes (one line each). Show it as it is: never
   recompute, soften or add a mark. `baseline_red`: the tests already fail, that first.
4. Holes become work only if the creator says so: `check: {propose: true}`, one gesture each.

Never write or change a test here, never run a test command to prove a break, never copy a
secret into a report. `agent.status` `idle`, hand back to Noah.
