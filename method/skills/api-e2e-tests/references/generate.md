# Writing the tests

## Level and priority

For each criterion and each journey, the lowest level that proves it: unit for pure logic, API for
rules, codes, permissions and data, end to end for the few journeys a user cannot do without. The same
behaviour is never proved at two levels. Start from the coverage map of the test strategy when there is
one.

Priority is probability times impact: **P0** money, data loss, security, signing in (API and end to
end, always); **P1** the main flows; **P2** the secondary flows and edge cases; **P3** the rare ones.
Cover P0 and P1 first; say which P2 and P3 you left.

## From the words, never from the code

Write the scenario first, as one line above the test, with the words of the criterion and the journey
of the PRD or the UX specification: "Given a cart with one book, when Ada pays, then the order is
confirmed." Decide before you look at how it is built. One test checks one behaviour, is linear (no
loop, no condition) and states its expected result explicitly.

## API tests

For each endpoint a criterion touches: the happy path; invalid input (the code and the shape of the
error); no session (401) and no right (403); not found (404); a duplicate or a conflict (409); a
repeated call; the limits (empty, maximum, one page more). Check the structure of the answer against
the schema the architecture gives, not only the status, and read back what the call changed.

## End-to-end tests

A journey is what the user does and sees. Locate by role, label or visible text, then by a
`data-testid` the story adds; never by a chain of CSS, an XPath or an index. Wait for a condition (an
element, a response), never for a duration: declare the wait on the response before the action that
triggers it, and never read a page's data right after opening it. Act as a person does (click,
type), not with a raw event dispatch. Assert the visible result; for a P0 also what the service received. Sign in by reusing a
session. At most ten steps, one journey per file. Where the stack has an accessibility checker, one
check per main page (P1).

## Name it, then prove it

The test's name holds `AC-<story>-<n>` of the criterion it proves (languages:
`develop-story/references/acceptance-tests.md`); a journey that proves several criteria has one test
for each. `story.criterion` runs the declared command in the working copy and records red then green.

When the code already exists (a delivered feature, a story of its own for its tests), red cannot come
from missing code. Break the behaviour in the working copy, uncommitted (remove the check the test
guards), run `story.criterion`: red, the engine marks the run `unclean`, which is expected here. Undo
the break, run it again: green. Say it in the result. A test that stays green with the behaviour
broken proves nothing: rewrite it.

## What cannot be tested end to end

A real third party (payment, mail, SMS), hardware, a captcha, a duration only a person can judge, a
service of others with no test mode. Say it with the reason: `story.criterion`, `seen: untestable`,
`note`. Offer the level that holds (the API with the third party replaced at the boundary); the review
reads every reason.

## An unstable test

A test that fails now and then is a defect: find the cause (timing, shared data, order, network), fix
it, and run it five times in a row before handing over. Never hide it behind a retry, never skip it,
never weaken its assertion; if it cannot be made stable, delete it and say so.

## Before you hand over

Each test runs alone and in any order; has no fixed sleep; builds and removes its data; names its
criterion; fails when the behaviour is broken; runs under a minute (end to end) or a second (API). The
runs are in the trace, the journeys not covered are in the result.
