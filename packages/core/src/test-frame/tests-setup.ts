import { ErrorCode } from "@agentplugged/protocol";
import { ciPlan } from "../ci/ci-setup.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import { PROOFS_PATH, readProofDeclaration } from "../proofs/proof-declaration.js";
import { runsCriteria } from "../proofs/proof-line.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import {
  API_RUNNERS,
  type ApiRunner,
  canChain,
  criterionLine,
  DEFAULT_RUNNER,
  E2E_RUNNERS,
  type E2eRunner,
  installCommand,
  isApiRunner,
  isE2eRunner,
  type Launcher,
  RUNNERS,
  type TestEcosystem,
  type TestRunner,
  type TestStack,
  UI_PACKAGES,
} from "./test-runners.js";

/**
 * `tests setup`: the test framework of the product, read from its own files. The
 * engine finds the stack and the runners already there, proposes the missing ones (the product's
 * validated stack decides: the skill checks the architecture before it installs anything), names
 * the installations to go through the creator's validation, and writes the one command that runs
 * the tests of a criterion into `.agentplugged/proofs.yaml` as a proposal. Nothing runs before the
 * creator accepts the line. Deterministic: the same files give the same plan. Never
 * over a declaration that exists.
 */

/** A runner chosen for a level, and why. */
export interface ChosenRunner {
  readonly name: TestRunner;
  /** True when the product already has it. */
  readonly present: boolean;
  /** `asked`: `--runner` or `--e2e`; `detected`: found in the product's files; `default`: proposed. */
  readonly chosen: "asked" | "detected" | "default";
}

/** What must be installed, in the plain form the installation rules ask for. */
export interface TestInstall {
  readonly ecosystem: TestEcosystem;
  readonly packages: readonly string[];
  /** The command in its plain form, package manager first; null where the toolchain installs it. */
  readonly command: string | null;
}

/** What the product's files say about how it is tested, and what to add. */
export interface TestPlan {
  readonly stack: TestStack;
  /** The product has a screen in a browser. */
  readonly ui: boolean;
  /** The unit and API runner; null for a stack the plan does not know and none asked. */
  readonly api: ChosenRunner | null;
  /** The end-to-end runner; null when the product has no screen to drive (its journeys go through the API). */
  readonly e2e: ChosenRunner | null;
  /** The line that runs the tests of one criterion, with its `{criterion}` mark. */
  readonly line: string | null;
  readonly installs: readonly TestInstall[];
  /** What the plan leaves to check, one short line each. */
  readonly notes: readonly string[];
}

