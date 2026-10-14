# The tests in the CI

## The base CI

`npx agentplugged ci setup` writes four checks (`lint`, `test`, `build`, `audit`). Its `test` job runs
the `test` script, then `test:api`, `test:integration` and `test:e2e` (or `e2e`) when `package.json`
has them and `test` does not already run them; a Playwright product also downloads its browsers
first. A stack the template does not know leaves a `TODO` for you to fill with the full-suite
command of the framework, in the same `test` job. Keep the job names: the engine reads them.

## An existing CI

It is never rewritten. `ci setup` then lists, as `Not checked by the CI`, each test script it does
not name. Add the step to the `test` job on the story's branch, so that it goes through the pull
request the creator reviews, or tell the creator which step is missing. Never add a job with
another name, never an `allow_failure`, a `continue-on-error` or a `|| true`.

## By moment

The test strategy sets it; by default: every push runs unit and API tests (under ten minutes); a pull
request adds the end-to-end journeys tagged P0; the night and the release run every journey, other
browsers, and the tests that just entered, five to ten times each. Split the suite in shards when it
goes past ten minutes.

On a pull request, when the runner can, run only the tests the change touches (`--changed`,
`--onlyChanged`, a marker); the night runs everything.

## A gate that can fail

Retries at most two, each one logged as unstable; evidence uploaded on failure (JUnit report, traces,
screenshots, logs); dependencies cached; secrets by name (`${{ secrets.NAME }}`, `$NAME`), a service
container for the database. Thresholds are numbers fixed beforehand: P0 all green, P1 at least 95 %.
A check that cannot pass yet is a `decision` point for the creator, never a silent green.
