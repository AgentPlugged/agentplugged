import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { checkDocuments, parseDocumentFile } from "../index.js";
import { buildRegistry } from "../requirements/requirement-rules.js";
import { sampleBreakdown, specText } from "../testing/spec-sample.js";
import { countSpec, GROWN_PATHS, growSpec, SPEC_PATH } from "./spec-grow.js";

const OWNERS = new Set(["maya", "izzy", "sam", "quentin", "iris", "alex"]);
const check = (record: Record<string, string>) =>
  checkDocuments({
    current: Object.entries(record).map(([path, text]) => ({ path, text })),
    owners: OWNERS,
    approvals: [],
    onBranch: new Set(),
  });
const codes = (record: Record<string, string>) => check(record).map((problem) => problem.code);

describe("the spec is one document the checks read", () => {
  it("accepts a spec whose stories cover every requirement", () => {
    expect(check({ [SPEC_PATH]: specText(), ...sampleBreakdown() })).toEqual([]);
  });

  it("asks for the requirements of the spec to be covered by stories, as it does for a PRD", () => {
    const { ".agentplugged/stories/1-2.md": _, ...onlyOne } = sampleBreakdown();
    const problems = check({ [SPEC_PATH]: specText(), ...onlyOne });
    expect(problems.map((problem) => [problem.code, problem.details.id])).toEqual([
      [ErrorCode.REQ_NOT_COVERED, "EF-2"],
      [ErrorCode.REQ_NOT_COVERED, "ENF-2"],
    ]);
  });

  it("asks every decision of the spec for its three fields, as for an architecture", () => {
    const text = specText().replace(
      "- **Prevents:** deux sources de vérité pour les factures.\n",
      "",
    );
    const problems = check({ [SPEC_PATH]: text, ...sampleBreakdown() });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: ErrorCode.AD_FIELDS_MISSING,
      details: { id: "AD-1", missing: ["Prevents"] },
    });
  });

  it("holds the identifiers once for the whole product: a PRD cannot define them again", () => {
    const prd = "---\nid: prd\nkind: prd\nowner: maya\n---\n# PRD\n\n- EF-1 : Autre chose.\n";
    expect(codes({ [SPEC_PATH]: specText(), ".agentplugged/docs/prd.md": prd })).toContain(
      ErrorCode.REQ_ID_DUPLICATE,
    );
  });
});