const STACK_FILES: ReadonlyArray<readonly [TestStack, readonly string[]]> = [
  ["node", ["package.json"]],
  ["python", ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", "setup.cfg"]],
  ["go", ["go.mod"]],
  ["rust", ["Cargo.toml"]],
  ["ruby", ["Gemfile"]],
  ["php", ["composer.json"]],
  ["jvm", ["pom.xml", "build.gradle", "build.gradle.kts"]],
];

/** The project files that mark a .NET solution or project at the root. */
const DOTNET_FILE = /\.(?:sln|slnx|csproj|fsproj)$/i;
const HTML_ENTRIES = ["index.html", "public/index.html", "src/index.html"];

function launcherOf(stack: string): Launcher {
  return stack === "pnpm"
    ? "pnpm exec"
    : stack === "yarn" || stack === "yarn-classic"
      ? "yarn"
      : "npx";
}

/** The plan of the test framework, from the workspace's root files. Pure apart from reading them. */
export async function testPlan(
  files: WorkspaceFiles,
  asked: { readonly runner?: ApiRunner; readonly e2e?: E2eRunner | "none" } = {},
): Promise<TestPlan> {
  const has = (path: string) => files.exists(path).catch(() => false);
  const text = async (path: string) =>
    (await has(path)) ? await files.readText(path).catch(() => "") : "";
  const notes: string[] = [];

  const found: TestStack[] = [];
  for (const [stack, names] of STACK_FILES) {
    for (const name of names) {
      if (await has(name)) {
        found.push(stack);
        break;
      }
    }
  }
  const entries = (await files.listEntries?.("")) ?? [];
  if (entries.some((name) => DOTNET_FILE.test(name))) found.push("dotnet");

  const manifestText = await text("package.json");
  let dependencies: string[] = [];
  let testScript = "";
  try {
    const parsed = JSON.parse(manifestText.replace(/^﻿/, "")) as Record<string, unknown>;
    const names = (key: string) =>
      typeof parsed[key] === "object" && parsed[key] !== null
        ? Object.keys(parsed[key] as object)
        : [];
    dependencies = [...names("dependencies"), ...names("devDependencies")];
    const scripts = parsed.scripts as Record<string, unknown> | undefined;
    if (typeof scripts?.test === "string") testScript = scripts.test;
  } catch {
    // no readable manifest: no Node.js runner can be seen
  }

  const present = async (runner: TestRunner): Promise<boolean> => {
    const seen = RUNNERS[runner].seen;
    if (runner === "node-test") return /node\s+(?:--\S+\s+)*--test\b/.test(testScript);
    if (runner === "maven") return has("pom.xml");
    if (runner === "gradle") return (await has("build.gradle")) || (await has("build.gradle.kts"));
    if (seen === "builtin") return true;
    for (const name of seen.files) {
      if ((await text(name)).toLowerCase().includes(seen.word.toLowerCase())) return true;
    }
    return false;
  };

  const ci = await ciPlan(files);
  const launcher = launcherOf(ci.stack);

  const runnersOf = (candidate: TestStack): readonly ApiRunner[] =>
    candidate === "node"
      ? ["vitest", "jest", "mocha", "node-test"]
      : API_RUNNERS.filter((name) => RUNNERS[name].stack === candidate);
  // The stack: the first whose own runner the product has (a `package.json` of tooling does not make a
  // Django product a Node.js one), else the first found. A built-in runner is no evidence.
  let stack: TestStack = found[0] ?? "other";
  for (const candidate of found) {
    let evidenced = false;
    for (const name of runnersOf(candidate)) {
      if ((RUNNERS[name].seen !== "builtin" || name === "node-test") && (await present(name))) {
        evidenced = true;
      }
    }
    if (evidenced) {
      stack = candidate;
      break;
    }
  }
  const others = found.filter((candidate) => candidate !== stack);
  if (others.length > 0) {
    notes.push(
      `also found: ${others.join(", ")} (this plan is for ${stack}; run it again where the other lives, or ask for --runner)`,
    );
  }

  // The unit and API runner: asked, else the first of the stack found in its files, else the default.
  let api: ChosenRunner | null = null;
  if (asked.runner !== undefined) {
    api = { name: asked.runner, present: await present(asked.runner), chosen: "asked" };
  } else if (stack !== "other") {
    const order = runnersOf(stack);
    // A built-in runner of the stack (Go, Rust…) is the product's whatever its files say.
    for (const name of order) {
      if (api === null && (await present(name))) api = { name, present: true, chosen: "detected" };
    }
    api ??= { name: DEFAULT_RUNNER[stack], present: false, chosen: "default" };
  }

  const ui =
    dependencies.some((name) => UI_PACKAGES.includes(name)) ||
    (await Promise.all(HTML_ENTRIES.map(has))).some(Boolean);

  // The end-to-end runner: asked, else one the product has, else Playwright for a Node.js product with a screen.
  let e2e: ChosenRunner | null = null;
  if (asked.e2e !== undefined) {
    if (asked.e2e !== "none") {
      e2e = { name: asked.e2e, present: await present(asked.e2e), chosen: "asked" };
    }
  } else {
    for (const name of E2E_RUNNERS) {
      if (e2e === null && (await present(name))) e2e = { name, present: true, chosen: "detected" };
    }
    if (e2e === null && ui && stack === "node") {
      e2e = { name: "playwright", present: false, chosen: "default" };
    }
  }
  if (e2e === null && ui && stack !== "node" && stack !== "other") {
    notes.push(
      "screens: drive them with your runner's browser plugin (same line), or ask for --e2e playwright",
    );
  }
  if (api === null) {
    notes.push("stack not recognised: ask for --runner <name>, or declare the command yourself");
  }

  const installs: TestInstall[] = [];
  for (const chosen of [api, e2e]) {
    if (chosen === null || chosen.present) continue;
    const definition = RUNNERS[chosen.name];
    if (definition.ecosystem === null || definition.packages.length === 0) continue;
    installs.push({
      ecosystem: definition.ecosystem,
      packages: definition.packages,
      command: installCommand(definition.ecosystem, definition.packages, launcher),
    });
  }
  if (api !== null && ["maven", "gradle", "dotnet-test"].includes(api.name)) {
    notes.push("check that the product has a test project: this runner is the toolchain's own");
  }
  if (api?.name === "maven" || api?.name === "gradle") {
    notes.push("use the product's wrapper (./mvnw, ./gradlew) in the line when it has one");
  }
  if (api?.name === "pytest") {
    notes.push("the line starts with `python`: write `python3` where that is the only name");
  }
  if (e2e?.name === "cypress") {
    notes.push(
      "cypress filters by name only with the @cypress/grep plugin, installed and registered in its support file",
    );
  }
  if (e2e?.name === "playwright" && !e2e.present) {
    notes.push(
      "playwright also downloads browsers: `npx playwright install` once, before the first run",
    );
  }
  if (api?.name === "cargo-test") {
    notes.push(
      "rust: name the test as the id is written (#[allow(non_snake_case)]), the filter is case-sensitive",
    );
  }
  if (api !== null && e2e !== null && !canChain(api.name as ApiRunner, e2e.name as E2eRunner)) {
    notes.push(
      `end to end: ${e2e.name} cannot follow ${api.name} in one line (one of them fails when no test matches): the line runs ${api.name} only, report the end-to-end runs as your word (seen, note)`,
    );
  }

  const apiRunner = api?.name as ApiRunner | undefined;
  const line =
    apiRunner === undefined
      ? null
      : criterionLine(apiRunner, e2e === null ? null : (e2e.name as E2eRunner), launcher);
  return { stack, ui, api, e2e, line, installs, notes };
}

/** The proposal written into `.agentplugged/proofs.yaml`: one command, the line of the criteria. */
export function proofsProposal(line: string, e2e: boolean): string {
  const quoted = `'${line.replaceAll("'", "''")}'`;
  return [
    "# Proposed by `npx agentplugged tests setup`. Nothing here runs until the creator accepts the",
    "# exact line, once, in the chat (guard.creator_action, kind proof_commands).",
    "commands:",
    "  - name: criteria",
    `    run: ${quoted}`,
    `    timeout: ${e2e ? 900 : 600}`,
    "",
  ].join("\n");
}

/** What `tests setup` did. */
export interface TestsSetupResult {
  /**
   * `written`: the proposal is in the file now; `declared`: the file already holds a line that runs
   * the criteria, nothing written; `exists`: the file exists without one, nothing written (add the
   * line); `invalid`: the file cannot be read, nothing written; `unknown_stack`: no runner to propose.
   */
  readonly status: "written" | "declared" | "exists" | "invalid" | "unknown_stack";
  readonly path: string;
  readonly plan: TestPlan;
  /** The problems of an invalid file, as the engine reads it. */
  readonly problems: readonly string[];
}

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "tests",
    reason,
  });
}

