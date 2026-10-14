import { CI_FORGES, type CiForge, ErrorCode, resolveGitWorkflow } from "@agentplugged/protocol";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import type { MethodSource } from "../method/method-source.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { ciUnavailable } from "./ci-check.js";
import { existingCi, GITHUB_WORKFLOWS_DIR } from "./ci-rules.js";

/**
 * `ci setup`: the base CI of the product — lint, tests, build and dependency audit,
 * one check each — written from the method's templates (`skills/setup-ci/assets/`) for the
 * product's forge, adapted to its `package.json`. Deterministic: the same files give the same
 * workflow. Never over an existing CI.
 */

/** The method's templates, by forge, and where each workflow goes in the product. */
export const CI_TEMPLATES: Readonly<Record<CiForge, { template: string; path: string }>> = {
  github: {
    template: "skills/setup-ci/assets/github-actions.yml",
    path: `${GITHUB_WORKFLOWS_DIR}/ci.yml`,
  },
  gitlab: { template: "skills/setup-ci/assets/gitlab-ci.yml", path: ".gitlab-ci.yml" },
};

/** The stacks the templates know; `other`: every step is a TODO to fill. */
export const CI_STACKS = ["pnpm", "npm", "yarn", "yarn-classic", "other"] as const;
export type CiStack = (typeof CI_STACKS)[number];

/** The checks of the base CI, one job each. */
export const CI_JOBS = ["lint", "test", "build", "audit"] as const;
export type CiJob = (typeof CI_JOBS)[number];

/** A command of a job, or a TODO to fill (written as a comment and a failing command). */
type Step = { readonly run: string } | { readonly todo: string };

/** What the product's files say about how to check it. */
export interface CiPlan {
  readonly stack: CiStack;
  /** The folder's Node version file (`.nvmrc`, `.node-version`), when there is one. */
  readonly nodeVersionFile: string | null;
  /** The Node version that file names (`24`, `22.11.0`, `lts`), when it is one. */
  readonly nodeVersion: string | null;
  /** A lock file exists: dependencies install as locked, and are cached. */
  readonly locked: boolean;
  /** Commands that install the dependencies. */
  readonly install: readonly string[];
  readonly jobs: Readonly<Record<CiJob, readonly Step[]>>;
  /** What the setup leaves to check, written as comments (`setup: …`): never a failing step. */
  readonly notes: readonly string[];
}

interface PackageJson {
  readonly packageManager?: unknown;
  readonly scripts?: unknown;
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
}

/**
 * The scripts that run a level of tests apart from `test`: the API, integration and
 * end-to-end tests of the test framework. The base CI runs them in the `test` job, after `test`,
 * unless `test` already runs them (its script names them).
 */
export const TEST_LEVEL_SCRIPTS = ["test:api", "test:integration", "test:e2e", "e2e"] as const;

/** The scripts of a manifest, by name. */
function scriptsOf(manifest: PackageJson | undefined): Record<string, unknown> {
  return typeof manifest?.scripts === "object" && manifest.scripts !== null
    ? (manifest.scripts as Record<string, unknown>)
    : {};
}

/** The test-level scripts the manifest has and its `test` script does not already run. */
function separateTestScripts(manifest: PackageJson | undefined): string[] {
  const scripts = scriptsOf(manifest);
  const whole = typeof scripts.test === "string" ? scripts.test : "";
  return TEST_LEVEL_SCRIPTS.filter(
    (key) =>
      typeof scripts[key] === "string" &&
      !whole.includes(key) &&
      // `e2e` and `test:e2e` are one level: the second wins.
      (key !== "e2e" || typeof scripts["test:e2e"] !== "string"),
  );
}

/** True when the manifest depends on the package (dependencies or devDependencies). */
function dependsOn(manifest: PackageJson | undefined, name: string): boolean {
  return [manifest?.dependencies, manifest?.devDependencies].some(
    (group) => typeof group === "object" && group !== null && Object.hasOwn(group, name),
  );
}

