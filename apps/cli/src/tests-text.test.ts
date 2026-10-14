import type { TestsSetupResult } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { formatCiSetup } from "./ci-text.js";
import { formatTestsSetup } from "./tests-text.js";

const fr = createTranslator("fr");
const en = createTranslator("en");

const PLAN: TestsSetupResult["plan"] = {
  stack: "node",
  ui: true,
  api: { name: "vitest", present: true, chosen: "detected" },
  e2e: { name: "playwright", present: false, chosen: "default" },
  line: "npx vitest run -t {criterion} --passWithNoTests && npx playwright test -g {criterion} --pass-with-no-tests",
  installs: [
    {
      ecosystem: "npm",
      packages: ["@playwright/test"],
      command: "npm install --save-dev @playwright/test",
    },
  ],
  notes: [
    "playwright also downloads browsers: `npx playwright install` once, before the first run",
  ],
};

const WRITTEN: TestsSetupResult = {
  status: "written",
  path: ".agentplugged/proofs.yaml",
  plan: PLAN,
  problems: [],
};

describe("tests setup's text", () => {
  it("says the proposal, the runners of the two levels, the line, what to install and the notes", () => {
    expect(formatTestsSetup(en, WRITTEN)).toBe(
      [
        "Test framework for node: proposal written to .agentplugged/proofs.yaml. Nothing runs until you accept it, once, in the chat.",
        "  unit and API: vitest (found in the product)",
        "  end to end: playwright (proposed, to check against the architecture)",
        "  line: npx vitest run -t {criterion} --passWithNoTests && npx playwright test -g {criterion} --pass-with-no-tests",
        "  to install (npm), through the validation of installations: npm install --save-dev @playwright/test",
        "  note: playwright also downloads browsers: `npx playwright install` once, before the first run",
        "",
      ].join("\n"),
    );
    const french = formatTestsSetup(fr, WRITTEN);
    expect(french).toContain("Cadre de test pour node : proposition écrite dans");
    expect(french).toContain("  unitaire et API : vitest (trouvé dans le produit)");
    expect(french).toContain("à installer (npm), par la validation des installations");
  });

  it("tells a declaration it left alone, an unreadable one, and a stack it does not know", () => {
    expect(formatTestsSetup(en, { ...WRITTEN, status: "declared" })).toContain(
      "already declares a command that runs the tests of a criterion: nothing was written.",
    );
    expect(formatTestsSetup(en, { ...WRITTEN, status: "exists" })).toContain(
      "Add this line to it:",
    );
    expect(
      formatTestsSetup(fr, {
        ...WRITTEN,
        status: "invalid",
        problems: ["commands.0.cwd: no"],
      }),
    ).toContain("est illisible, rien n'a été écrit : commands.0.cwd: no");
    const unknown = formatTestsSetup(en, {
      status: "unknown_stack",
      path: ".agentplugged/proofs.yaml",
      plan: { ...PLAN, stack: "other", api: null, e2e: null, line: null, installs: [], notes: [] },
      problems: [],
    });
    expect(unknown).toBe(
      "Stack not recognised: no test runner to propose. Name one with --runner <name>, or declare the command yourself.\n",
    );
  });

  it("says the product has no screen, and a package no tool installs for the creator", () => {
    const text = formatTestsSetup(en, {
      ...WRITTEN,
      plan: {
        ...PLAN,
        e2e: null,
        installs: [{ ecosystem: "crates", packages: ["nextest"], command: null }],
      },
    });
    expect(text).toContain("end to end: none (the journeys go through the API)");
    expect(text).toContain("to install (crates): nextest");
  });

  it("lists, after an existing CI, the tests it does not run", () => {
    const text = formatCiSetup(fr, {
      status: "exists",
      existing: [".github/workflows/ci.yml"],
      todo: ['test: the CI does not run "test:e2e" (add it to the test job)'],
    });
    expect(text).toBe(
      [
        "Le produit a déjà une CI (.github/workflows/ci.yml) : rien n'a été écrit.",
        '  Non vérifié par la CI : test: the CI does not run "test:e2e" (add it to the test job)',
        "",
      ].join("\n"),
    );
  });
});
