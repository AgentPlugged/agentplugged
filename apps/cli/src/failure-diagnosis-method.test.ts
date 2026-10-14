import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { renderConstitutionReference } from "@agentplugged/core";
import { describe, expect, it } from "vitest";
import { noahCorpus } from "./__helpers__/noah-text.js";

/** The shipped method: the `@agentplugged/method` package of the monorepo. */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);

describe("agents explain a failed command from the engine's diagnosis", () => {
  const readers = ["noah", "sam", "ethan", "hugo", "jade", "lina"];

  it.each(readers)("%s reads state.environment with the failure and never guesses", (agent) => {
    // Noah's detail is in his references.
    const source =
      agent === "noah"
        ? noahCorpus(methodDir)
        : readFileSync(join(methodDir, "agents", agent, "SKILL.md"), "utf8");
    const text = source.replace(/\s+/g, " ");
    expect(text).toContain("state.environment");
    expect(text).toContain("failure");
    expect(text).toMatch(/supposition|assumed/);
    expect(text).toMatch(/do(?:es)? not know|says (?:he|she) does not know/);
  });

  it("the constitution every agent follows says the same", () => {
    const text = renderConstitutionReference().replace(/\s+/g, " ");
    expect(text).toContain("as `failure`");
    expect(text).toContain("you do not know the cause");
  });
});