/** The manifest of the root `package.json`, or undefined when absent or unreadable. */
async function readManifest(files: WorkspaceFiles): Promise<PackageJson | undefined> {
  if (!(await files.exists("package.json").catch(() => false))) return undefined;
  try {
    const text = (await files.readText("package.json")).replace(/^﻿/, "");
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as PackageJson)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What an existing CI leaves out of the test framework: each test-level script of
 * `package.json` that no CI file names. Local files only; a CI that lives elsewhere is not read.
 */
export async function ciTestGaps(
  files: WorkspaceFiles,
  ciFiles: readonly string[],
): Promise<string[]> {
  const missing = separateTestScripts(await readManifest(files));
  if (missing.length === 0) return [];
  if (ciFiles.length === 0) return [];
  let combined = "";
  for (const path of ciFiles) {
    combined += `\n${await files.readText(path).catch(() => "")}`;
  }
  // The script as a word of its own: `e2e` is neither `test:e2e` nor a `tests/e2e` folder.
  const named = (key: string) =>
    new RegExp(`(?<![\\w:/.-])${key.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w:-])`).test(
      combined,
    );
  return missing
    .filter((key) => !named(key))
    .map((key) => `test: the CI does not run "${key}" (add it to the test job)`);
}

const todoOf = (job: CiJob, what: string): Step => ({ todo: `${job}: ${what}` });

/** A Node version as a container tag: `24`, `22.11.0`; `lts` for an LTS alias; else null. */
function nodeTag(text: string): string | null {
  const version = text.trim().replace(/^v/i, "");
  if (/^\d+(?:\.\d+){0,2}$/.test(version)) return version;
  if (/^lts(?:\/.*)?$/i.test(version) || version === "node") return "lts";
  return null;
}

/** A plan whose every step is a TODO: a stack the templates do not know. */
function otherPlan(why: string, notes: readonly string[] = []): CiPlan {
  const what = `set up the checks of this stack (${why})`;
  return {
    stack: "other",
    nodeVersionFile: null,
    nodeVersion: null,
    locked: false,
    install: [],
    jobs: {
      lint: [todoOf("lint", `run the linter: ${what}`)],
      test: [todoOf("test", `run the tests: ${what}`)],
      build: [todoOf("build", `build the product: ${what}`)],
      audit: [todoOf("audit", `audit the dependencies: ${what}`)],
    },
    notes: [`setup: set up the toolchain of this stack (${why})`, ...notes],
  };
}

/** The plan of the base CI, from the workspace's root files. Pure apart from reading them. */
export async function ciPlan(files: WorkspaceFiles): Promise<CiPlan> {
  const has = (path: string) => files.exists(path).catch(() => false);
  let nodeVersionFile: string | null = null;
  let nodeVersion: string | null = null;
  for (const name of [".nvmrc", ".node-version"]) {
    if (nodeVersionFile === null && (await has(name))) {
      nodeVersionFile = name;
      nodeVersion = nodeTag(await files.readText(name).catch(() => ""));
    }
  }
  const manifest = await readManifest(files);
  if (manifest === undefined) return otherPlan("no readable package.json");
  const notes: string[] = [];
  const declared =
    typeof manifest.packageManager === "string" ? manifest.packageManager.trim() : "";
  const at = declared.indexOf("@", 1);
  const name = at < 0 ? declared : declared.slice(0, at);
  const version = at < 0 ? "" : declared.slice(at + 1);
  let stack: CiStack;
  if (declared !== "") {
    if (name === "pnpm") stack = "pnpm";
    else if (name === "yarn") stack = /^1\./.test(version) ? "yarn-classic" : "yarn";
    else if (name === "npm") stack = "npm";
    else return otherPlan(`the package manager ${name} is not one of pnpm, npm or yarn`);
  } else {
    if (await has("pnpm-lock.yaml")) stack = "pnpm";
    else if (await has("yarn.lock")) stack = (await has(".yarnrc.yml")) ? "yarn" : "yarn-classic";
    else if ((await has("package-lock.json")) || (await has("npm-shrinkwrap.json"))) stack = "npm";
    else {
      for (const lock of ["bun.lockb", "bun.lock", "deno.lock"]) {
        if (await has(lock)) return otherPlan(`${lock}: not one of pnpm, npm or yarn`);
      }
      stack = "npm";
    }
    notes.push(
      `setup: pin the package manager and its version in package.json ("packageManager": "${stack === "yarn-classic" ? "yarn" : stack}@<version>"), so the CI uses the same one`,
    );
  }
  const lockFile = {
    pnpm: ["pnpm-lock.yaml"],
    npm: ["package-lock.json", "npm-shrinkwrap.json"],
    yarn: ["yarn.lock"],
    "yarn-classic": ["yarn.lock"],
    other: [],
  }[stack];
  let locked = false;
  for (const path of lockFile) if (await has(path)) locked = true;
  if (!locked) {
    notes.push(
      `setup: commit the lock file (${lockFile[0]}): without it, the CI installs whatever versions it finds`,
    );
  }
  const scripts = scriptsOf(manifest);
  const script = (key: string) => Object.hasOwn(scripts, key) && typeof scripts[key] === "string";
  const runner = stack === "pnpm" ? "pnpm run" : stack === "npm" ? "npm run" : "yarn run";
  const corepack = "npm install --global corepack@latest && corepack enable";
  const install = {
    pnpm: [corepack, locked ? "pnpm install --frozen-lockfile" : "pnpm install"],
    npm: [locked ? "npm ci" : "npm install"],
    yarn: [corepack, locked ? "yarn install --immutable" : "yarn install"],
    "yarn-classic": [locked ? "yarn install --frozen-lockfile" : "yarn install"],
    other: [],
  }[stack];
  const audit = {
    pnpm: "pnpm audit --audit-level high",
    npm: "npm audit --audit-level=high",
    yarn: "yarn npm audit --all --severity high",
    "yarn-classic": "yarn audit --level high",
    other: "",
  }[stack];
  const scripted = (job: CiJob, key: string): Step =>
    script(key)
      ? { run: `${runner} ${key}` }
      : todoOf(job, `add a "${key}" script to package.json, or replace this step`);
  // The API, integration and end-to-end tests run in the same job, after `test`; the
  // browsers of Playwright are downloaded first, whichever script runs the end-to-end tests.
  const exec = stack === "pnpm" ? "pnpm exec" : stack === "npm" ? "npx" : "yarn";
  const separate = separateTestScripts(manifest);
  const testText = typeof scripts.test === "string" ? scripts.test : "";
  const browsers: Step[] =
    dependsOn(manifest, "@playwright/test") &&
    (/e2e|playwright/.test(testText) || separate.some((key) => /e2e/.test(key)))
      ? [{ run: `${exec} playwright install --with-deps` }]
      : [];
  const levels: Step[] = separate.map((key) => ({ run: `${runner} ${key}` }));
  return {
    stack,
    nodeVersionFile,
    nodeVersion,
    locked,
    install,
    jobs: {
      lint: [
        scripted("lint", "lint"),
        ...(script("typecheck") ? [{ run: `${runner} typecheck` }] : []),
      ],
      test: [...browsers, scripted("test", "test"), ...levels],
      build: [scripted("build", "build")],
      audit: [{ run: audit }],
    },
    notes,
  };
}

/** A YAML scalar in single quotes: any command stays one string. */
function quoted(text: string): string {
  return `'${text.replaceAll("'", "''")}'`;
}

/** The failing command of a TODO: never a false green. */
function todoCommand(todo: string): string {
  return `echo ${JSON.stringify(`TODO ${todo}`)} && exit 1`;
}

/** The lines of a step, for GitHub Actions (`- run:`) or GitLab CI (`- `). */
function stepLines(forge: CiForge, step: Step): string[] {
  const command = "run" in step ? step.run : todoCommand(step.todo);
  const line = forge === "github" ? `- run: ${quoted(command)}` : `- ${quoted(command)}`;
  return "todo" in step ? [`# TODO ${step.todo}`, line] : [line];
}

/** The setup of every job: checkout, Node and the dependencies (GitHub), or the install (GitLab). */
function setupLines(forge: CiForge, plan: CiPlan): string[] {
  if (forge === "gitlab") {
    if (plan.stack === "other") {
      return ["# TODO set up the toolchain of this stack", "- 'echo \"TODO toolchain\"'"];
    }
    return plan.install.map((command) => `- ${quoted(command)}`);
  }
  const lines = ["- uses: actions/checkout@v4"];
  if (plan.stack === "other") {
    return [...lines, "# TODO set up the toolchain of this stack (language, dependencies)"];
  }
  const [first, ...rest] = plan.install;
  // corepack installs pnpm or yarn before setup-node looks for it (its cache).
  if (plan.stack === "pnpm" || plan.stack === "yarn") {
    if (first !== undefined) lines.push(`- run: ${quoted(first)}`);
  }
  const manager = plan.stack === "yarn-classic" ? "yarn" : plan.stack;
  lines.push(
    "- uses: actions/setup-node@v4",
    "  with:",
    plan.nodeVersionFile === null
      ? "    node-version: lts/*"
      : `    node-version-file: ${plan.nodeVersionFile}`,
    ...(plan.locked ? [`    cache: ${manager}`] : []),
  );
  const install = plan.stack === "pnpm" || plan.stack === "yarn" ? rest : plan.install;
  for (const command of install) lines.push(`- run: ${quoted(command)}`);
  return lines;
}

/** The header's comment lines: the stack, then what the setup leaves to check. */
function headerLines(plan: CiPlan): string[] {
  const manager = plan.stack === "yarn-classic" ? "yarn 1" : plan.stack;
  const stack =
    plan.stack === "other"
      ? "Stack: not recognised. Fill each TODO: until then, every check fails on purpose."
      : `Stack: Node.js with ${manager}, from package.json.`;
  return [`# ${stack}`, ...plan.notes.map((note) => `# TODO ${note}`)];
}

/**
 * The workflow of `forge`, from its template: each line holding only `{{name}}` takes a block,
 * indented as that line (`header`, `setup`, `runner` and a job each); `{{main_branch}}`, `{{runs_on}}` and
 * `{{image}}` take a value. GitHub's own expressions (`${{ github.ref }}`) are left as they are.
 * The CI also runs on the integration branch (`main` + `dev`), and on the creator's own
 * machine (`local`: a self-hosted runner) when they chose it.
 */
export function renderCiTemplate(
  template: string,
  forge: CiForge,
  plan: CiPlan,
  main: string,
  workflow: { readonly integration?: string | undefined; readonly local?: boolean } = {},
): string {
  const blocks: Record<string, string[]> = {
    header: headerLines(plan),
    setup: setupLines(forge, plan),
    // GitLab picks a runner by its tags: the creator's own runner, named as theirs.
    runner:
      workflow.local === true && forge === "gitlab"
        ? [
            "# The CI runs on your own machine: give your runner's tag here.",
            "tags:",
            "  - self-hosted",
          ]
        : [],
    ...Object.fromEntries(
      CI_JOBS.map((job) => [job, plan.jobs[job].flatMap((step) => stepLines(forge, step))]),
    ),
  };
  const values: Record<string, string> = {
    main_branch: workflow.integration === undefined ? main : `${main}, ${workflow.integration}`,
    runs_on: workflow.local === true ? "self-hosted" : "ubuntu-latest",
    image: plan.stack === "other" ? "alpine:latest" : `node:${plan.nodeVersion ?? "lts"}`,
  };
  const lines = template.replaceAll("\r\n", "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const block = /^(\s*)\{\{([a-z_]+)\}\}\s*$/.exec(line);
    const name = block?.[2];
    if (block !== null && name !== undefined && Object.hasOwn(blocks, name)) {
      const indent = block[1] ?? "";
      for (const entry of blocks[name] ?? []) out.push(`${indent}${entry}`);
      continue;
    }
    out.push(
      line.replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) =>
        Object.hasOwn(values, key) ? (values[key] as string) : whole,
      ),
    );
  }
  return out.join("\n");
}

