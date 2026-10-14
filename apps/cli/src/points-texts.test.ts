import { createRequire } from "node:module";
import { dirname } from "node:path";
import { DEFAULT_RULES, renderConstitutionReference } from "@agentplugged/core";
import { en, fr } from "@agentplugged/i18n";
import { VALIDATION_POINTS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { noahCorpus } from "./__helpers__/noah-text.js";
import { SHARED_RULES_POINTER, sharedRules } from "./__helpers__/shared-rules.js";

/**
 * The texts of the method tell the same
 * story. The creator chooses the points that wait for them; the agent responsible decides the others
 * with its reason; the agents go on without the creator and stop where nothing independent is left;
 * the morning brings one summary and one stack.
 */

const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);

// Vite glob: every text of the method, read as is.
// @ts-expect-error `import.meta.glob` is Vite's: the types of this package do not load it.
const METHOD_FILES: Record<string, string> = import.meta.glob("../../../method/**/*.{md,yaml}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const file = (suffix: string): string => {
  // Noah's detail lives in his references: his definition is all of it.
  if (suffix === "agents/noah/SKILL.md" || suffix === "agents/noah/agent.yaml") {
    return noahCorpus(methodDir);
  }
  const found = Object.entries(METHOD_FILES).find(([path]) => path.endsWith(suffix));
  if (found === undefined) throw new Error(`no ${suffix}`);
  return found[1];
};

/** The text on one line: whitespace folded, so a sentence cut over two lines still matches. */
const flat = (text: string) => text.replace(/\s+/g, " ");

const constitution = flat(
  renderConstitutionReference([], DEFAULT_RULES, { tools: ["claude-code", "codex", "cursor"] }),
);

describe("the constitution", () => {
  it("gives the points of validation their section", () => {
    expect(constitution).toContain("## Points of validation");
    for (const point of VALIDATION_POINTS) expect(constitution, point).toContain(`\`${point}\``);
    for (const word of [
      "`validation.points`",
      "`checkpoint.decide`",
      "`point_decision`",
      "`decision: escalate`",
      "`independent: true`",
      "`stop: true`",
      "`morning`",
      "`pile.stack`",
    ]) {
      expect(constitution, word).toContain(word);
    }
  });

  it("says what an agent never decides, and that the journal shows who decided", () => {
    expect(constitution).toContain("Never decided by an agent, whatever the creator chose");
    expect(constitution).toContain("never present such a decision as the creator's own answer");
    expect(constitution).toContain("a merge already done is undone by a `git revert`");
  });

  it("puts the merges, releases and publications in the stack, each naming its action", () => {
    expect(constitution).toContain("A merge, a release and a publication enter the stack");
    expect(constitution).toContain("`merge_failed`");
    expect(constitution).not.toMatch(/a merge \(a merge, reversible, is answered on its own/);
  });
});

describe("Noah and the skills", () => {
  it("makes Noah propose the points, respect them and open with the morning", () => {
    const noah = flat(file("agents/noah/SKILL.md"));
    for (const word of [
      "validation.points",
      "point_decision",
      "`stop: true`",
      "`morning`",
      "`pile`",
    ]) {
      expect(noah, word).toContain(word);
    }
    expect(noah).toContain("(`checkpoint.decide` is not in his contract)");
    const facts = flat(file("agents/noah/agent.yaml"));
    expect(facts).toContain("`validation.points`");
    expect(facts).toContain("Noah never does");
  });

  it("tells every agent and skill that asks the creator which points are theirs", () => {
    // The rule is written once in the reference; each skill points to it.
    expect(sharedRules()).toContain("Which points wait for the creator is their choice");
    const withAsk = Object.entries(METHOD_FILES).filter(
      ([path, text]) =>
        /skills\/[^/]+\/SKILL\.md$/.test(path) && text.includes(SHARED_RULES_POINTER),
    );
    expect(withAsk.length).toBeGreaterThan(10);
    for (const [path, text] of withAsk) {
      expect(flat(text), path).toContain(
        "a point the creator did not keep goes to `checkpoint.decide`",
      );
    }
  });
});

describe("the catalogs", () => {
  it("name the six points, the questions and the sources in both languages", () => {
    for (const catalog of [fr, en] as Array<Record<string, string>>) {
      for (const point of VALIDATION_POINTS) {
        expect(catalog[`points.point.${point}`], point).toBeTruthy();
      }
      for (const key of [
        "points.title",
        "points.prompt",
        "points.summary",
        "points.summary.none",
        "history.source.agent",
        "assurance.agent",
        "review.agent_decided",
        "next.step.point_decision",
        "next.independent",
        "next.stop",
        "next.morning",
      ]) {
        expect(catalog[key], key).toBeTruthy();
      }
    }
  });
});
