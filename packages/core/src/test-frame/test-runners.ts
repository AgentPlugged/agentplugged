/**
 * The test runners the engine knows, as a closed table: for each, the ecosystem it
 * belongs to, the packages it needs, how it is detected in the product's files, and the line that
 * runs the tests of one criterion (`{criterion}` for `AC-4-2-1`, `{criterion_}` where a name takes
 * no dash, the convention). Pure data and pure functions: the same files give the
 * same lines. The table proposes; the product's validated stack decides (the skill checks it).
 */

/** The ecosystems the architecture declares its dependencies in (see its template). */
export type TestEcosystem = "npm" | "pypi" | "crates" | "go" | "rubygems" | "packagist";

/** The languages and toolchains the plan recognises at the product's root. */
export const TEST_STACKS = [
  "node",
  "python",
  "go",
  "rust",
  "ruby",
  "php",
  "jvm",
  "dotnet",
  "other",
] as const;
export type TestStack = (typeof TEST_STACKS)[number];

/** The runners of unit and API tests (an API test is a test of the same runner that calls the service). */
export const API_RUNNERS = [
  "vitest",
  "jest",
  "mocha",
  "node-test",
  "pytest",
  "go-test",
  "cargo-test",
  "rspec",
  "phpunit",
  "dotnet-test",
  "maven",
  "gradle",
] as const;
export type ApiRunner = (typeof API_RUNNERS)[number];

/** The runners of end-to-end tests, those that drive the product as a user does. */
export const E2E_RUNNERS = ["playwright", "cypress"] as const;
export type E2eRunner = (typeof E2E_RUNNERS)[number];

export type TestRunner = ApiRunner | E2eRunner;

/** How a Node.js runner is started: `npx`, `pnpm exec`, `yarn`. */
export type Launcher = "npx" | "pnpm exec" | "yarn";

interface RunnerDefinition {
  readonly stack: TestStack;
  readonly ecosystem: TestEcosystem | null;
  /** The packages to install when the runner is absent; empty for a built-in runner. */
  readonly packages: readonly string[];
  /** The files that name the runner when it is present, and the word that names it. */
  readonly seen: { readonly files: readonly string[]; readonly word: string } | "builtin";
  /** The line that runs the tests of one criterion. */
  readonly line: (launcher: Launcher) => string;
  /** What the runner needs added to its line when another runner follows it (no test found is not a failure). */
  readonly passEmpty?: string;
}

export const RUNNERS: Readonly<Record<TestRunner, RunnerDefinition>> = {
  vitest: {
    stack: "node",
    ecosystem: "npm",
    packages: ["vitest"],
    seen: { files: ["package.json"], word: '"vitest"' },
    line: (x) => `${x} vitest run -t {criterion}`,
    passEmpty: "--passWithNoTests",
  },
  jest: {
    stack: "node",
    ecosystem: "npm",
    packages: ["jest"],
    seen: { files: ["package.json"], word: '"jest"' },
    line: (x) => `${x} jest -t {criterion}`,
    passEmpty: "--passWithNoTests",
  },
  mocha: {
    stack: "node",
    ecosystem: "npm",
    packages: ["mocha"],
    seen: { files: ["package.json"], word: '"mocha"' },
    line: (x) => `${x} mocha --grep {criterion}`,
  },
  "node-test": {
    stack: "node",
    ecosystem: null,
    packages: [],
    seen: "builtin",
    line: () => "node --test --test-name-pattern={criterion}",
  },
  pytest: {
    stack: "python",
    ecosystem: "pypi",
    packages: ["pytest"],
    seen: {
      files: [
        "pyproject.toml",
        "requirements.txt",
        "requirements-dev.txt",
        "Pipfile",
        "setup.cfg",
        "pytest.ini",
        "tox.ini",
      ],
      word: "pytest",
    },
    line: () => "python -m pytest -k {criterion_}",
  },
  "go-test": {
    stack: "go",
    ecosystem: null,
    packages: [],
    seen: "builtin",
    line: () => "go test ./... -run {criterion_}",
  },
  "cargo-test": {
    stack: "rust",
    ecosystem: null,
    packages: [],
    seen: "builtin",
    line: () => "cargo test {criterion_}",
  },
  rspec: {
    stack: "ruby",
    ecosystem: "rubygems",
    packages: ["rspec"],
    seen: { files: ["Gemfile"], word: "rspec" },
    line: () => "bundle exec rspec -e {criterion}",
  },
  phpunit: {
    stack: "php",
    ecosystem: "packagist",
    packages: ["phpunit/phpunit"],
    seen: { files: ["composer.json"], word: "phpunit" },
    line: () => "vendor/bin/phpunit --filter {criterion_}",
  },
  "dotnet-test": {
    stack: "dotnet",
    ecosystem: null,
    packages: [],
    seen: "builtin",
    line: () => "dotnet test --filter Name~{criterion_}",
  },
  maven: {
    stack: "jvm",
    ecosystem: null,
    packages: [],
    seen: "builtin",
    line: () => "mvn -q test -Dtest=#*{criterion_}* -Dsurefire.failIfNoSpecifiedTests=false",
  },
  gradle: {
    stack: "jvm",
    ecosystem: null,
    packages: [],
    seen: "builtin",
    line: () => "gradle test --tests *{criterion_}*",
  },
  playwright: {
    stack: "node",
    ecosystem: "npm",
    packages: ["@playwright/test"],
    seen: { files: ["package.json"], word: '"@playwright/test"' },
    line: (x) => `${x} playwright test -g {criterion}`,
    passEmpty: "--pass-with-no-tests",
  },
  cypress: {
    stack: "node",
    ecosystem: "npm",
    packages: ["cypress", "@cypress/grep"],
    seen: { files: ["package.json"], word: '"cypress"' },
    line: (x) => `${x} cypress run --env grep={criterion}`,
  },
};

