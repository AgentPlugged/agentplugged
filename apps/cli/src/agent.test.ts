import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { isMessageKey } from "@agentplugged/i18n";
import { ISSUE } from "@agentplugged/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./main.js";

let cwd: string;
let home: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-agent-"));
  home = await mkdtemp(join(tmpdir(), "agentplugged-home-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** Runs the CLI as if a creator typed `answers` in a terminal. */
async function run(args: string[], answers?: string[], lang = "en") {
  let stdout = "";
  let stderr = "";
  const status = await main({
    argv: args,
    cwd,
    env: {
      PATH: "",
      HOME: home,
      USERPROFILE: home,
      AGENTPLUGGED_LANG: lang,
      // The keychain service of the test run, and no Windows Hello (vitest.config.ts).
      AGENTPLUGGED_KEYCHAIN_SERVICE: process.env.AGENTPLUGGED_KEYCHAIN_SERVICE,
      AGENTPLUGGED_PRESENCE: "none",
      AGENTPLUGGED_ENVIRONMENT: "none",
    },
    engineVersion: "1.0.0",
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: Readable.from(answers === undefined ? [] : [answers.map((a) => `${a}\n`).join("")]),
    interactive: answers !== undefined,
  });
  return { status, stdout, stderr };
}

const read = (path: string) => readFile(join(cwd, path), "utf8");

describe("agent create: questions in the terminal", () => {
  it("asks name, title, description, icon, role, domain and phase", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const { status, stdout, stderr } = await run(
      ["agent", "create", "scout"],
      ["", "", "Market Scout", "Scouts the market.", "🧭", "", "10", "6"],
    );
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Display name [Scout]: Title (for example Market Scout): ");
    expect(stdout).toContain("Title (for example Market Scout): An answer is required.\n");
    expect(stdout).toContain("Domain\n   1. Framing and product\n");
    expect(stdout).toContain("Domain [1]: ");
    expect(stdout).toContain("Phase [1]: ");
    expect(stdout).toContain(
      "Agent scout created:\n  .agentplugged/agents/scout/SKILL.md\n  .agentplugged/agents/scout/agent.yaml\nNext step: run `npx agentplugged sync`",
    );
    const skill = await read(".agentplugged/agents/scout/SKILL.md");
    expect(skill).toContain('description: "Scouts the market."\n');
    expect(skill).toContain("  domain: marketing\n  phase: launch\n");
    const yaml = await read(".agentplugged/agents/scout/agent.yaml");
    expect(yaml).toContain('name: "Scout"\ntitle: "Market Scout"\nicon: "🧭"\n');
    expect(yaml).toContain("# role: ");
  });

  it("checks each answer as it is typed and asks again", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const { status, stdout } = await run(
      ["agent", "create", "lena"],
      ["n".repeat(41), "Léna", "UX", "Designs.", "far too long", "🎨", "", "2", "3"],
      "fr",
    );
    expect(status).toBe(0);
    expect(stdout).toContain(
      "Nom affiché [Lena] : --name est trop long : 40 caractères au plus.\n",
    );
    expect(stdout).toContain("--icon est trop long : 8 caractères au plus.\n");
    const yaml = await read(".agentplugged/agents/lena/agent.yaml");
    expect(yaml).toContain('name: "Léna"\ntitle: "UX"\nicon: "🎨"\n');
  });

  it("asks only the description of a skill, and only what the options did not give", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const skill = await run(["agent", "create", "--skill", "pricing"], ["Sets the price."], "fr");
    expect(skill.status).toBe(0);
    expect(skill.stdout).toContain("Description (ce qu'il fait et quand l'appeler) : ");
    expect(skill.stdout).toContain("Compétence pricing créée :\n");
    expect(skill.stdout).not.toContain("Titre");
    expect(skill.stdout).not.toContain("Nom affiché");

    const agent = await run(
      [
        "agent",
        "create",
        "scout",
        "--name",
        "Scout",
        "--title",
        " ",
        "--domain",
        "product",
        "--phase",
        "build",
      ],
      ["Scout", "Scouts.", "", ""],
    );
    expect(agent.stderr).toBe("");
    expect(agent.status).toBe(0);
    // A blank option counts as absent: its question is asked.
    expect(agent.stdout).toContain("Title (for example Market Scout): ");
    expect(agent.stdout).not.toContain("Display name");
    expect(agent.stdout).not.toContain("Domain");
    expect(agent.stdout).toContain("Icon (an emoji, Enter for none): ");
  });

  it("refuses an invalid option before any question", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    for (const args of [
      ["agent", "create", "scout", "--domain", "legal"],
      ["agent", "create", "scout", "--icon", "far too long"],
      ["agent", "create", "--skill", "pricing", "--title", "x"],
      ["agent", "create", "2d"],
    ]) {
      const { status, stdout, stderr } = await run(args, ["x", "x", "x"], "fr");
      expect(status, args.join(" ")).toBe(1);
      expect(stdout, args.join(" ")).toBe("");
      expect(stderr, args.join(" ")).toContain("Erreur INVALID_ARGUMENTS : ");
    }
    const { stderr } = await run(["agent", "create", "scout", "--domain", "legal"], ["x"], "fr");
    expect(stderr).toContain("--domain « legal » n'est pas valide (valeurs possibles : product, ");
  });

  it("refuses a taken id before any question", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const { status, stdout, stderr } = await run(["agent", "create", "iris"], ["x"]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Error AGENT_EXISTS: ");
  });

  it("cancels at the end of the input without writing anything", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const { status, stderr } = await run(["agent", "create", "scout"], ["", "Scout"]);
    expect(status).toBe(1);
    expect(stderr).toContain("CANCELLED");
    expect(existsSync(join(cwd, ".agentplugged/agents/scout"))).toBe(false);
  });
});