/**
 * `tests setup [--runner <name>] [--e2e <name>|none]`: the plan of the product's test
 * framework and, when the product declares no commands yet, the proposal of the command that runs the
 * tests of a criterion. The file is the product's: a declaration that exists is never touched.
 */
export const testsCommand = defineCommand<TestsSetupResult>({
  name: "tests",
  async run(context, input) {
    const { action, runner, e2e } = input as { action?: unknown; runner?: unknown; e2e?: unknown };
    const extra = Object.keys(input).find(
      (key) => key !== "action" && key !== "runner" && key !== "e2e",
    );
    const usage = "tests setup [--runner <name>] [--e2e playwright|cypress|none]";
    if (action !== "setup" || extra !== undefined) {
      return fail(invalid(`tests ${String(action ?? "")} (${usage})`.trim()));
    }
    if (runner !== undefined && !isApiRunner(runner)) {
      return fail(invalid(`--runner ${String(runner)} (${API_RUNNERS.join(", ")})`));
    }
    if (e2e !== undefined && e2e !== "none" && !isE2eRunner(e2e)) {
      return fail(invalid(`--e2e ${String(e2e)} (${E2E_RUNNERS.join(", ")}, none)`));
    }
    const { files } = context;
    if (!(await files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    const plan = await testPlan(files, {
      ...(runner === undefined ? {} : { runner }),
      ...(e2e === undefined ? {} : { e2e }),
    });
    const base = { path: PROOFS_PATH, plan, problems: [] as string[] };
    if (plan.line === null) return ok({ ...base, status: "unknown_stack" });
    const declaration = await readProofDeclaration(files);
    if (declaration.kind === "invalid") {
      return ok({ ...base, status: "invalid", problems: declaration.problems });
    }
    if (declaration.kind === "commands") {
      const holds = declaration.commands.some((command) => runsCriteria(command.run));
      return ok({ ...base, status: holds ? "declared" : "exists" });
    }
    const text = proofsProposal(plan.line, plan.e2e !== null);
    // Written meanwhile by someone else: theirs, never replaced.
    let created: boolean;
    if (files.createText !== undefined) created = await files.createText(PROOFS_PATH, text);
    else if (await files.exists(PROOFS_PATH)) created = false;
    else {
      await files.writeText(PROOFS_PATH, text);
      created = true;
    }
    return ok({ ...base, status: created ? "written" : "exists" });
  },
});