/** The runner to propose when the product has none, by stack. */
export const DEFAULT_RUNNER: Readonly<Record<Exclude<TestStack, "other">, ApiRunner>> = {
  node: "vitest",
  python: "pytest",
  go: "go-test",
  rust: "cargo-test",
  ruby: "rspec",
  php: "phpunit",
  jvm: "maven",
  dotnet: "dotnet-test",
};

/** Packages that say the product has a screen in a browser (a web front end). */
export const UI_PACKAGES: readonly string[] = [
  "react",
  "react-dom",
  "vue",
  "svelte",
  "next",
  "nuxt",
  "@angular/core",
  "solid-js",
  "preact",
  "astro",
  "@remix-run/react",
  "lit",
];

export const isApiRunner = (value: unknown): value is ApiRunner =>
  (API_RUNNERS as readonly unknown[]).includes(value);
export const isE2eRunner = (value: unknown): value is E2eRunner =>
  (E2E_RUNNERS as readonly unknown[]).includes(value);

/**
 * The runners that exit with a failure (or may: we are not sure) when no test matches the filter. A
 * runner of this set cannot be followed by another in one line: the criterion's test would live in
 * the other one, and the line would fail for a test that passes.
 */
const FAILS_WHEN_EMPTY: ReadonlySet<TestRunner> = new Set([
  "pytest",
  "gradle",
  "phpunit",
  "cypress",
]);

/** True when the two runners can run one after the other in one line, whichever holds the test. */
export function canChain(api: ApiRunner, e2e: E2eRunner): boolean {
  return !FAILS_WHEN_EMPTY.has(api) && !FAILS_WHEN_EMPTY.has(e2e);
}

/**
 * The line that runs the tests of one criterion: the unit and API runner, then the end-to-end
 * runner when the two can be chained (`canChain`). Chained, each one is told that finding no test
 * of the criterion is not a failure (the test lives in one of them); the trace still says `no_test`
 * when none cites it.
 */
export function criterionLine(api: ApiRunner, e2e: E2eRunner | null, launcher: Launcher): string {
  const next = e2e !== null && canChain(api, e2e) ? e2e : null;
  const part = (runner: TestRunner) => {
    const definition = RUNNERS[runner];
    const flag = next === null ? undefined : definition.passEmpty;
    return flag === undefined ? definition.line(launcher) : `${definition.line(launcher)} ${flag}`;
  };
  return next === null ? part(api) : `${part(api)} && ${part(next)}`;
}

/** The installation of packages of an ecosystem, written plainly (the package manager first). */
export function installCommand(
  ecosystem: TestEcosystem,
  packages: readonly string[],
  launcher: Launcher,
): string | null {
  const list = packages.join(" ");
  switch (ecosystem) {
    case "npm":
      return launcher === "pnpm exec"
        ? `pnpm add --save-dev ${list}`
        : launcher === "yarn"
          ? `yarn add --dev ${list}`
          : `npm install --save-dev ${list}`;
    case "pypi":
      return `python -m pip install ${list}`;
    case "rubygems":
      return `bundle add ${list} --group development,test`;
    case "packagist":
      return `composer require --dev ${list}`;
    default:
      return null;
  }
}
