# The test framework

## Choose: the validated stack decides

Order of precedence: the validated architecture (or spec), then what the product already has, then
the team's skills, then what `tests setup` proposes. A runner the product already uses is never
replaced.

| Level | What it proves | Pick |
|---|---|---|
| Unit and API (one runner) | pure logic; a service's rules through its public interface | Node.js: Vitest or Jest, or the built-in `node --test`; Python: pytest; Go: `go test`; Rust: `cargo test`; Ruby: RSpec; PHP: PHPUnit; JVM: JUnit (Maven or Gradle); .NET: xUnit or NUnit (`dotnet test`) |
| End to end, with a screen | a journey as a user lives it | a browser product: Playwright (several browsers, traces) or Cypress (simple, one browser at a time); a mobile app: the platform's device flows (a declarative tool such as Maestro, XCUITest, Espresso), the main journeys only |
| End to end, no screen | a journey through a service or a command line | no runner of its own: API tests that chain the calls of the journey |
| Contract | two codebases of the same product agree | only when a real boundary exists between a consumer and a provider (a second repository, a published API); never by default |

An API test calls the service through its public surface (HTTP, the command line, the exported
function) with the stack's own client, or the framework's in-process client when it has one. It does
not mock what it tests. An unknown stack: take the idiomatic runner, say why in one line in the
result.

## Layout

Follow the stack's convention (Go: `_test.go` beside the code; Rust: `tests/`; pytest: `tests/`;
JVM: `src/test`). Otherwise:

- `tests/unit/` or beside the code; `tests/api/` one file per resource or journey; `tests/e2e/` one
  file per journey; `tests/support/` for fixtures, factories, helpers, the session.
- A path that holds `test`, `spec` or `e2e` is read as a test by the engine: keep it so, or the
  criterion's trace says `no_test`.

## Data and fixtures

- Each test builds the data it needs (a factory with overrides, unique random values) and removes it
  afterwards, or runs in a transaction or a throwaway database. No shared state, no order between
  tests.
- Never production data, never a real person's data. Secrets by name in the environment
  (`.env.example` lists the names), never in the repository.
- A fixture is small and composes with others. The session is created once through the API and
  reused, never by driving the login form in every test.
- The clock and the random source are fixed when the result depends on them; a third party you do
  not own is replaced at the boundary (a stub of its API), never inside your own code.
- The service under test starts from the runner's configuration (a web server entry) or from the CI;
  the address comes from the environment (`BASE_URL`, `API_URL`), a test database, a test mode for
  every third party.

## Configuration

Time limits: action 15 s, navigation 30 s, one test 60 s. No retry on a developer's machine, at most
two in the CI, each retry reported. On failure keep the evidence: trace, screenshot, log. A JUnit
report for the CI. Files in parallel with isolated data. A forbidden `.only` fails the run.

## Scripts and installation

`test` stays the quick run (unit and API); `test:api`, `test:integration` and `test:e2e` run a slower
level apart (one name per level), so the CI and the creator can choose. The installation of the
packages is one grouped, plain command in the working copy, and a browser download is once, before
the first run (`playwright install`). `.env.example` lists the names of the variables the tests read,
and a few lines of the README say how to run each level.
