import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  BRAND_PATH,
  checkDocumentsDetailed,
  IDENTITY_PAGE_PATH,
  IDENTITY_PATH,
  mockupFaults,
} from "@agentplugged/core";
import { sha256Hex } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";

/** The skill that writes the brand: its templates pass the engine's own rules, and it stays short. */

const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");
const annex = (path: string) => read(`skills/write-brand/${path}`);
const flat = (text: string) => text.replace(/\s+/g, " ");

function check(files: Record<string, string>, page?: string) {
  const positioning = "---\nid: positioning\nkind: note\nowner: julien\nlinks: []\n---\n";
  return checkDocumentsDetailed({
    current: Object.entries({
      ".agentplugged/docs/launch/positioning.md": positioning,
      ...files,
    }).map(([path, text]) => ({ path, text })),
    owners: new Set(["julien", "stella"]),
    ...(page === undefined ? {} : { brandFiles: new Map([[IDENTITY_PAGE_PATH, page]]) }),
  });
}

describe("the templates of the brand", () => {
  const files = {
    [BRAND_PATH]: annex("assets/brand-template.md"),
    [IDENTITY_PATH]: annex("assets/identity-template.md"),
  };

  it("leaves nothing to fix but the placeholders and the samples the creator replaces", () => {
    const result = check(files, annex("assets/identity-page.html"));
    const other = result.problems.filter(
      (problem) =>
        problem.code === ErrorCode.LAUNCH_DOCUMENT_INVALID &&
        [BRAND_PATH, IDENTITY_PATH].includes(String(problem.details.path)) &&
        problem.details.reason !== "brand_section" &&
        problem.details.reason !== "brand_voice",
    );
    expect(other.map((problem) => JSON.stringify(problem.details))).toEqual([]);
    expect(result.problems.some((problem) => problem.code === ErrorCode.DOC_PLACEHOLDER_LEFT)).toBe(
      true,
    );
    // The sections the engine reads are all there: only the key screens, left as « <screen name> », and
    // the platform's placeholders are reported.
    expect(result.warnings.map((warning) => warning.reason)).toContain("brand_rule_unverifiable");
  });

  it("ships a page that is self-contained and keeps the rules of its own template", () => {
    const page = annex("assets/identity-page.html");
    expect(mockupFaults(page)).toEqual([]);
    expect(page).not.toMatch(/<script|https?:\/\/|url\(|@import|<link/i);
    expect(Buffer.byteLength(page)).toBeLessThanOrEqual(60_000);
    const result = check(files, page);
    expect(result.problems.filter((problem) => problem.details.reason === "brand_rule")).toEqual(
      [],
    );
  });

  it("applies the rules of the template to a page that breaks them, and names the rule", () => {
    const page = annex("assets/identity-page.html").replace(
      ".card.dark {",
      ".card.dark { background-image: linear-gradient(#000, #fff); border-radius: 5px;",
    );
    const found = check(files, page)
      .problems.filter((problem) => problem.details.reason === "brand_rule")
      .map((problem) => problem.details.rule);
    expect(found).toEqual(expect.arrayContaining(["flat", "radius-scale", "palette-closed"]));
  });
});

describe("the skill", () => {
  it("is short, and sends to its references", () => {
    const skill = read("skills/write-brand/SKILL.md");
    expect(skill.length).toBeLessThanOrEqual(3_500);
    for (const part of [
      "references/platform.md",
      "references/identity.md",
      "references/rules.md",
      "`docs check`",
      "never generated as an image",
      "`manual`",
    ]) {
      expect(flat(skill), part).toContain(part);
    }
    for (const reference of ["platform", "identity", "rules"]) {
      expect(annex(`references/${reference}.md`).length).toBeLessThanOrEqual(4_500);
    }
  });

  it("is reached from Julien for the platform and from Stella for the identity", () => {
    const menu = (agent: string, code: string) =>
      new RegExp(`- code: ${code}\n    description: .*\n    skill: ([a-z-]+)`).exec(
        read(`agents/${agent}/agent.yaml`),
      )?.[1];
    expect(menu("julien", "BR")).toBe("write-brand");
    expect(menu("stella", "BI")).toBe("write-brand");
  });

  it("tells the other skills to take the tokens and the voice from the brand", () => {
    expect(read("skills/write-ux-spec/references/tokens-and-sketches.md")).toContain(
      "`launch/identity.md`",
    );
    expect(read("skills/pitch/references/deck.md")).toContain("`launch/brand.md`");
    expect(read("skills/write-content/references/content-checklist.md")).toContain(
      "`.agentplugged/docs/launch/brand.md`",
    );
  });

  it("never names a method of a rival, and copies no look from another brand", () => {
    const text = [
      "SKILL.md",
      "references/platform.md",
      "references/identity.md",
      "references/rules.md",
      "assets/brand-template.md",
      "assets/identity-template.md",
      "assets/identity-page.html",
    ]
      .map((path) => annex(path))
      .join("\n");
    // Only the hashes of the forbidden names are kept, so this file never holds the names themselves.
    const forbidden = new Set([
      "4cb520700a736a67470725d981250d597924510cecb87fd19da7e98ec878c7f2",
      "2742fb61a239b215bb23ca533d211faa359455dc7f8e9cc65e079c02f2c76393",
    ]);
    const found = text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => forbidden.has(sha256Hex(word)));
    expect(found).toEqual([]);
  });
});