/** What is left in a plan: the setup's notes, then the TODOs of the jobs. */
function todosOf(plan: CiPlan): string[] {
  return [
    ...plan.notes,
    ...CI_JOBS.flatMap((job) =>
      plan.jobs[job].flatMap((step) => ("todo" in step ? [step.todo] : [])),
    ),
  ];
}

/** What `ci setup` did. */
export interface CiSetupResult {
  /**
   * `created`: the workflow written now; `exists`: the product has a CI, nothing written;
   * `not_wanted`: the creator chose to have no CI, nothing written.
   */
  readonly status: "created" | "exists" | "not_wanted";
  /** The CI files found (`exists`), else empty. */
  readonly existing: readonly string[];
  readonly forge?: CiForge;
  /** The workflow written, relative to the workspace. */
  readonly path?: string;
  readonly stack?: CiStack;
  /** What is left to fill (`<job>: …`, `setup: …`), each job's TODO a failing step until done. */
  readonly todo: readonly string[];
}

function invalid(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "ci",
    reason,
  });
}

async function readTemplate(method: MethodSource, path: string): Promise<string> {
  try {
    return await method.readText(path);
  } catch (error) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: `the method's CI template ${path} cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * `ci setup [--forge github|gitlab]`: writes the base CI of the product for its forge
 * (`--forge`, else `method.yaml`'s `ci.forge`, else the `origin` remote's), unless the repository
 * already has one at its top. The workspace must be the repository's top folder (`next` never
 * proposes it otherwise). The file is the product's: never in the manifest, never written again.
 */
export const ciCommand = defineCommand<CiSetupResult>({
  name: "ci",
  async run(context, input) {
    const { action, forge: asked } = input as { action?: unknown; forge?: unknown };
    const extra = Object.keys(input).find((key) => key !== "action" && key !== "forge");
    if (action !== "setup" || extra !== undefined) {
      return fail(invalid(`ci ${String(action ?? "")} (ci setup [--forge github|gitlab])`.trim()));
    }
    if (asked !== undefined && !(CI_FORGES as readonly unknown[]).includes(asked)) {
      return fail(invalid(`--forge ${String(asked)} (github, gitlab)`));
    }
    const { files } = context;
    if (!(await files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    // The creator's workflow says whether there is a CI, and where it runs.
    const flow = resolveGitWorkflow(loaded.config.git);
    if (flow.ci === "none") return ok({ status: "not_wanted", existing: [], todo: [] });
    try {
      const reader = context.ciReader;
      const repository = reader === undefined ? null : await reader.repository();
      const local = await existingCi(files);
      const existing = [...new Set([...(repository?.ci ?? []), ...local])];
      // An existing CI is never touched, but the tests it does not run are said.
      if (existing.length > 0) {
        return ok({ status: "exists", existing, todo: await ciTestGaps(files, local) });
      }
      if (repository === null) return fail(ciUnavailable("no_repository"));
      if (repository.prefix !== "") {
        return fail(ciUnavailable("not_repository_root", { prefix: repository.prefix }));
      }
      const forge = (asked as CiForge | undefined) ?? loaded.config.ci?.forge ?? repository.forge;
      if (forge === null) return fail(ciUnavailable("no_forge"));
      const { template, path } = CI_TEMPLATES[forge];
      const plan = await ciPlan(files);
      const text = renderCiTemplate(
        await readTemplate(context.method, template),
        forge,
        plan,
        repository.main ?? "main",
        { integration: flow.integration, local: flow.ci === "local" },
      );
      const slash = path.lastIndexOf("/");
      if (slash > 0) await files.mkdir(path.slice(0, slash));
      let created: boolean;
      if (files.createText !== undefined) created = await files.createText(path, text);
      else if (await files.exists(path)) created = false;
      else {
        await files.writeText(path, text);
        created = true;
      }
      // Written meanwhile by someone else: theirs, never replaced.
      if (!created) return ok({ status: "exists", existing: [path], todo: [] });
      return ok({
        status: "created",
        existing: [],
        forge,
        path,
        stack: plan.stack,
        todo: todosOf(plan),
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