describe("error messages", () => {
  it("translates schema reasons and every message core uses", async () => {
    for (const key of [
      "error.agent.id_required",
      "error.agent.invalid_id",
      "error.agent.invalid_skill_id",
      "error.agent.unknown_action",
      "error.agent.unknown_kind",
      "error.agent.skill_options",
      "error.agent.required",
      "error.agent.too_long",
      "error.agent.invalid_choice",
      "error.agent.personal_skill_only",
      "error.agent.layer_alone",
      "error.skill_override_refused",
      "error.skill_override_orphan",
      "error.skill_override_own",
      "error.agent.skill_in_use",
      "error.override_orphan",
      "error.override_own_agent",
      "error.menu_skill_disabled",
      "reason.unknown_skill",
      ...Object.keys(ISSUE).map((name) => `reason.${name}`),
    ]) {
      expect(isMessageKey(key), key).toBe(true);
    }

    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    await writeFile(
      join(cwd, ".agentplugged/agents/iris/agent.yaml"),
      "name: Iris\ntitle: T\nmenu:\n  - code: A\n    description: d\n    prompt: p\n  - code: a\n    description: e\n    prompt: q\n",
    );
    const { status, stderr } = await run(["sync"], undefined, "fr");
    expect(status).toBe(1);
    expect(stderr).toContain("champ « menu.1.code » (ce code de menu est déjà utilisé)");
    expect(stderr).not.toContain("duplicate code");
  });
});

describe("agent create: pinned engine version", () => {
  it("stops before any question when method.yaml pins another engine", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const path = join(cwd, ".agentplugged/method.yaml");
    await writeFile(path, (await read(".agentplugged/method.yaml")).replace("1.0.0", "0.0.9"));
    const { status, stdout, stderr } = await run(["agent", "create", "x"], ["Scout", "", ""]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Error ENGINE_VERSION_MISMATCH:");
    expect(stderr).toContain("`npx agentplugged@0.0.9 agent create x`");
    expect(existsSync(join(cwd, ".agentplugged/agents/x"))).toBe(false);
  });
});
