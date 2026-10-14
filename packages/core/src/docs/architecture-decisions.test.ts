import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { checkDocuments } from "../index.js";

const PATH = ".agentplugged/docs/architecture.md";
const HEADER = "id: architecture\nkind: architecture\nowner: alex\n";

function check(body: readonly string[], header = HEADER) {
  return checkDocuments({
    current: [{ path: PATH, text: `---\n${header}---\n# Architecture\n\n${body.join("\n")}\n` }],
    owners: new Set(["alex"]),
  });
}

const FULL = [
  "### AD-1 — One writer per piece of data",
  "",
  "- **Binds:** all",
  "- **Prevents:** two modules updating the same order.",
  "- **Rule:** only the orders module writes orders.",
];

describe("the fields of an architecture decision", () => {
  it("accepts a decision with its three fields, in English or in French", () => {
    expect(check(FULL)).toEqual([]);
    expect(
      check([
        "### AD-1 — Un seul écrivain par donnée",
        "",
        "- **Lie :** all",
        "- Empêche : deux modules qui modifient la même commande.",
        "- **Règle** : seul le module des commandes les écrit.",
      ]),
    ).toEqual([]);
  });

  it("names the decision and the fields it lacks", () => {
    const problems = check([...FULL, "", "### AD-2 — Dates in UTC", "", "- **Binds:** all"]);
    expect(problems).toEqual([
      {
        code: ErrorCode.AD_FIELDS_MISSING,
        message_key: "error.ad_fields_missing",
        details: { path: PATH, line: 14, id: "AD-2", missing: ["Prevents", "Rule"] },
      },
    ]);
  });

  it("reads a decision's block only, never a field inside code nor in the next decision", () => {
    const problems = check([
      "### AD-1 — Errors",
      "",
      "```markdown",
      "- **Binds:** all",
      "- **Prevents:** x",
      "- **Rule:** y",
      "```",
      "### AD-2 — Logs",
      "- **Binds:** all",
      "- **Prevents:** secrets in logs.",
      "- **Rule:** never log a token.",
    ]);
    expect(problems.map((problem) => problem.details.id)).toEqual(["AD-1"]);
    // A sub-heading stays in the decision's block; a heading of the same level ends it.
    expect(
      check([
        "### AD-1 — Errors",
        "#### Detail",
        "- **Binds:** all",
        "- **Prevents:** two error shapes.",
        "- **Rule:** one envelope.",
      ]),
    ).toEqual([]);
  });

  it("reads French spacing: no-break spaces before the colon and after the heading's hashes", () => {
    expect(
      check([
        "### AD-1 — Un seul écrivain",
        "- **Lie :** all",
        "- **Empêche** : deux écrivains.",
        "- Règle : le module des commandes écrit seul.",
      ]),
    ).toEqual([]);
  });

  it("ignores fields in code: fenced in a quote, or indented", () => {
    const ids = (body: string[]) => check(body).map((problem) => problem.details.id);
    expect(
      ids([
        "> ### AD-1 — Errors",
        "> ```",
        "> - **Binds:** all",
        "> - **Prevents:** x",
        "> - **Rule:** y",
        "> ```",
      ]),
    ).toEqual(["AD-1"]);
    expect(
      ids([
        "### AD-1 — Errors",
        "",
        "    - **Binds:** all",
        "    - **Prevents:** x",
        "    - **Rule:** y",
      ]),
    ).toEqual(["AD-1"]);
    // Indented under a list item, the lines are its continuation, not code.
    expect(
      ids([
        "### AD-1 — Errors",
        "- **Binds:** all",
        "",
        "    more about what it binds",
        "- **Prevents:** two error shapes.",
        "- **Rule:** one envelope.",
      ]),
    ).toEqual([]);
  });

  it("ends a decision at a setext heading", () => {
    const problems = check([
      "## AD-1 — Errors",
      "- **Binds:** all",
      "",
      "Next part",
      "=========",
      "- **Prevents:** two error shapes.",
      "- **Rule:** one envelope.",
    ]);
    expect(problems.map((problem) => problem.details.missing)).toEqual([["Prevents", "Rule"]]);
  });

  it("reads a realistic table of decisions, by its column headers", () => {
    expect(
      check([
        "| Id | Decision | Binds | Prevents | Rule |",
        "| --- | --- | --- | --- | --- |",
        "| AD-1 | One writer per entity | all | two writers of an order | only `orders` writes orders |",
        "| **AD-2** | UTC everywhere | EF-3 | mixed time zones | store and send UTC |",
        "AD-3 | Errors | all | two error shapes | one envelope",
      ]),
    ).toEqual([]);
    const french = check([
      "| Id | Lie | Empêche | Règle |",
      "|:--|:--|:--|:--|",
      "| AD-1 | all |  | one envelope |",
    ]);
    expect(french.map((problem) => problem.details.missing)).toEqual([["Prevents"]]);
  });

  it("wants a field at the start of a cell, never in free text", () => {
    const problems = check([
      "| AD-1 | Errors | binds all, prevents drift; the general rule: one envelope |",
    ]);
    expect(problems.map((problem) => problem.details.missing)).toEqual([
      ["Binds", "Prevents", "Rule"],
    ]);
    expect(check(["AD-1 | Binds: all | **Prevents:** drift | Rule : one envelope"])).toEqual([]);
  });

  it("asks nothing of a retired decision, of a table row that holds its fields, or of a note", () => {
    expect(check(["### AD-1 — (retired) Errors", "", "No longer in force."])).toEqual([]);
    expect(
      check(["| AD-1 | Binds: all | Prevents: drift | Rule: one envelope |", "| --- | --- |"]),
    ).toEqual([]);
    expect(check(["| AD-1 | Errors | one envelope |"]).map((p) => p.code)).toEqual([
      ErrorCode.AD_FIELDS_MISSING,
    ]);
    expect(check(["### AD-1 — Errors"], "id: notes\nkind: note\nowner: alex\n")).toEqual([]);
  });
});
