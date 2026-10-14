import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { formatSelection, parseSelection } from "./prompt.js";

let cwd: string;
let home: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "agentplugged-profile-"));
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

const config = () => readFile(join(cwd, ".agentplugged/method.yaml"), "utf8");

describe("selection answers", () => {
  it.each([
    ["1", 5, [1]],
    ["1,3-5", 5, [1, 3, 4, 5]],
    [" 2 1 2 ", 5, [1, 2]],
    ["0", 5, undefined],
    ["6", 5, undefined],
    ["3-1", 5, undefined],
    ["a", 5, undefined],
    ["", 5, undefined],
  ] as const)("parses %j", (answer, max, expected) => {
    expect(parseSelection(answer, max)).toEqual(expected);
  });

  it("formats ranges", () => {
    expect(formatSelection([1, 2, 3, 5, 7, 8])).toBe("1-3,5,7-8");
    expect(formatSelection([4])).toBe("4");
  });
});

describe("init: interactive profile", () => {
  it("records new-product when Enter is pressed everywhere", async () => {
    const { status, stdout } = await run(["init"], ["", "", "", "", "", "", "", "", ""]);
    expect(status).toBe(0);
    expect(stdout).toContain("Product profile\n  1. Complete new product — ");
    expect(stdout).toContain("Profile [1]: ");
    expect(stdout).toContain("Adjust domains, phases and developer specialties? (y/N) ");
    // The validation level: chat by default.
    expect(stdout).toContain("Validation level (how you answer checkpoints)\n  1. chat: ");
    expect(stdout).toContain("Validation level [1]: ");
    expect(stdout).toContain("Validation level: chat: ");
    const yaml = await config();
    expect(yaml).toContain("validation:\n  mode: chat\n");
    // The points that wait for the creator, the defaults proposed.
    expect(stdout).toContain("Points that wait for you: ");
    expect(yaml).toContain(
      "points:\n    - framing\n    - architecture\n    - release\n    - publication\n",
    );
    expect(yaml).toContain("preset: new-product");
    expect(yaml).toContain("specialties:\n    - backend\n    - frontend\n");
    expect(yaml).not.toContain("max_parallel_stories");
    expect(yaml).toContain("inactive:\n    - jade\n");
    expect(stdout).toContain("Developer specialties: Backend, Frontend");
    expect(stdout).toContain("Inactive agents: jade");
  });

  it("asks again after an invalid answer, then adjusts", async () => {
    const { status, stdout } = await run(
      ["init"],
      ["", "9", "4", "o", "1,4", "x", "1,5", "7", "", "x", "2", "", "", "", "", "", ""],
    );
    expect(status).toBe(0);
    expect(stdout).toContain("Invalid answer: 9");
    expect(stdout).toContain("Invalid answer: x");
    expect(stdout).toContain("Active domains (numbers, for example 1,3-5) [1-2,4]: ");
    expect(stdout).toContain("Active specialties (numbers, for example 1,3) [1-2]: ");
    expect(stdout).toContain("Invalid answer: 7");
    expect(stdout).toContain(
      "Stories built at once, all developers together (0: no ceiling, up to 99) [0]: ",
    );
    const yaml = await config();
    expect(yaml).toContain("preset: prototype");
    expect(yaml).toContain("domains:\n    - product\n    - code\n");
    expect(yaml).toContain("phases:\n    - framing\n    - delivery\n");
    // Enter: the specialties keep their default; the ceiling is set.
    expect(yaml).toContain("specialties:\n    - backend\n    - frontend\n");
    expect(yaml).toContain("max_parallel_stories: 2");
  });

  it("does not ask the developer count without the code domain", async () => {
    const { stdout } = await run(["init"], ["", "1", "y", "1,9-11", "", "3", "", "", "", "", ""]);
    expect(stdout).not.toContain("Active specialties");
    const yaml = await config();
    expect(yaml).toContain("specialties: []");
    for (const developer of ["sam", "ethan", "hugo", "lina", "jade"])
      expect(yaml).toContain(`    - ${developer}\n`);
  });

  it("asks nothing when a profile is recorded", async () => {
    await run(["init", "--profile", "launch-only"]);
    const before = await config();
    const { status, stdout } = await run(["init"], ["2", "y"]);
    expect(status).toBe(0);
    expect(stdout).not.toContain("Profile [");
    expect(stdout).toContain("A profile is already recorded and init keeps it.");
    expect(stdout).toContain("Profile: Launch only");
    expect(await config()).toBe(before);
  });
});

