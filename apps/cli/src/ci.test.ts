import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  type CiCheckResult,
  ciPlan,
  type NextResult,
  renderCiTemplate,
  renderConstitution,
  renderConstitutionReference,
} from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatCiSetup, formatStoryCi } from "./ci-text.js";
import { main } from "./main.js";
import { formatNext, nextJson } from "./next-text.js";

vi.setConfig({ testTimeout: 120_000 });

const fr = createTranslator("fr");
const en = createTranslator("en");
const flat = (text: string) => text.replace(/\s+/g, " ");
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");

const FAILED: CiCheckResult = {
  story: "1-1",
  branch: "feat/1-1-sign-up",
  agent: "sam",
  forge: "github",
  status: "fail",
  checks: 4,
  failed: ["test", "audit"],
  pr: 12,
  url: "https://github.com/acme/shop/pull/12",
  commit: "a".repeat(40),
  reopened: true,
  story_status: "in_progress",
  event: {
    id: "01JZ0000000000000000000000",
    type: "story.ci_reported",
    at: "2026-10-03T12:00:00Z",
  },
};

describe("story ci's text", () => {
  it("says the failed checks and who to relaunch on the same branch", () => {
    expect(formatStoryCi(fr, FAILED)).toBe(
      [
        "CI de la story 1-1 : en échec sur feat/1-1-sign-up (test, audit).",
        "La story repasse en développement : relance sam sur la même branche (npx agentplugged story start 1-1).",
        "  Pull request : https://github.com/acme/shop/pull/12",
        "",
      ].join("\n"),
    );
    const green = formatStoryCi(en, { ...FAILED, status: "pass", failed: [], reopened: false });
    expect(green).toContain("CI of story 1-1: green (4 checks) on feat/1-1-sign-up.");
    expect(green).not.toContain("Relaunch");
    expect(formatStoryCi(fr, { ...FAILED, reopened: false })).toContain("Relance sam");
    // Blocked: never « relaunch the agent », lift the block first.
    const blocked = formatStoryCi(fr, { ...FAILED, reopened: false, story_status: "blocked" });
    expect(blocked).toContain("La story est bloquée");
    expect(blocked).not.toContain("Relance");
    expect(
      formatStoryCi(fr, {
        story: "1-1",
        waived: true,
        branch: "feat/1-1-sign-up",
        commit: "b".repeat(40),
        reason: "Forge auto-hébergée.",
        event: { id: "01JZ0000000000000000000001", type: "story.ci_waived", at: "2026-10-03Z" },
      }),
    ).toBe(
      "CI de la story 1-1 acceptée sans lecture, pour le commit bbbbbbb (Forge auto-hébergée.) : la story peut passer à sa revue.\n",
    );
  });

  it("says what ci setup wrote, what is left to fill, or the CI found", () => {
    const created = formatCiSetup(fr, {
      status: "created",
      existing: [],
      forge: "github",
      path: ".github/workflows/ci.yml",
      stack: "pnpm",
      todo: ['build: add a "build" script to package.json, or replace this step'],
    });
    expect(created).toContain("CI de base écrite dans .github/workflows/ci.yml (github, pnpm)");
    expect(created).toContain("À compléter (en échec d'ici là) : build:");
    expect(formatCiSetup(en, { status: "exists", existing: [".gitlab-ci.yml"], todo: [] })).toBe(
      "The product already has a CI (.gitlab-ci.yml): nothing was written.\n",
    );
  });

  it("shows the CI of a next step, in text and in JSON only when there is one", () => {
    const step: NextResult = {
      step: "ci_failed",
      you: false,
      agent: "sam",
      agent_name: "Sam",
      tool: "codex",
      waiting: [],
      command: "npx agentplugged story start 1-1",
      story: "1-1",
      checkpoint: null,
      sync: null,
      missing_tools: [],
      pending_keys: [],
      phase: null,
      phases: [],
      stray: [],
      sprint: null,
      deferred: null,
      ci: {
        status: "fail",
        failed: ["test"],
        pr: 12,
        url: "https://github.com/acme/shop/pull/12",
        cause: null,
        waive: false,
      },
    };
    const text = formatNext(fr, step);
    expect(text).toContain("Étape : CI en échec : corriger sur la même branche, story 1-1");
    expect(text).toContain("Vérifications en échec : test");
    expect(text).toContain("Pull request : https://github.com/acme/shop/pull/12");
    expect(JSON.parse(nextJson(step)).ci).toEqual(step.ci);
    // No CI that can be read: the cause, and the creator's way out.
    // The creator accepts the story in the chat, no command to type.
    const waive = true;
    const stuck = formatNext(fr, {
      ...step,
      step: "ci_check",
      you: true,
      command: null,
      ci: { status: "unknown", failed: [], pr: null, url: null, cause: "no_ci", waive },
    });
    expect(stuck).toContain("Pas de CI lisible");
    expect(stuck).not.toContain("--waive");
    const check = formatNext(en, {
      ...step,
      step: "ci_check",
      command: "npx agentplugged story ci 1-1",
      ci: { status: "stale", failed: [], pr: 12, url: null, cause: null, waive },
    });
    expect(check).toContain(
      "If the CI cannot be read, only you accept the story without it: say so in your AI tool's chat, typed or dictated, with your reason (it is recorded in the journal).",
    );
    const { ci: _ci, ...without } = step;
    expect(JSON.parse(nextJson({ ...without, step: "build" }))).not.toHaveProperty("ci");
  });
});

