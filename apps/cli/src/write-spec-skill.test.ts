import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import {
  type Definition,
  growSpec,
  NEXT_STEPS,
  parseDocumentFile,
  readDefinitions,
  readScope,
} from "@agentplugged/core";
import { JOURNEY_STEPS } from "@agentplugged/protocol";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The skill of the short path: Maya writes the one spec from a template whose markers
 * and header the engine reads, and Noah proposes the path in the words the engine speaks.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const TEMPLATE = read("skills/write-spec/assets/spec-template.md");
const flat = (text: string) => text.replace(/\s+/g, " ");

let skills: Map<string, Definition>;
let agents: Map<string, Definition>;

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const found = async (dir: string, kind: "agent" | "skill") => {
    const list = await readDefinitions(source, dir, kind);
    if (!Array.isArray(list)) throw new Error("invalid method");
    return new Map(list.map((definition) => [definition.name, definition] as const));
  };
  skills = await found("skills", "skill");
  agents = await found("agents", "agent");
});

describe("the template of the spec", () => {
  it("has a header the engine reads: a spec of Maya's, with a scope that is readable", () => {
    const parsed = parseDocumentFile(".agentplugged/docs/spec.md", TEMPLATE);
    expect(parsed.issues).toEqual([]);
    expect(parsed.kind?.value).toBe("spec");
    expect(parsed.owner?.value).toBe("maya");
    expect(readScope(parsed.header as Record<string, unknown>)).toMatchObject({ ok: true });
  });

  it("marks its four parts where the engine carries them over, so a product that grows loses nothing", () => {
    const markers = [...TEMPLATE.matchAll(/^<!-- part: (\w+) -->$/gm)].map((match) => match[1]);
    expect(markers).toEqual(["brief", "requirements", "decisions", "stories"]);
    const grown = growSpec(TEMPLATE);
    expect(grown.ok).toBe(true);
    if (!grown.ok) return;
    expect(grown.documents.prd).toContain("- EF-1 :");
    expect(grown.documents.architecture).toContain("### AD-1");
    expect(grown.documents.brief).toContain("- 1-1 :");
  });

  it("shows the three fields of a decision and the two kinds of requirement the registry reads", () => {
    for (const text of ["**Binds:**", "**Prevents:**", "**Rule:**", "- EF-1 :", "- ENF-1 :"]) {
      expect(TEMPLATE, text).toContain(text);
    }
  });
});

describe("the skill and its place in the team", () => {
  it("is Maya's, short, and sends the detail to files read when needed", () => {
    const skill = skills.get("write-spec") as Definition;
    expect(skill).toBeDefined();
    expect(skill.text.length).toBeLessThanOrEqual(2_000);
    for (const file of ["references/spec-guide.md", "assets/spec-template.md"]) {
      expect(skill.annexes).toContain(file);
    }
    const menu = (agents.get("maya") as Definition).agent?.menu ?? [];
    expect(menu.some((item) => item.skill === "write-spec")).toBe(true);
  });

  it("opens the spec's point of validation like any document, and asks the creator once", () => {
    const text = flat((skills.get("write-spec") as Definition).text);
    expect(text).toContain("`checkpoint.open` (`type: document`");
    expect(text).toContain("`npx agentplugged docs check`");
    expect(text).toContain("`step: spec`");
    expect(text).toContain("`full_path`");
  });

  it("names the engine's step, the journey step and the words Noah speaks", () => {
    expect(NEXT_STEPS).toContain("spec");
    expect(JOURNEY_STEPS).toContain("full_path");
    const team = flat(read("agents/noah/references/team.md"));
    for (const word of [
      "spec_path: choose",
      "spec_path: grow",
      "spec_path: carry",
      "npx agentplugged docs path",
      "npx agentplugged docs grow",
      "`step_skip` `full_path`",
      "`step_resume` `full_path`",
      "asked=short",
    ]) {
      expect(team, word).toContain(word);
    }
    // The risk rule is told to Noah as the engine applies it.
    expect(team).toContain("`risky: true` is the full path");
  });

  it("is the source of the stories on the short path", () => {
    const split = flat((skills.get("split-into-stories") as Definition).text);
    expect(split).toContain("`full_path`");
    expect(split).toContain("`spec.md`");
  });
});

describe("the security review of the short path", () => {
  const review = () => flat((skills.get("security-review-architecture") as Definition).text);
  const detail = () => flat(read("skills/security-review-architecture/references/spec-review.md"));

  it("extends the skill of the architecture instead of copying it, the detail being read when needed", () => {
    expect(review()).toContain("references/spec-review.md");
    expect(review()).toContain("`full_path`");
    expect(skills.has("security-review-spec")).toBe(false);
    expect(detail()).toContain("step: security_review");
  });

  it("keeps the result line of the architecture, with the spec as the document reviewed", () => {
    const text = detail();
    expect(text).toContain("architecture=<blob>");
    expect(text).toContain("git rev-parse HEAD:.agentplugged/docs/spec.md");
    expect(text).toContain("security-reviews/spec.md");
  });

  it("sizes the pass and never skips it, and puts blocking findings to the creator", () => {
    const text = detail();
    expect(text).toContain("Short pass");
    expect(text).toContain("never a skipped one");
    expect(text).toContain("`decision` checkpoint");
    expect(text).toContain("`fix`");
    expect(text).toContain("`accept`");
    expect(text).toContain("`step_resume` `full_path`");
    expect(flat(read("agents/noah/references/team.md"))).toContain("spec_path: risk");
  });
});
