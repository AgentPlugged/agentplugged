import { describe, expect, it } from "vitest";
import { ciPlan, ciTestGaps, renderCiTemplate } from "../ci/ci-setup.js";
import type { CommandContext } from "../command.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { PROOFS_PATH, readProofDeclaration } from "../proofs/proof-declaration.js";
import { lineForCriterion, parseDeclaredLine, runsCriteria } from "../proofs/proof-line.js";
import { MemoryFiles } from "../testing/memory-files.js";
import {
  API_RUNNERS,
  canChain,
  criterionLine,
  E2E_RUNNERS,
  installCommand,
} from "./test-runners.js";
import { proofsProposal, type TestsSetupResult, testPlan, testsCommand } from "./tests-setup.js";

/** The test framework of the product, read from its files, in several stacks. */

const manifest = (value: Record<string, unknown>) => JSON.stringify(value);

async function setup(files: MemoryFiles, input: Record<string, unknown> = {}) {
  files.seed(METHOD_CONFIG_PATH, "version: 1\n");
  return testsCommand.run({ files } as unknown as CommandContext, { action: "setup", ...input });
}

function resultOf(result: Awaited<ReturnType<typeof setup>>): TestsSetupResult {
  if (!result.ok) throw new Error(`failed: ${result.error.code}`);
  return result.value;
}