describe("end of input", () => {
  it("cancels init without writing anything", async () => {
    const { status, stderr } = await run(["init"], ["", "y", "1-4"]);
    expect(status).toBe(1);
    expect(stderr).toContain("CANCELLED");
    expect(stderr).toContain("nothing was written");
    await expect(readdir(cwd)).resolves.toEqual([]);
  });

  it("cancels profile without touching method.yaml", async () => {
    await run(["init", "--profile", "prototype"]);
    const before = await config();
    const { status, stderr } = await run(["profile"], ["2"], "fr");
    expect(status).toBe(1);
    expect(stderr).toContain("Erreur CANCELLED : Annulé avant la fin des questions");
    expect(await config()).toBe(before);
  });
});

describe("profile: interactive", () => {
  it("starts from the recorded values and changes only method.yaml", async () => {
    await run(["init", "--profile", "new-product"]);
    await mkdir(join(cwd, ".agentplugged/docs"), { recursive: true });
    await writeFile(join(cwd, ".agentplugged/docs/prd.md"), "prd");
    const agents = await readFile(join(cwd, "AGENTS.md"), "utf8");

    const { status, stdout } = await run(
      ["profile"],
      ["", "o", "1-7,9-11", "", "", "", "", "", "", ""],
    );
    expect(status).toBe(0);
    expect(stdout).toContain("Profile [1]: ");
    expect(stdout).toContain("[1-11]: ");
    expect(stdout).toContain("Active specialties (numbers, for example 1,3) [1-2]: ");
    expect(stdout).toContain("Inactive agents: jade, zoe");
    expect(stdout).toContain("Profile recorded in .agentplugged/method.yaml.");
    expect(await config()).toContain("inactive:\n    - jade\n    - zoe\n");
    expect(await readFile(join(cwd, ".agentplugged/docs/prd.md"), "utf8")).toBe("prd");
    expect(await readFile(join(cwd, "AGENTS.md"), "utf8")).toBe(agents);
  });

  it("leaves method.yaml untouched when Enter is pressed everywhere", async () => {
    await run(["init", "--profile", "maintenance"]);
    // The first time, the points the creator keeps are proposed and recorded.
    await run(["profile"], ["", "", "", "", "", ""]);
    const before = await config();
    const { status, stdout, stderr } = await run(["profile"], ["", "", "", "", "", ""]);
    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(stdout).toContain("Profile unchanged in .agentplugged/method.yaml.");
    expect(await config()).toBe(before);
  });

  it("changes the validation level, by question or by option", async () => {
    await run(["init", "--profile", "maintenance"]);
    const asked = await run(["profile"], ["", "", "3", "", "", ""]);
    expect(asked.status).toBe(0);
    expect(asked.stdout).toContain("Validation level: strict: ");
    expect(await config()).toContain("validation:\n  mode: strict\n");
    const given = await run(["profile", "--validation", "auto"]);
    expect(given.status).toBe(0);
    expect(await config()).toContain("validation:\n  mode: auto\n");
    const wrong = await run(["profile", "--validation", "fast"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("METHOD_CONFIG_INVALID");
    const elsewhere = await run(["next", "--validation", "auto"]);
    expect(elsewhere.status).toBe(1);
    expect(elsewhere.stderr).toContain("next: --validation");
  });

  it("keeps the installs mode given by an option: nothing is asked, nothing replaces it", async () => {
    await run(["init", "--profile", "maintenance"]);
    const given = await run(["profile", "--installs", "validate"], ["", "", ""]);
    expect(given.status).toBe(0);
    expect(given.stdout).not.toContain("Installs mode [");
    expect(given.stdout).not.toContain("Validation level [");
    expect(await config()).toContain("installs:\n  mode: validate\n");
    const wrong = await run(["profile", "--installs", "always"]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("METHOD_CONFIG_INVALID");
  });

  it("speaks French", async () => {
    await run(["init", "--profile", "prototype"]);
    const { stdout } = await run(["profile"], ["", "o", "", "", "", "", "", "", "", ""], "fr");
    expect(stdout).toContain("Profil du produit\n");
    expect(stdout).toContain("Niveau de validation [1] : ");
    expect(stdout).toContain(
      "Ajuster les domaines, phases et spécialités des développeurs ? (o/N) ",
    );
    expect(stdout).toContain("Spécialités actives");
    expect(stdout).toContain("Domaines actifs");
    expect(stdout).toContain("Points qui t'attendent : ");
  });
});

describe("profile: pinned engine version", () => {
  it("stops before any question when method.yaml pins another engine", async () => {
    expect((await run(["init", "--profile", "new-product"])).status).toBe(0);
    const pinned = (await config()).replace("1.0.0", "0.0.9");
    await writeFile(join(cwd, ".agentplugged/method.yaml"), pinned);
    const { status, stdout, stderr } = await run(["profile"], ["2", "", "", "", ""]);
    expect(status).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Error ENGINE_VERSION_MISMATCH:");
    expect(stderr).toContain("`npx agentplugged@0.0.9 profile`");
    expect(await config()).toBe(pinned);
  });
});