describe("the scope of a spec, and the risk", () => {
  it("refuses a product with something sensitive that the creator did not ask the short path for", () => {
    const problems = check({
      [SPEC_PATH]: specText({ sensitive: "[payment]" }),
      ...sampleBreakdown(),
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({
      code: ErrorCode.SPEC_SCOPE,
      message_key: "error.spec_scope",
      details: { path: SPEC_PATH, reason: "risk_not_asked", why: "payment" },
    });
  });

  it("accepts it once the header says the creator asked for the short path", () => {
    expect(
      check({
        [SPEC_PATH]: specText({ sensitive: "[accounts, payment]", asked: "short" }),
        ...sampleBreakdown(),
      }),
    ).toEqual([]);
  });

  it("still refuses it when the header says the creator asked for the full path", () => {
    const problems = check({
      [SPEC_PATH]: specText({ sensitive: "[accounts]", asked: "full" }),
      ...sampleBreakdown(),
    });
    expect(problems.map((problem) => problem.details.reason)).toEqual(["risk_not_asked"]);
  });

  it("refuses a scope that cannot be read, naming the criterion", () => {
    const problems = check({
      [SPEC_PATH]: specText({ size: "huge" }),
      ...sampleBreakdown(),
    });
    expect(problems[0]).toMatchObject({
      code: ErrorCode.SPEC_SCOPE,
      details: { reason: "scope", why: "size" },
    });
  });

  it("does not fail a spec that merely outgrew the short path: next says it", () => {
    const grown = specText({ size: "large", users: 5000 });
    expect(check({ [SPEC_PATH]: grown, ...sampleBreakdown() })).toEqual([]);
  });
});

describe("the register of the requirements reads the spec", () => {
  const read = (record: Record<string, string>) => {
    const files = Object.entries(record).map(([path, text]) => ({ path, text }));
    return buildRegistry(
      files.map((file) => parseDocumentFile(file.path, file.text)),
      files,
    );
  };

  it("registers the non-functional requirements and the numbered budgets of its decisions", () => {
    const text = specText().replace(
      "- **Prevents:** deux sources de vérité pour les factures.",
      "- **Prevents:** deux sources de vérité pour les factures.\n- **Budget:** une lecture prend moins de 50 ms.",
    );
    const entries = read({ [SPEC_PATH]: text, ...sampleBreakdown() });
    expect(entries.map((entry) => entry.id)).toEqual(["AD-1", "ENF-1", "ENF-2"]);
    expect(entries.find((entry) => entry.id === "ENF-1")).toMatchObject({
      proof: "measure",
      stories: ["1-1"],
    });
    expect(entries.find((entry) => entry.id === "ENF-2")).toMatchObject({
      pillar: "security",
      stories: ["1-2"],
    });
  });

  it("is the same register once the spec was carried over to the full path", () => {
    const before = read({ [SPEC_PATH]: specText(), ...sampleBreakdown() });
    const grown = growSpec(specText());
    if (!grown.ok) throw new Error("growSpec failed");
    const after = read({
      [GROWN_PATHS.brief]: grown.documents.brief,
      [GROWN_PATHS.prd]: grown.documents.prd,
      [GROWN_PATHS.architecture]: grown.documents.architecture,
      ...sampleBreakdown(),
    });
    expect(after).toEqual(before);
  });
});

describe("carrying the spec over to the full path", () => {
  const grown = () => {
    const result = growSpec(specText());
    if (!result.ok) throw new Error("growSpec failed");
    return result.documents;
  };
  const idsOf = (path: string, text: string) =>
    parseDocumentFile(path, text).definitions.map((definition) => definition.id);

  it("writes the brief, the PRD and the architecture, valid for `docs check`", () => {
    const documents = grown();
    const record = {
      [GROWN_PATHS.brief]: documents.brief,
      [GROWN_PATHS.prd]: documents.prd,
      [GROWN_PATHS.architecture]: documents.architecture,
      ...sampleBreakdown(),
    };
    expect(check(record)).toEqual([]);
    for (const [kind, path] of Object.entries(GROWN_PATHS)) {
      const parsed = parseDocumentFile(path, record[path] as string);
      expect(parsed.kind?.value, path).toBe(kind);
      expect(parsed.issues, path).toEqual([]);
    }
  });

  it("keeps every identifier, in the document that owns its kind", () => {
    const documents = grown();
    expect(idsOf(GROWN_PATHS.prd, documents.prd)).toEqual(["EF-1", "EF-2", "ENF-1", "ENF-2"]);
    expect(idsOf(GROWN_PATHS.architecture, documents.architecture)).toEqual(["AD-1"]);
    expect(idsOf(GROWN_PATHS.brief, documents.brief)).toEqual([]);
  });

  it("moves the creator's text word for word, and drops nothing", () => {
    const documents = grown();
    const all = Object.values(documents).join("\n");
    const body = specText()
      .split("\n")
      .filter((line) => line !== "" && !/^<!-- part:/.test(line));
    // Every line of the spec's body, header apart, is in one of the new documents, as it was.
    const start = body.indexOf("# Range-factures");
    for (const line of body.slice(start)) expect(all, line).toContain(line);
    // The list of stories is not lost: it goes to the brief.
    expect(documents.brief).toContain("- 1-1 : Importer un dossier (EF-1, ENF-1)");
  });

  it("gives the architecture the dependencies and prerequisites the spec's header declared", () => {
    const text = specText().replace(
      "platforms: 1\n---",
      "platforms: 1\ndependencies:\n  npm: [sqlite]\nprerequisites:\n  ports: [5432]\n---",
    );
    const result = growSpec(text);
    if (!result.ok) throw new Error("growSpec failed");
    const parsed = parseDocumentFile(GROWN_PATHS.architecture, result.documents.architecture);
    expect(parsed.issues).toEqual([]);
    expect(result.documents.architecture).toContain("npm:\n    - sqlite");
    expect(result.documents.architecture).toContain("ports:\n    - 5432");
    // The scope stays out of the other documents: it described the spec, not the architecture.
    expect(result.documents.prd).not.toContain("size:");
  });

  it("keeps the other header keys of the spec on the brief", () => {
    const text = specText().replace("platforms: 1\n---", "platforms: 1\nimportant: true\n---");
    const result = growSpec(text);
    if (!result.ok) throw new Error("growSpec failed");
    expect(result.documents.brief).toContain("important: true");
    expect(result.documents.prd).not.toContain("important");
    expect(result.documents.architecture).not.toContain("important");
  });

  it("refuses a spec with no header or no parts, writing nothing", () => {
    expect(growSpec("# A spec without a header\n")).toEqual({ ok: false, reason: "header" });
    expect(growSpec("---\nid: spec\nkind: spec\nowner: maya\n---\n# Sans parties\n")).toEqual({
      ok: false,
      reason: "parts",
    });
  });
});

describe("what a spec holds, counted", () => {
  it("counts the active functional requirements and the stories listed", () => {
    const text = specText({}, [
      "- EF-3 : (retirée) Une exigence abandonnée.",
      "- EF-4 : Le gérant filtre la liste.",
    ]);
    const counts = countSpec(parseDocumentFile(SPEC_PATH, text), text);
    expect(counts).toEqual({ requirements: 3, stories: 2 });
  });
});