describe("the plan of the test framework reads the product's files", () => {
  it("keeps the runner a Node.js product has, and proposes Playwright for its screens", async () => {
    const files = new MemoryFiles({
      "package.json": manifest({
        packageManager: "pnpm@9.15.0",
        dependencies: { react: "^19" },
        devDependencies: { vitest: "^3" },
      }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    });
    const plan = await testPlan(files);
    expect(plan).toMatchObject({
      stack: "node",
      ui: true,
      api: { name: "vitest", present: true, chosen: "detected" },
      e2e: { name: "playwright", present: false, chosen: "default" },
    });
    expect(plan.line).toBe(
      "pnpm exec vitest run -t {criterion} --passWithNoTests && pnpm exec playwright test -g {criterion} --pass-with-no-tests",
    );
    // Only what is missing is installed, in the plain form the installation rules ask for.
    expect(plan.installs).toEqual([
      {
        ecosystem: "npm",
        packages: ["@playwright/test"],
        command: "pnpm add --save-dev @playwright/test",
      },
    ]);
    expect(plan.notes.join(" ")).toContain("playwright install");
  });

  it("proposes a runner for an empty Node.js product, and no screen means no end-to-end runner", async () => {
    const plan = await testPlan(new MemoryFiles({ "package.json": manifest({ name: "api" }) }));
    expect(plan).toMatchObject({
      ui: false,
      api: { name: "vitest", present: false, chosen: "default" },
      e2e: null,
      line: "npx vitest run -t {criterion}",
    });
    expect(plan.installs).toEqual([
      { ecosystem: "npm", packages: ["vitest"], command: "npm install --save-dev vitest" },
    ]);
  });

  it("follows the runner the product chose: Jest, Mocha, the built-in one, Cypress", async () => {
    const jest = await testPlan(
      new MemoryFiles({
        "package.json": manifest({ devDependencies: { jest: "^30", cypress: "^14" } }),
        "yarn.lock": "",
      }),
    );
    expect(jest).toMatchObject({
      api: { name: "jest", present: true },
      e2e: { name: "cypress", present: true, chosen: "detected" },
    });
    // Cypress is not sure to pass when nothing matches: the line runs Jest alone, and says so.
    expect(jest.line).toBe("yarn jest -t {criterion}");
    expect(jest.notes.join(" ")).toContain("cypress cannot follow jest in one line");
    const mocha = await testPlan(
      new MemoryFiles({ "package.json": manifest({ devDependencies: { mocha: "^11" } }) }),
    );
    expect(mocha.line).toBe("npx mocha --grep {criterion}");
    const builtin = await testPlan(
      new MemoryFiles({ "package.json": manifest({ scripts: { test: "node --test tests/" } }) }),
    );
    expect(builtin).toMatchObject({ api: { name: "node-test", present: true }, installs: [] });
    expect(builtin.line).toBe("node --test --test-name-pattern={criterion}");
  });

  it("knows Python, Go, Rust, Ruby, PHP, the JVM and .NET, and installs only what is not built in", async () => {
    const py = await testPlan(new MemoryFiles({ "pyproject.toml": "[project]\nname = 'x'\n" }));
    expect(py).toMatchObject({ stack: "python", api: { name: "pytest", present: false } });
    expect(py.line).toBe("python -m pytest -k {criterion_}");
    expect(py.installs[0]?.command).toBe("python -m pip install pytest");
    const pyHas = await testPlan(new MemoryFiles({ "requirements.txt": "flask\npytest==8.3.0\n" }));
    expect(pyHas).toMatchObject({ api: { name: "pytest", present: true }, installs: [] });

    const go = await testPlan(new MemoryFiles({ "go.mod": "module x\n" }));
    expect(go).toMatchObject({
      stack: "go",
      api: { name: "go-test", present: true },
      installs: [],
      line: "go test ./... -run {criterion_}",
    });
    const rust = await testPlan(new MemoryFiles({ "Cargo.toml": "[package]\n" }));
    expect(rust.line).toBe("cargo test {criterion_}");
    expect(rust.notes.join(" ")).toContain("case-sensitive");
    const ruby = await testPlan(new MemoryFiles({ Gemfile: "source 'https://rubygems.org'\n" }));
    expect(ruby.installs[0]).toEqual({
      ecosystem: "rubygems",
      packages: ["rspec"],
      command: "bundle add rspec --group development,test",
    });
    const php = await testPlan(new MemoryFiles({ "composer.json": "{}" }));
    expect(php.installs[0]?.command).toBe("composer require --dev phpunit/phpunit");
    const maven = await testPlan(new MemoryFiles({ "pom.xml": "<project/>" }));
    expect(maven.api?.name).toBe("maven");
    const gradle = await testPlan(new MemoryFiles({ "build.gradle.kts": "" }));
    expect(gradle.api?.name).toBe("gradle");
    const dotnet = await testPlan(new MemoryFiles({ "shop.sln": "" }));
    expect(dotnet).toMatchObject({ stack: "dotnet", api: { name: "dotnet-test" } });
    expect(dotnet.line).toBe("dotnet test --filter Name~{criterion_}");
  });

  it("says what it cannot know instead of guessing: an unknown stack, a second language", async () => {
    const none = await testPlan(new MemoryFiles());
    expect(none).toMatchObject({ stack: "other", api: null, e2e: null, line: null });
    const forced = await testPlan(new MemoryFiles(), { runner: "pytest" });
    expect(forced).toMatchObject({ api: { name: "pytest", chosen: "asked" } });
    const two = await testPlan(new MemoryFiles({ "package.json": "{}", "go.mod": "module x\n" }));
    expect(two.stack).toBe("node");
    expect(two.notes[0]).toContain("also found: go");
  });

  it("lets the validated stack win: --runner and --e2e, none included", async () => {
    const files = new MemoryFiles({
      "package.json": manifest({ dependencies: { react: "^19" } }),
    });
    const asked = await testPlan(files, { runner: "jest", e2e: "cypress" });
    expect(asked).toMatchObject({
      api: { name: "jest", chosen: "asked", present: false },
      e2e: { name: "cypress", chosen: "asked" },
    });
    expect(asked.installs.map((install) => install.packages)).toEqual([
      ["jest"],
      ["cypress", "@cypress/grep"],
    ]);
    expect((await testPlan(files, { e2e: "none" })).e2e).toBeNull();
  });

  it("takes the stack whose own runner the product has, not the first manifest it finds", async () => {
    const plan = await testPlan(
      new MemoryFiles({
        // A Django product with a tooling manifest: its tests are pytest's.
        "package.json": manifest({ devDependencies: { prettier: "3" } }),
        "requirements.txt": "django\npytest\n",
      }),
    );
    expect(plan).toMatchObject({ stack: "python", api: { name: "pytest", present: true } });
    expect(plan.notes[0]).toContain("also found: node");
  });

  it("runs the first runner alone when the other cannot follow it, and says so", async () => {
    const plan = await testPlan(new MemoryFiles({ "pyproject.toml": "pytest" }), {
      e2e: "playwright",
    });
    expect(plan.line).toBe("python -m pytest -k {criterion_}");
    expect(plan.e2e?.name).toBe("playwright");
    expect(plan.notes.join(" ")).toContain("playwright cannot follow pytest in one line");
    const gradle = await testPlan(new MemoryFiles({ "build.gradle": "" }));
    expect(gradle.notes.join(" ")).toContain("wrapper");
  });

  it("has a screen in a browser when the product holds an HTML page, whatever its language", async () => {
    const plan = await testPlan(
      new MemoryFiles({ "pyproject.toml": "pytest", "public/index.html": "<html/>" }),
    );
    expect(plan).toMatchObject({ stack: "python", ui: true, e2e: null });
    expect(plan.notes.join(" ")).toContain("browser plugin");
  });
});

describe("every line the table writes is a line the engine accepts", () => {
  it("reads as a valid declared line, and holds the mark of a criterion", () => {
    for (const name of [...API_RUNNERS, ...E2E_RUNNERS]) {
      const line = criterionLine(name as (typeof API_RUNNERS)[number], null, "npx");
      expect(runsCriteria(line), name).toBe(true);
      expect(parseDeclaredLine(line).kind, name).not.toBe("invalid");
      // The id is plain characters once written, the shell never reads anything in it.
      expect(lineForCriterion(line, "AC-17-4-2"), name).toMatch(/AC[-_]17[-_]4[-_]2/);
    }
    const chained = criterionLine("vitest", "playwright", "npx");
    expect(parseDeclaredLine(chained).kind).toBe("shell");
    expect(installCommand("crates", ["x"], "npx")).toBeNull();
  });

  it("chains two runners only when neither fails for a test that lives in the other", () => {
    expect(canChain("vitest", "playwright")).toBe(true);
    expect(canChain("jest", "playwright")).toBe(true);
    expect(canChain("go-test", "playwright")).toBe(true);
    for (const api of ["pytest", "gradle", "phpunit"] as const) {
      expect(canChain(api, "playwright"), api).toBe(false);
      expect(criterionLine(api, "playwright", "npx"), api).toBe(criterionLine(api, null, "npx"));
    }
    expect(canChain("vitest", "cypress")).toBe(false);
    // Chained, both are told that finding nothing is not a failure.
    expect(criterionLine("vitest", "playwright", "pnpm exec")).toBe(
      "pnpm exec vitest run -t {criterion} --passWithNoTests && pnpm exec playwright test -g {criterion} --pass-with-no-tests",
    );
  });
});

describe("tests setup writes a proposal the engine reads, and never over a declaration", () => {
  it("writes the line of the criteria into .agentplugged/proofs.yaml, once", async () => {
    const files = new MemoryFiles({
      "package.json": manifest({ devDependencies: { vitest: "3" } }),
    });
    const first = resultOf(await setup(files));
    expect(first.status).toBe("written");
    const declaration = await readProofDeclaration(files);
    expect(declaration.kind).toBe("commands");
    if (declaration.kind !== "commands") throw new Error("unreachable");
    expect(declaration.commands).toHaveLength(1);
    expect(declaration.commands[0]).toMatchObject({
      name: "criteria",
      run: "npx vitest run -t {criterion}",
      timeout: 600,
    });
    expect(await files.readText(PROOFS_PATH)).toContain("Nothing here runs until the creator");
    // Deterministic, and the file is the product's from then on.
    const again = resultOf(await setup(files));
    expect(again.status).toBe("declared");
    expect(files.writes.filter((path) => path === PROOFS_PATH)).toHaveLength(1);
  });

  it("gives the end-to-end line more time, and quotes a line with an apostrophe", () => {
    expect(proofsProposal("a && b", true)).toContain("timeout: 900");
    expect(proofsProposal("echo 'x'", false)).toContain("run: 'echo ''x'''");
  });

  it("leaves a declaration without that command as it is, and says so", async () => {
    const text = "commands:\n  - name: tests\n    run: npm test\n    proves: [ENF-1]\n";
    const files = new MemoryFiles({ "package.json": "{}", [PROOFS_PATH]: text });
    const result = resultOf(await setup(files));
    expect(result.status).toBe("exists");
    expect(result.plan.line).toBe("npx vitest run -t {criterion}");
    expect(await files.readText(PROOFS_PATH)).toBe(text);
  });

  it("writes nothing over a file it cannot read, nor for a stack it does not know", async () => {
    const broken = new MemoryFiles({ "package.json": "{}", [PROOFS_PATH]: "commands: [oops" });
    const invalid = resultOf(await setup(broken));
    expect(invalid.status).toBe("invalid");
    expect(invalid.problems[0]).toContain(PROOFS_PATH);
    expect(await broken.readText(PROOFS_PATH)).toBe("commands: [oops");
    const empty = new MemoryFiles();
    expect(resultOf(await setup(empty)).status).toBe("unknown_stack");
    expect(await empty.exists(PROOFS_PATH)).toBe(false);
  });

  it("refuses what it does not understand, and a product without the method", async () => {
    const files = new MemoryFiles({ "package.json": "{}" });
    for (const input of [
      { action: "run" },
      { action: "setup", runner: "nope" },
      { action: "setup", e2e: "selenium" },
      { action: "setup", other: 1 },
    ]) {
      const result = await setup(files, input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("INVALID_ARGUMENTS");
    }
    const bare = await testsCommand.run({ files: new MemoryFiles() } as unknown as CommandContext, {
      action: "setup",
    });
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.code).toBe("METHOD_NOT_INSTALLED");
  });
});

describe("the base CI runs the new tests too", () => {
  const TEMPLATE = "{{header}}\njobs:\n  test:\n    steps:\n      {{setup}}\n      {{test}}\n";

  it("adds the API, integration and end-to-end scripts to the test job, after test", async () => {
    const files = new MemoryFiles({
      "package.json": manifest({
        packageManager: "pnpm@9.15.0",
        scripts: { test: "vitest run", "test:api": "x", "test:e2e": "playwright test" },
        devDependencies: { "@playwright/test": "1" },
      }),
      "pnpm-lock.yaml": "",
    });
    const plan = await ciPlan(files);
    expect(plan.jobs.test).toEqual([
      { run: "pnpm exec playwright install --with-deps" },
      { run: "pnpm run test" },
      { run: "pnpm run test:api" },
      { run: "pnpm run test:e2e" },
    ]);
    const text = renderCiTemplate(TEMPLATE, "github", plan, "main");
    const order = [
      "playwright install",
      "pnpm run test'",
      "pnpm run test:api",
      "pnpm run test:e2e",
    ];
    const at = order.map((step) => text.indexOf(step));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it("runs one end-to-end script, and downloads the browsers when test already runs them", async () => {
    const both = await ciPlan(
      new MemoryFiles({
        "package.json": manifest({ scripts: { test: "x", "test:e2e": "y", e2e: "z" } }),
      }),
    );
    expect(both.jobs.test).toEqual([{ run: "npm run test" }, { run: "npm run test:e2e" }]);
    const inside = await ciPlan(
      new MemoryFiles({
        "package.json": manifest({
          scripts: { test: "vitest run && playwright test" },
          devDependencies: { "@playwright/test": "1" },
        }),
      }),
    );
    expect(inside.jobs.test).toEqual([
      { run: "npx playwright install --with-deps" },
      { run: "npm run test" },
    ]);
  });

  it("does not run twice what the test script already runs", async () => {
    const plan = await ciPlan(
      new MemoryFiles({
        "package.json": manifest({
          scripts: { test: "npm run test:api && vitest run", "test:api": "x" },
        }),
      }),
    );
    expect(plan.jobs.test).toEqual([{ run: "npm run test" }]);
  });

  it("says which tests an existing CI does not run, and writes nothing", async () => {
    const files = new MemoryFiles({
      "package.json": manifest({
        scripts: { test: "vitest run", "test:api": "x", "test:e2e": "y", e2e: "z" },
      }),
      ".github/workflows/ci.yml": "jobs:\n  test:\n    steps:\n      - run: npm run test:api\n",
    });
    const gaps = await ciTestGaps(files, [".github/workflows/ci.yml"]);
    // `e2e` and `test:e2e` are one level: only the second is asked for.
    expect(gaps).toEqual(['test: the CI does not run "test:e2e" (add it to the test job)']);
    // A CI that names them all, or a product that has none, has nothing to add.
    files.seed(".github/workflows/ci.yml", "run: npm run test:api\nrun: npm run test:e2e\n");
    expect(await ciTestGaps(files, [".github/workflows/ci.yml"])).toEqual([]);
    expect(await ciTestGaps(new MemoryFiles(), [".gitlab-ci.yml"])).toEqual([]);
  });

  it("reads a script as a word of its own, and says nothing of a CI it cannot read", async () => {
    const files = new MemoryFiles({
      "package.json": manifest({ scripts: { test: "x", e2e: "y" } }),
      // `test:e2e` and a `tests/e2e` folder are not the script `e2e`.
      ".github/workflows/ci.yml": "run: npm run test:e2e\npaths: [tests/e2e/**]\n",
    });
    expect(await ciTestGaps(files, [".github/workflows/ci.yml"])).toEqual([
      'test: the CI does not run "e2e" (add it to the test job)',
    ]);
    // A CI that only lives on the forge is not read here: no invented gap.
    expect(await ciTestGaps(files, [])).toEqual([]);
  });
});