describe("story ci and ci setup's arguments", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-ci-cli-")));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function run(args: string[]) {
    let stdout = "";
    let stderr = "";
    const status = await main({
      argv: args,
      cwd,
      env: {
        AGENTPLUGGED_LANG: "fr",
        AGENTPLUGGED_PRESENCE: "none",
        AGENTPLUGGED_ENVIRONMENT: "none",
        AGENTPLUGGED_KEYCHAIN_SERVICE:
          process.env.AGENTPLUGGED_KEYCHAIN_SERVICE ?? "agentplugged-test-ci-cli",
        GIT_CEILING_DIRECTORIES: cwd,
        PATH: process.env.PATH ?? "",
      },
      engineVersion: "1.0.0",
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      stdin: Readable.from([]),
      interactive: false,
    });
    return { status, stdout, stderr };
  }

  it("refuses anything but story ci <epic>-<story> and ci setup [--forge]", async () => {
    for (const args of [
      ["story", "ci"],
      ["story", "ci", "1-1", "x"],
    ]) {
      const result = await run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("story ci <epic>-<story>");
    }
    for (const args of [["ci"], ["ci", "run"], ["ci", "setup", "x"]]) {
      const result = await run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("ci setup [--forge github|gitlab]");
    }
    const forge = await run(["next", "--forge", "github"]);
    expect(forge.status).toBe(1);
    expect(forge.stderr).toContain("--forge");
  });

  it("needs the method installed", async () => {
    for (const args of [
      ["story", "ci", "1-1"],
      ["ci", "setup"],
    ]) {
      const result = await run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("METHOD_NOT_INSTALLED");
    }
  });
});

describe("the method's CI", () => {
  it("ships the setup-ci skill, called from Omar's menu, and its templates", async () => {
    const skill = flat(read("skills/setup-ci/SKILL.md"));
    expect(skill).toContain("name: setup-ci");
    expect(skill).toContain("agent: omar");
    expect(skill).toContain("`npx agentplugged ci setup`");
    expect(read("agents/omar/agent.yaml")).toContain("skill: setup-ci");
    expect(flat(read("agents/omar/SKILL.md"))).toContain("`setup-ci` skill");
    const plan = await ciPlan(new NodeWorkspaceFiles(cwdOfMethod()));
    for (const [template, forge] of [
      ["github-actions.yml", "github"],
      ["gitlab-ci.yml", "gitlab"],
    ] as const) {
      const text = renderCiTemplate(
        read(`skills/setup-ci/assets/${template}`),
        forge,
        plan,
        "main",
      );
      expect(text).toContain("Generated by agentplugged (setup-ci)");
      expect(text).not.toMatch(/\{\{[a-z_]+\}\}/);
      for (const job of ["lint:", "test:", "build:", "audit:"]) expect(text).toContain(job);
    }
  });

  it("tells agents to read the CI and fix a failure on the same branch", () => {
    const constitution = flat(renderConstitutionReference());
    expect(constitution).toContain("read its CI with `story.ci`");
    // The FX item of the developers' menu takes up a red CI (their body no longer repeats it).
    for (const agent of ["sam", "ethan"]) {
      expect(flat(read(`agents/${agent}/agent.yaml`))).toContain("the CI result");
    }
    expect(constitution).toContain("A failed CI sends the story back to `in_progress`");
    // Every agent reads it at every request: AGENTS.md names the tool.
    expect(flat(renderConstitution())).toContain("`story.ci` reads the CI");
    expect(flat(read("README.md"))).toContain("`MERGE_NOT_READY`");
    // The waiver is the creator's: written in the constitution, one answer in the chat (
    // the terminal's command is no longer a deny rule, the creator's answer is what counts).
    expect(constitution).toContain("only the creator accepts a story without it, never you");
    expect(constitution).toContain("one answer in the chat, recorded with its reason");
  });
});

/** The method's own folder: a package.json with scripts, as a product would have. */
function cwdOfMethod(): string {
  return methodDir;
}
