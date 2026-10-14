# Pillar: tests

Read the test strategy (`.agentplugged/docs/test-strategy.md`, when it exists), then, for the most
important behaviours of the PRD, the test that proves each. `state.trace` lists which tests cite
which requirement (`path:line`).

Look for: a requirement no test cites; a test that cannot fail (no assertion, asserts what it just
set); a test that passes only most of the time; a level too low or too high for what it proves;
failure and boundary cases missing next to the happy path; slow tests nobody runs; tests that
depend on each other's order.

The quality of the tests themselves (graded, broken by the engine, holes tied to the requirements) is
the skill `review-tests`: point to it rather than redo it.

Requirements: the tests `ENF-n` (coverage, speed, stability). Prove it with `measure.run` when the
project declares its test command, else only from a test that cites the requirement and that its
own command ran green.
