import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FORMER_AGENT_IDS, FORMER_AGENT_NAMES } from "@agentplugged/core";
import { describe, expect, it } from "vitest";

/**
 * The team was renamed on 2026-10-03: no former name of an agent stays in the
 * method, the code, the catalogs of translations nor the tests. Only the alias table of `core`
 * and the format step that renames, with their tests, name the former agents. The former names
 * are read from the alias table, so that this file names none of them either.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Where the product lives: the method, then every package and app. */
const SCANNED = ["method", "packages", "apps"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", ".turbo", "results", "coverage"]);
const TEXT = /\.(ts|tsx|js|mjs|json|md|yaml|yml|tmpl|toml|txt)$/;

/** The alias table, the format step and their tests: the only files allowed to name them. */
const ALLOWED = new Set([
  "packages/core/src/agents/agent-aliases.ts",
  "packages/core/src/agents/agent-aliases.test.ts",
  "packages/core/src/migrate/rename-agents.ts",
  "packages/core/src/migrate/rename-agents.test.ts",
  // This check: its rule of the scrum master names the former id next to the role.
  "apps/cli/src/former-names.test.ts",
  // The name of a style of the shadcn component kit (`radix-nova`), not an agent.
  "apps/web/components.json",
]);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...filesUnder(join(dir, entry.name)));
    } else if (entry.isFile() && TEXT.test(entry.name)) {
      found.push(join(dir, entry.name));
    }
  }
  return found;
}

/** Every former name but `sam`, which names a backend developer since the renaming. */
const words = [
  ...new Set([...FORMER_AGENT_IDS, ...FORMER_AGENT_NAMES.map((name) => name.toLowerCase())]),
].filter((word) => word !== "sam");
const former = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${words.join("|")})(?![\\p{L}\\p{N}_])`, "iu");
/** The scrum master's former id: today a developer, never next to the scrum master any more. */
const scrumMaster =
  /(?<![\p{L}\p{N}_])sam(?![\p{L}\p{N}_]).*scrum|scrum.*(?<![\p{L}\p{N}_])sam(?![\p{L}\p{N}_])/iu;

describe("the former names of the agents", () => {
  it("reads the former team from the alias table", () => {
    expect(FORMER_AGENT_IDS.length).toBeGreaterThan(10);
  });

  it("never appear in the method, the code, the catalogs nor the tests", () => {
    const offending: string[] = [];
    for (const file of SCANNED.flatMap((dir) => filesUnder(join(repoRoot, dir)))) {
      const path = relative(repoRoot, file).replaceAll("\\", "/");
      if (ALLOWED.has(path)) continue;
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const found = line.match(former)?.[0] ?? (scrumMaster.test(line) ? "sam" : undefined);
          if (found !== undefined) offending.push(`${path}:${index + 1} ${found}`);
        });
    }
    expect(offending).toEqual([]);
  });
});
