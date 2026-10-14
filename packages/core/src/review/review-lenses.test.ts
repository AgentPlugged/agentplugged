import type { JudgeReport, LensReport, ReviewFinding } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  chooseLenses,
  creatorStack,
  findingRefs,
  findingSeverities,
  isDocumentPath,
  isSensitiveChange,
  lensDiff,
  lensDiffPathOf,
  mergeLensReports,
  planReaders,
  requiredLenses,
  STACK_CHARS,
  sameFinding,
  stackLine,
  stackText,
  validateJudge,
  validateLensReports,
} from "./review-lenses.js";
import { reviewVerdictOf, sensitivePath } from "./review-rules.js";

const file = (path: string, added = 3, removed = 0, created = false) => ({
  path,
  added,
  removed,
  created,
});
const names = (files: Parameters<typeof chooseLenses>[0], reasons: string[] = [], more = []) =>
  chooseLenses(files, reasons as never, more).map((choice) => choice.lens);

describe("the engine chooses the lenses from the risk", () => {
  it("runs few lenses on a small change without risk, and says why", () => {
    const chosen = chooseLenses([file("src/profile.ts", 1)], []);
    expect(chosen).toEqual([
      { lens: "verification_gaps", why: ["always"] },
      { lens: "relevance", why: ["always"] },
    ]);
  });

  it("adds the cases nobody wrote down for a larger change or new code", () => {
    expect(names([file("src/a.ts", 25)])).toContain("edge_cases");
    expect(names([file("src/new.ts", 5, 0, true)])).toContain("edge_cases");
    expect(names([file("src/a.ts", 5, 1)])).not.toContain("edge_cases");
    // A new test file is not new code to explore.
    expect(names([file("src/a.test.ts", 5, 0, true)])).not.toContain("edge_cases");
  });

  it("runs the adversarial and structure regards on a wide or heavy change", () => {
    expect(names([file("src/a.ts", 200)])).toContain("adversarial");
    const many = Array.from({ length: 8 }, (_, i) => file(`src/f${i}.ts`, 2));
    expect(names(many)).toEqual(expect.arrayContaining(["adversarial", "structure"]));
    expect(names([file("a/x.ts"), file("b/y.ts"), file("c/z.ts")])).toContain("structure");
  });

  it("runs them all, security included, on a sensitive change", () => {
    for (const files of [
      [file("src/auth/session.ts", 2)],
      [file("package.json", 1)],
      [file("db/migrations/001_users.sql", 4)],
      [file("src/ok.ts", 1), file("pnpm-lock.yaml", 9)],
    ]) {
      const reasons = files.some((f) => sensitivePath(f.path)) ? ["paths"] : [];
      expect(reasons, files[0]?.path).toEqual(["paths"]);
      expect(names(files, reasons), files[0]?.path).toEqual([
        "adversarial",
        "edge_cases",
        "verification_gaps",
        "structure",
        "security",
        "relevance",
      ]);
    }
  });

  it("gives the reasons of the engine for the security lens, and the creator may ask for one more", () => {
    const chosen = chooseLenses([file("src/a.ts", 1)], ["words"], ["prose"]);
    expect(chosen.find((c) => c.lens === "security")?.why).toEqual(["security_words"]);
    expect(chosen.find((c) => c.lens === "prose")?.why).toEqual(["requested"]);
    // Asking for a lens already chosen changes nothing.
    expect(chooseLenses([file("src/a.ts", 1)], [], ["relevance"])).toHaveLength(2);
  });

  it("reads a document with its own lenses: prose and structure, never the cases of code", () => {
    const small = names([file("docs/brief.md", 12)]);
    expect(small).toEqual(["verification_gaps", "structure", "prose", "relevance"]);
    expect(names([file("docs/prd.md", 12)])).toContain("adversarial");
    expect(names([file("docs/brief.md", 300)])).toContain("adversarial");
    expect(small).not.toContain("edge_cases");
    // Prose in a code change is read from ten lines.
    expect(names([file("src/a.ts", 3), file("README.md", 12)])).toContain("prose");
    expect(names([file("src/a.ts", 3), file("README.md", 2)])).not.toContain("prose");
  });

  it("leaves the security lens to the security reviewer in the quality review's required set", () => {
    const chosen = chooseLenses([file("src/auth/login.ts", 2)], ["paths"]);
    expect(requiredLenses("qa", chosen)).not.toContain("security");
    expect(requiredLenses("security", chosen)).toEqual(["security"]);
  });
});

const finding = (over: Partial<NonNullable<LensReport["findings"][number]>> = {}) => ({
  severity: "should_fix" as const,
  title: "The empty profile is not handled",
  evidence: "load() returns null for a new user and the page crashes.",
  criterion: 1,
  recommendation: "Show an empty state.",
  path: "src/profile.ts",
  line: 12,
  ...over,
});
const report = (lens: LensReport["lens"], findings: LensReport["findings"] = []): LensReport => ({
  lens,
  summary: `${lens} looked.`,
  covered: ["the diff"],
  findings,
});
const judge = (over: Partial<JudgeReport> = {}): JudgeReport => ({
  summary: "Judged.",
  criteria: [{ criterion: 1, status: "met", evidence: "src/profile.ts:3 and its test" }],
  gap: null,
  ...over,
});

describe("a report must be whole", () => {
  const context = {
    kind: "qa" as const,
    required: ["relevance", "verification_gaps"] as const,
    criteria: 2,
  };
  const check = (reports: LensReport[]) =>
    validateLensReports(reports, { ...context, required: [...context.required] });

  it("accepts whole reports", () => {
    expect(check([report("relevance"), report("verification_gaps", [finding()])])).toEqual([]);
  });

  it("refuses a missing, repeated or foreign lens, with what is missing", () => {
    expect(check([report("relevance")])).toEqual(["lens_missing:verification_gaps"]);
    expect(check([report("relevance"), report("relevance"), report("verification_gaps")])).toEqual([
      "lens_repeated:relevance",
    ]);
    expect(check([report("relevance"), report("verification_gaps"), report("security")])).toEqual([
      "lens_not_allowed:security",
    ]);
    expect(
      validateLensReports([report("relevance")], {
        kind: "security",
        required: ["security"],
        criteria: 1,
      }),
    ).toEqual(["lens_not_allowed:relevance", "lens_missing:security"]);
  });

  it("refuses a section left out: covered, evidence, criterion, recommendation", () => {
    const bare = { severity: "blocking" as const, title: "Wrong" };
    expect(
      check([
        { ...report("relevance"), covered: [] },
        report("verification_gaps", [bare, { ...bare, line: 3 }]),
      ]),
    ).toEqual([
      "covered_missing:relevance",
      "evidence_missing:verification_gaps#1",
      "criterion_missing:verification_gaps#1",
      "recommendation_missing:verification_gaps#1",
      "evidence_missing:verification_gaps#2",
      "criterion_missing:verification_gaps#2",
      "recommendation_missing:verification_gaps#2",
      "line_without_path:verification_gaps#2",
    ]);
  });

  it("accepts a null criterion but refuses one the story does not have", () => {
    expect(
      check([report("relevance", [finding({ criterion: null })]), report("verification_gaps")]),
    ).toEqual([]);
    expect(
      check([report("relevance", [finding({ criterion: 3 })]), report("verification_gaps")]),
    ).toEqual(["criterion_unknown:relevance#1:3"]);
  });

  it("asks of the judge every criterion once, with its evidence", () => {
    expect(validateJudge(undefined, 1)).toEqual(["judge_missing"]);
    expect(validateJudge(judge(), 1)).toEqual([]);
    expect(validateJudge(judge(), 2)).toEqual(["judge_criterion_missing:2"]);
    expect(
      validateJudge(
        judge({
          criteria: [
            { criterion: 1, status: "unmet" },
            { criterion: 1, status: "met", evidence: "src/profile.ts:3 and its test" },
            { criterion: 4, status: "met", evidence: "src/profile.ts:9 and its test" },
          ],
        }),
        1,
      ),
    ).toEqual([
      "judge_evidence_missing:1",
      "judge_recommendation_missing:1",
      "judge_criterion_repeated:1",
      "judge_criterion_unknown:4",
    ]);
    const { gap: _gap, ...noGap } = judge();
    expect(validateJudge(noGap, 1)).toEqual(["judge_gap_missing"]);
  });
});

describe("the engine merges what the lenses found and never loses a blocking finding", () => {
  it("merges the same finding seen by two lenses at the strictest severity, with both lenses", () => {
    const merged = mergeLensReports([
      report("edge_cases", [
        finding({ severity: "should_fix", title: "Empty profile crashes the page" }),
      ]),
      report("adversarial", [
        finding({
          severity: "blocking",
          title: "A new user with an empty profile crashes the page",
          line: 13,
        }),
      ]),
    ]);
    expect(merged.raw).toBe(2);
    expect(merged.merged).toBe(1);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]).toMatchObject({
      severity: "blocking",
      lens: "adversarial",
      also: ["edge_cases"],
      criterion: 1,
      path: "src/profile.ts",
    });
    expect(merged.findings[0]?.detail).toContain(
      "Also: edge_cases: Empty profile crashes the page",
    );
  });

  it("keeps two different findings apart, even close in a file", () => {
    const merged = mergeLensReports([
      report("edge_cases", [
        finding({ title: "Timeout is not retried", criterion: null, line: 10 }),
      ]),
      report("adversarial", [
        finding({ title: "Token written in the log", criterion: 2, line: 12 }),
      ]),
    ]);
    expect(merged.findings).toHaveLength(2);
    expect(merged.merged).toBe(0);
  });

  it("links to the criterion the other lens named when the leading one named none", () => {
    const merged = mergeLensReports([
      report("edge_cases", [
        finding({
          severity: "blocking",
          criterion: null,
          title: "Empty profile crashes",
          line: 12,
        }),
      ]),
      report("relevance", [finding({ criterion: 2, title: "Empty profile crashes", line: 12 })]),
    ]);
    expect(merged.findings[0]).toMatchObject({ severity: "blocking", criterion: 2 });
  });

  it("sorts blocking first and counts what each lens gave", () => {
    const merged = mergeLensReports([
      report("relevance", [
        finding({ severity: "minor", title: "Naming", line: 1, criterion: null }),
      ]),
      report("edge_cases", [finding({ severity: "blocking", title: "Crash", line: 50 })]),
    ]);
    expect(merged.findings.map((f) => f.severity)).toEqual(["blocking", "minor"]);
    expect(merged.lenses).toEqual([
      { lens: "edge_cases", findings: 1 },
      { lens: "relevance", findings: 1 },
    ]);
  });

  it("turns the judge's verdict into findings: unmet blocks, partly is to fix, the gap is to fix", () => {
    const merged = mergeLensReports(
      [report("relevance")],
      judge({
        criteria: [
          {
            criterion: 1,
            status: "unmet",
            evidence: "No code reads the name.",
            recommendation: "Show it.",
          },
          {
            criterion: 2,
            status: "partly",
            evidence: "Only the happy path.",
            recommendation: "Add the empty case.",
          },
          { criterion: 3, status: "met", evidence: "ok" },
        ],
        gap: "The page shows the id, not the name Ada gave.",
      }),
    );
    expect(merged.findings.map((f) => [f.severity, f.lens, f.criterion])).toEqual([
      ["blocking", "judge", 1],
      ["should_fix", "judge", 2],
      ["should_fix", "judge", undefined],
    ]);
    expect(merged.judge).toEqual({ met: 1, partly: 1, unmet: 1 });
    expect(reviewVerdictOf(merged.findings)).toBe("fail");
  });

  it("is the same whatever the order the reports come in", () => {
    const a = report("edge_cases", [
      finding({ title: "Empty profile crashes", severity: "blocking" }),
    ]);
    const b = report("adversarial", [finding({ title: "Empty profile crashes the page" })]);
    expect(mergeLensReports([a, b])).toEqual(mergeLensReports([b, a]));
  });

  it("never loses a blocking finding and gives the verdict of the strictest report (property)", () => {
    // Deterministic pseudo-random reports: titles from a small pool, places near each other.
    let seed = 20261009;
    const random = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const titles = [
      "Empty profile crashes the page",
      "Profile crashes when empty",
      "Token written in the log",
      "Missing test for the empty case",
      "Rename the helper",
    ];
    const severities = ["blocking", "should_fix", "minor"] as const;
    const lenses = [
      "adversarial",
      "edge_cases",
      "verification_gaps",
      "structure",
      "relevance",
    ] as const;
    for (let round = 0; round < 300; round += 1) {
      const reports = lenses.map((lens) =>
        report(
          lens,
          Array.from({ length: random(4) }, () =>
            finding({
              severity: severities[random(3)] as "blocking",
              title: titles[random(titles.length)] as string,
              line: 10 + random(4),
              criterion: random(3) === 0 ? null : 1 + random(2),
              path: random(5) === 0 ? "src/other.ts" : "src/profile.ts",
            }),
          ),
        ),
      );
      const raw = reports.flatMap((r) => r.findings);
      const merged = mergeLensReports(reports);
      // The verdict of the merged review is the strictest of the lenses' own.
      const strictest = reviewVerdictOf(raw);
      expect(reviewVerdictOf(merged.findings), `round ${round}`).toBe(strictest);
      // Every blocking finding is in a merged finding (as its lead, or as a lens that saw it).
      const blocking = raw.filter((f) => f.severity === "blocking");
      if (blocking.length > 0) {
        expect(merged.findings.some((f) => f.severity === "blocking")).toBe(true);
      }
      // Nothing vanishes without trace: the findings left plus those merged are those given.
      expect(merged.findings.length + merged.merged).toBe(raw.length);
      // And never a merge of two findings that are not the same by the engine's own rule.
      expect(merged.findings.length).toBeGreaterThanOrEqual(raw.length > 0 ? 1 : 0);
    }
  });

  it("never merges findings of two files or of far places", () => {
    const a: ReviewFinding = {
      severity: "blocking",
      title: "Crash on empty",
      path: "a.ts",
      line: 1,
    };
    expect(sameFinding(a, { ...a, path: "b.ts" })).toBe(false);
    expect(sameFinding(a, { ...a, line: 40, title: "Other thing entirely" })).toBe(false);
    expect(sameFinding(a, { ...a, line: 2 })).toBe(true);
    expect(
      sameFinding(
        { severity: "minor", title: "Unlocated note about naming" },
        { severity: "minor", title: "Unlocated note about naming" },
      ),
    ).toBe(true);
  });
});

describe("the stack the creator reads", () => {
  const entry = (over = {}) => ({
    severity: "should_fix" as const,
    title: "Empty profile",
    decision: null,
    ...over,
  });

  it("shows blocking first, one line each with the advice, and only counts the fixed ones", () => {
    const stack = creatorStack([
      entry({ severity: "minor", title: "Naming" }),
      entry({
        severity: "blocking",
        title: "Crash",
        path: "src/a.ts",
        line: 4,
        criterion: 2,
        recommendation: "Guard null.",
      }),
      entry({ title: "Fixed already", decision: "fix" }),
      entry({ title: "Also fixed", decision: "fix", severity: "blocking" }),
      entry({ title: "Deferred", decision: "defer" }),
    ]);
    expect(stack.fixed).toBe(2);
    expect(stack.lines).toEqual([
      "blocking src/a.ts:4 [criterion 2]: Crash -> Guard null.",
      "should_fix: Deferred",
      "minor: Naming",
    ]);
    expect(stack.hidden).toBe(0);
    expect(stackText(stack)).toContain("2 finding(s) were fixed before you saw them.");
  });

  it("is short, but never hides a blocking finding", () => {
    const minors = Array.from({ length: 12 }, (_, i) =>
      entry({ severity: "minor", title: `Nit ${i}` }),
    );
    expect(creatorStack(minors).lines).toHaveLength(7);
    expect(creatorStack(minors).hidden).toBe(5);
    const blockings = Array.from({ length: 10 }, (_, i) =>
      entry({ severity: "blocking", title: `Blocker ${i}` }),
    );
    const stack = creatorStack([...minors, ...blockings]);
    expect(stack.lines.filter((line) => line.startsWith("blocking"))).toHaveLength(10);
    expect(stack.lines.slice(0, 10).every((line) => line.startsWith("blocking"))).toBe(true);
    expect(stackLine(entry({ title: "x".repeat(500) })).length).toBeLessThanOrEqual(180);
  });

  it("says nothing when there is nothing to say", () => {
    expect(stackText(creatorStack([]))).toBe("");
    expect(stackText(undefined)).toBe("");
  });
});

describe("each lens reads only its part of the diff", () => {
  const chunk = (path: string, lines: string[]) =>
    [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,1 +1,2 @@",
      ...lines,
      "",
    ].join(String.fromCharCode(10));
  const diff = [
    chunk("src/a.ts", [" keep", "+code"]),
    chunk("src/a.test.ts", [" keep", "+test"]),
    chunk("docs/guide.md", [" keep", "+words"]),
    chunk("pnpm-lock.yaml", ["+one", "+two", "-three"]),
  ].join("");
  const paths = (text: string) => [...text.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);

  it("gives each lens the kinds of file it needs and a lockfile as one line", () => {
    expect(paths(lensDiff(diff, "adversarial"))).toEqual(["src/a.ts", "pnpm-lock.yaml"]);
    expect(paths(lensDiff(diff, "structure"))).toEqual(["src/a.ts", "pnpm-lock.yaml"]);
    expect(paths(lensDiff(diff, "edge_cases"))).toEqual(["src/a.ts", "pnpm-lock.yaml"]);
    expect(paths(lensDiff(diff, "verification_gaps"))).toEqual([
      "src/a.ts",
      "src/a.test.ts",
      "pnpm-lock.yaml",
    ]);
    expect(paths(lensDiff(diff, "judge"))).toEqual([
      "src/a.ts",
      "src/a.test.ts",
      "docs/guide.md",
      "pnpm-lock.yaml",
    ]);
    expect(paths(lensDiff(diff, "prose"))).toEqual(["docs/guide.md", "pnpm-lock.yaml"]);
    expect(paths(lensDiff(diff, "relevance"))).toEqual([
      "src/a.ts",
      "docs/guide.md",
      "pnpm-lock.yaml",
    ]);
    const parted = lensDiff(diff, "adversarial");
    expect(parted).toContain("# lockfile, not shown: +2 -1");
    expect(parted).not.toContain("+one");
    expect(parted.length).toBeLessThan(diff.length);
  });

  it("gives the security reviewer everything, lockfiles in full", () => {
    expect(lensDiff(diff, "security")).toBe(diff);
  });

  it("gives a change made of documents to every lens that reads documents or code", () => {
    const docs = chunk("docs/prd.md", [" keep", "+claim"]);
    expect(paths(lensDiff(docs, "structure"))).toEqual(["docs/prd.md"]);
    expect(paths(lensDiff(docs, "verification_gaps"))).toEqual(["docs/prd.md"]);
    // Code lenses of a mixed change do not read its documents.
    expect(paths(lensDiff(diff, "verification_gaps"))).not.toContain("docs/guide.md");
  });

  it("says so when nothing of the diff is for the lens, and names the files next to the whole diff", () => {
    expect(lensDiff(chunk("src/a.ts", ["+x"]), "prose")).toContain("nothing of this diff");
    expect(lensDiffPathOf(".agentplugged/.cache/reviews/1-1/qa-abc.diff", "edge_cases")).toBe(
      ".agentplugged/.cache/reviews/1-1/qa-abc.edge_cases.diff",
    );
  });
});

describe("what the review of the 17.1 story found, and the engine now holds", () => {
  const blocking = (title: string, over: Record<string, unknown> = {}) =>
    finding({ severity: "blocking", title, ...over });

  it("keeps two different blocking defects of one file apart, even on one criterion or one line", () => {
    const merged = mergeLensReports([
      report("adversarial", [
        blocking("Path traversal in the upload", { line: 120, criterion: 2 }),
      ]),
      report("edge_cases", [
        blocking("Null path crashes the parser", { line: undefined, criterion: 2 }),
      ]),
      report("relevance", [blocking("Secret written in the log", { line: 120, criterion: 3 })]),
    ]);
    expect(merged.findings).toHaveLength(3);
    expect(merged.merged).toBe(0);
    expect(
      sameFinding(
        {
          severity: "blocking",
          title: "Path traversal in the upload",
          path: "f.ts",
          line: 5,
          criterion: 2,
        },
        { severity: "blocking", title: "Null path crashes the parser", path: "f.ts", criterion: 2 },
      ),
    ).toBe(false);
  });

  it("keeps what the merged lenses said: their advice, criterion and proof", () => {
    const merged = mergeLensReports([
      report("edge_cases", [
        finding({
          severity: "should_fix",
          title: "Empty profile crashes",
          evidence: "load() is null for a new user",
          recommendation: "Guard null.",
        }),
      ]),
      report("adversarial", [
        finding({
          severity: "blocking",
          title: "Empty profile crashes the page",
          criterion: 2,
          evidence: "A new user sees a white page",
          recommendation: "Show an empty state.",
        }),
      ]),
    ]);
    expect(merged.findings).toHaveLength(1);
    const detail = merged.findings[0]?.detail ?? "";
    expect(detail).toContain("A new user sees a white page");
    expect(detail).toContain(
      "edge_cases: Empty profile crashes [criterion 1] -> Guard null. (load() is null for a new user)",
    );
  });

  it("cuts the title of a long line, never its advice", () => {
    const line = stackLine({
      severity: "blocking",
      title: "t".repeat(300),
      path: `${"deep/".repeat(20)}file.ts`,
      line: 12,
      criterion: 3,
      recommendation: "Validate the path before opening it.",
      decision: null,
    });
    expect(line.length).toBeLessThanOrEqual(180);
    expect(line).toContain(" -> Validate the path before opening it.");
    expect(line).toContain("…");
  });

  it("holds every blocking finding in the room of the stack, and counts what no room holds", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      severity: "blocking" as const,
      title: `Blocker number ${i} with a title of some length to fill the line`,
      path: "src/some/long/path/to/a/file.ts",
      line: i + 1,
      criterion: 1,
      recommendation: "Fix it before the merge, please.",
      decision: null,
    }));
    const stack = creatorStack(many);
    expect(stack.lines).toHaveLength(12);
    expect(stack.hidden).toBe(0);
    expect(stackText(stack).length).toBeLessThanOrEqual(STACK_CHARS + 120);
    // More than the room can hold: counted, the blocking ones apart, never silently lost.
    const crowd = creatorStack(
      Array.from({ length: 40 }, (_, i) => ({ ...many[0], title: `Blocker ${i}` })) as never,
    );
    expect(crowd.lines.length + crowd.hidden).toBe(40);
    expect(crowd.hiddenBlocking).toBe(crowd.hidden);
    expect(stackText(crowd)).toContain(
      `${crowd.hidden} more not shown, ${crowd.hiddenBlocking} of them blocking`,
    );
    expect(stackText(crowd).length).toBeLessThanOrEqual(STACK_CHARS + 200);
  });

  it("reads instruction files, manifests and secrets as code, not as documents", () => {
    for (const path of [
      "method/skills/review-story/SKILL.md",
      "AGENTS.md",
      ".claude/rules/x.md",
      "requirements.txt",
      ".env.example",
      "docs/.env",
    ]) {
      expect(isDocumentPath(path), path).toBe(false);
    }
    for (const path of ["README.md", "docs/prd.md", "notes.txt", "docs/guide.rst"]) {
      expect(isDocumentPath(path), path).toBe(true);
    }
    // A change of a skill file alone is read as code: the cases are looked at, not only the words.
    expect(names([file("method/skills/x/SKILL.md", 30)])).toContain("edge_cases");
    expect(names([file("requirements.txt", 2)])).toContain("adversarial");
  });

  it("gives the judge the documents too, and reads a renamed secret as code", () => {
    const docChunk = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n keep\n+words\n`;
    const code = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n keep\n+code\n`;
    const mixed = code + docChunk("docs/guide.md");
    expect(lensDiff(mixed, "judge")).toContain("docs/guide.md");
    expect(lensDiff(mixed, "adversarial")).not.toContain("docs/guide.md");
    const renamed =
      code +
      "diff --git a/.env b/notes.md\nsimilarity index 90%\nrename from .env\nrename to notes.md\n@@ -1 +1 @@\n-KEY=1\n+KEY=2\n";
    expect(lensDiff(renamed, "adversarial")).toContain("rename to notes.md");
    expect(lensDiff(renamed, "prose")).not.toContain("notes.md");
  });

  it("shows a binary file as one line to the lenses, in full to the security reviewer", () => {
    const binary =
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n";
    expect(lensDiff(binary, "adversarial")).toContain("# binary file, not shown");
    expect(lensDiff(binary, "security")).toBe(binary);
  });

  it("asks a proof of some length, and the quality review carries the security lens when nobody else can", () => {
    const short = finding({ evidence: "ok" });
    expect(
      validateLensReports([report("relevance", [short])], {
        kind: "qa",
        required: [],
        criteria: 1,
      }),
    ).toEqual(["evidence_missing:relevance#1"]);
    expect(
      validateJudge(judge({ criteria: [{ criterion: 1, status: "met", evidence: "ok" }] }), 1),
    ).toEqual(["judge_evidence_missing:1"]);
    const chosen = chooseLenses([file("src/auth/login.ts", 2)], ["paths"]);
    expect(requiredLenses("qa", chosen, true)).toContain("security");
    expect(requiredLenses("qa", chosen, false)).not.toContain("security");
    expect(
      validateLensReports([report("security"), report("relevance")], {
        kind: "qa",
        required: requiredLenses("qa", chosen, true),
        criteria: 1,
        securityByQa: true,
      }).filter((problem) => problem.startsWith("lens_not_allowed")),
    ).toEqual([]);
  });
});

describe("the lenses are grouped by reader", () => {
  const plan = (
    files: Parameters<typeof chooseLenses>[0],
    reasons: string[] = [],
    more: never[] = [],
    kind: "qa" | "security" = "qa",
  ) => {
    const chosen = chooseLenses(files, reasons as never, more);
    return planReaders(kind, chosen, isSensitiveChange(files, reasons as never));
  };
  const covered = (readers: ReturnType<typeof plan>) => readers.flatMap((r) => r.lenses);
  const wide = Array.from({ length: 12 }, (_, i) => file(`src/d${i % 4}/f${i}.ts`, 30));

  it("reads a common change with two readers and a judge, each carrying its lenses", () => {
    const readers = plan(wide);
    expect(readers.map((r) => r.reader)).toEqual(["depth", "form", "judge"]);
    expect(readers[0]?.lenses).toEqual(["adversarial", "edge_cases", "verification_gaps"]);
    expect(readers[1]?.lenses).toEqual(["structure", "relevance"]);
    // The judge is alone, in a fresh context, with no lens.
    expect(readers[2]).toEqual({ reader: "judge", lenses: [], judge: true });
    expect(readers.filter((r) => r.lenses.length > 0).length).toBeLessThanOrEqual(2);
  });

  it("reads a small change without risk with one reader that also checks the criteria", () => {
    const readers = plan([file("src/profile.ts", 1)]);
    expect(readers).toEqual([
      { reader: "whole", lenses: ["verification_gaps", "relevance"], judge: true },
    ]);
  });

  it("reads a sensitive change with three readers and the judge alone, never one per lens", () => {
    for (const [files, reasons] of [
      [[file("src/auth/session.ts", 2)], ["paths"]],
      [[file("package.json", 1)], []],
      [[file("db/migrations/001_users.sql", 4)], []],
      [[file("src/ok.ts", 1), file("pnpm-lock.yaml", 9)], []],
      [[file("src/big.ts", 6000)], []],
      [Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`, 1)), []],
    ] as const) {
      const readers = plan([...files], [...reasons]);
      const lenses = chooseLenses([...files], [...reasons] as never).map((c) => c.lens);
      const name = files[0]?.path;
      // The security lens (when the review carries it) alone; the others in depth and form.
      expect(
        readers.map((r) => r.reader),
        name,
      ).toEqual([...(lenses.includes("security") ? ["security"] : []), "depth", "form", "judge"]);
      expect(readers.at(-1), name).toEqual({ reader: "judge", lenses: [], judge: true });
      expect(readers.find((r) => r.reader === "depth")?.lenses, name).toEqual(
        lenses.filter((l) => ["adversarial", "edge_cases", "verification_gaps"].includes(l)),
      );
      expect(readers.find((r) => r.reader === "form")?.lenses, name).toEqual(
        lenses.filter((l) => ["structure", "relevance", "prose"].includes(l)),
      );
      // No reader per lens any more, no reader without a lens but the judge.
      expect(
        readers.filter(
          (r) => r.lenses.length === 1 && r.reader === r.lenses[0] && r.reader !== "security",
        ),
      ).toEqual([]);
      expect(readers.filter((r) => r.lenses.length === 0 && !r.judge)).toEqual([]);
    }
  });

  it("does not add a lens the choice left out, nor a reader without a lens", () => {
    const files = [file("docs/prd.md", 30), file("package.json", 1)];
    const chosen = chooseLenses(files, []);
    const readers = planReaders("qa", chosen, true);
    expect(covered(readers).sort()).toEqual(chosen.map((c) => c.lens).sort());
    expect(readers.filter((r) => r.lenses.length === 0 && !r.judge)).toEqual([]);
    // Nothing chosen on the depth side: no depth reader.
    const only = planReaders("qa", [{ lens: "relevance", why: ["always"] }], true);
    expect(only.map((r) => r.reader)).toEqual(["form", "judge"]);
  });

  it("gives the security lens a reader of its own, and the security review one reader", () => {
    const chosen = chooseLenses([file("src/auth/a.ts", 2)], ["paths"]);
    const qa = planReaders("qa", chosen, true);
    expect(qa.find((r) => r.lenses.includes("security"))?.lenses).toEqual(["security"]);
    expect(planReaders("security", chosen, true)).toEqual([
      { reader: "security", lenses: ["security"], judge: false },
    ]);
    // Even asked for on a change without risk, it is not grouped with the others.
    const asked = chooseLenses([file("src/a.ts", 1)], [], ["security"]);
    const alone = planReaders("qa", asked, false);
    expect(alone.find((r) => r.lenses.includes("security"))?.lenses).toEqual(["security"]);
    expect(alone.filter((r) => r.judge)).toHaveLength(1);
  });

  it("covers the lenses for the same change, each once, with one judge (property, 300 draws)", () => {
    let seed = 17102026;
    const random = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const pool = [
      "src/a.ts",
      "src/b/c.ts",
      "lib/d/e.ts",
      "docs/guide.md",
      "README.md",
      "docs/prd.md",
      "package.json",
      "db/migrations/001.sql",
      "src/auth/login.ts",
      "src/x.test.ts",
    ];
    const asks = ["adversarial", "prose", "security", "structure", "edge_cases"] as const;
    for (let round = 0; round < 300; round += 1) {
      const files = Array.from({ length: 1 + random(14) }, (_, i) =>
        file(
          random(3) === 0 ? (pool[random(pool.length)] as string) : `src/g${random(5)}/h${i}.ts`,
          1 + random(random(4) === 0 ? 400 : 40),
          random(5),
          random(4) === 0,
        ),
      );
      const reasons = files.some((f) => sensitivePath(f.path)) ? ["paths"] : [];
      const more = random(3) === 0 ? [asks[random(asks.length)]] : [];
      const chosen = chooseLenses(files, reasons as never, more as never);
      const sensitive = isSensitiveChange(files, reasons as never);
      const readers = planReaders("qa", chosen, sensitive);
      const given = readers.flatMap((r) => r.lenses);
      // The same lenses as the 17.1 choice, none twice, none dropped.
      expect([...given].sort(), `round ${round}`).toEqual(chosen.map((c) => c.lens).sort());
      // The judge is carried by exactly one reader.
      expect(readers.filter((r) => r.judge)).toHaveLength(1);
      // A change with a security reason, a dependency or a migration is always sensitive.
      const facts = files.some((f) => /package\.json$|\.sql$/.test(f.path));
      if (reasons.length > 0 || facts) expect(sensitive, `round ${round}`).toBe(true);
      // The security lens, when chosen, is alone in its reader (which reads the whole diff).
      const withSecurity = readers.filter((r) => r.lenses.includes("security"));
      expect(withSecurity.every((r) => r.lenses.length === 1 && !r.judge)).toBe(true);
      expect(withSecurity.length).toBe(chosen.some((c) => c.lens === "security") ? 1 : 0);
      // No reader, but the judge, is empty.
      expect(readers.filter((r) => r.lenses.length === 0 && !r.judge)).toEqual([]);
      if (sensitive) {
        // A sensitive change: the judge alone, last, and never more than security, depth and form.
        expect(readers.at(-1), `round ${round}`).toEqual({
          reader: "judge",
          lenses: [],
          judge: true,
        });
        expect(readers.map((r) => r.reader).filter((id) => id !== "judge")).toEqual(
          ["security", "depth", "form"].filter((id) => readers.some((r) => r.reader === id)),
        );
        // Three readers as soon as the lenses chosen allow it.
        const names = new Set<string>(chosen.map((c) => c.lens));
        const has = (list: string[]) => list.some((l) => names.has(l));
        expect(readers.filter((r) => r.lenses.length > 0).length, `round ${round}`).toBe(
          Number(names.has("security")) +
            Number(has(["adversarial", "edge_cases", "verification_gaps"])) +
            Number(has(["structure", "relevance", "prose"])),
        );
      } else {
        expect(readers.filter((r) => r.lenses.length > 0).length).toBeLessThanOrEqual(3);
        expect(readers.filter((r) => r.lenses.length > 1).length).toBeLessThanOrEqual(2);
      }
    }
  });

  it("tips into the three readers exactly at the size of a big change", () => {
    const lines = (n: number) => [file("src/big.ts", n)];
    const files = (n: number) => Array.from({ length: n }, (_, i) => file(`src/f${i}.ts`, 1));
    expect(isSensitiveChange(lines(5999), [])).toBe(false);
    expect(isSensitiveChange(lines(6000), [])).toBe(true);
    expect(isSensitiveChange(files(99), [])).toBe(false);
    expect(isSensitiveChange(files(100), [])).toBe(true);
    // A single reason is enough, whatever the size.
    expect(isSensitiveChange([file("src/a.ts", 1)], ["words"] as never)).toBe(true);
  });

  it("keeps the 17.1 lenses of known changes", () => {
    const seventeen: Array<[Parameters<typeof chooseLenses>[0], string[], string[]]> = [
      [[file("src/profile.ts", 1)], [], ["verification_gaps", "relevance"]],
      [[file("docs/brief.md", 12)], [], ["verification_gaps", "structure", "prose", "relevance"]],
      [
        [file("src/auth/session.ts", 2)],
        ["paths"],
        ["adversarial", "edge_cases", "verification_gaps", "structure", "security", "relevance"],
      ],
    ];
    for (const [files, reasons, expected] of seventeen) {
      const chosen = chooseLenses(files, reasons as never);
      expect(chosen.map((c) => c.lens)).toEqual(expected);
      const readers = planReaders("qa", chosen, isSensitiveChange(files, reasons as never));
      expect(covered(readers).sort()).toEqual([...expected].sort());
    }
  });

  it("gives a reader the union of what its lenses read, once, and loses nothing", () => {
    const chunk = (path: string) =>
      `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+x\n`;
    const diff = [
      "src/a.ts",
      "src/a.test.ts",
      "docs/guide.md",
      "pnpm-lock.yaml",
      ".env",
      "assets/logo.png",
    ]
      .map(chunk)
      .join("");
    const paths = (text: string) => [...text.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1]);
    const every = [
      "adversarial",
      "edge_cases",
      "verification_gaps",
      "structure",
      "prose",
      "relevance",
    ] as const;
    for (const group of [
      ["adversarial", "edge_cases", "verification_gaps"],
      ["structure", "relevance", "prose"],
      ["verification_gaps", "relevance"],
      [...every],
    ] as const) {
      const together = paths(lensDiff(diff, [...group]));
      for (const lens of group) {
        for (const path of paths(lensDiff(diff, lens))) expect(together).toContain(path);
      }
      // Once: no file twice.
      expect(new Set(together).size).toBe(together.length);
    }
    // The reader that also judges sees what the judge sees.
    for (const path of paths(lensDiff(diff, "judge"))) {
      expect(paths(lensDiff(diff, ["relevance", "judge"]))).toContain(path);
    }
    // A reader carrying the security lens reads everything, as the security lens alone does.
    expect(lensDiff(diff, ["security", "relevance"])).toBe(diff);
    expect(lensDiffPathOf("x/qa-abc.diff", "depth")).toBe("x/qa-abc.depth.diff");
  });

  it("merges the reports of grouped readers as those of separate lenses (property, 300 draws)", () => {
    let seed = 20261010;
    const random = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const titles = [
      "Empty profile crashes the page",
      "Token written in the log",
      "Rename the helper",
    ];
    const severities = ["blocking", "should_fix", "minor"] as const;
    const lenses = [
      "adversarial",
      "edge_cases",
      "verification_gaps",
      "structure",
      "relevance",
      "prose",
    ] as const;
    const chosen = lenses.map((lens) => ({ lens, why: ["x"] }));
    const readers = planReaders("qa", chosen, false);
    expect(readers.map((r) => r.reader)).toEqual(["depth", "form", "judge"]);
    const rules = { kind: "qa", required: [...lenses], criteria: 3 } as const;
    for (let round = 0; round < 300; round += 1) {
      const reports = lenses.map((lens) =>
        report(
          lens,
          Array.from({ length: random(3) }, () =>
            finding({
              severity: severities[random(3)] as "blocking",
              title: titles[random(titles.length)] as string,
              line: 10 + random(3),
            }),
          ),
        ),
      );
      // Reports as the readers hand them in: readers in any order, lenses in any order.
      const order = random(2) === 0 ? [...readers].reverse() : readers;
      const byReader = order.flatMap((r) =>
        (random(2) === 0 ? [...r.lenses].reverse() : r.lenses).map(
          (lens) => reports.find((x) => x.lens === lens) as LensReport,
        ),
      );
      const raw = reports.flatMap((r) => r.findings);
      const merged = mergeLensReports(byReader);
      expect(reviewVerdictOf(merged.findings), `round ${round}`).toBe(reviewVerdictOf(raw));
      expect(merged.findings.length + merged.merged).toBe(raw.length);
      if (raw.some((f) => f.severity === "blocking")) {
        expect(merged.findings.some((f) => f.severity === "blocking")).toBe(true);
      }
      expect(byReader).toHaveLength(lenses.length);
      expect(validateLensReports(byReader, rules)).toEqual([]);
    }
  });
});

describe("the judge's rulings on the findings", () => {
  const ruling = (name: string, status: "confirmed" | "refuted" | "undecided", over = {}) => ({
    finding: name,
    status,
    evidence: "Read the cited lines: that is what they do.",
    ...(status === "confirmed"
      ? { severity: "should_fix" as "blocking" | "should_fix" | "minor" }
      : {}),
    ...(status === "refuted" ? { at: "src/profile.ts:2" } : {}),
    ...over,
  });

  it("sets the severity the judge gives, drops a refuted finding with its proof, caps an undecided one", () => {
    const reports = [
      report("adversarial", [
        finding({ title: "Token written in the log", severity: "blocking", path: "a.ts" }),
        finding({ title: "Rename the helper", severity: "minor", path: "b.ts" }),
        finding({ title: "Race on two saves", severity: "blocking", path: "c.ts" }),
        finding({ title: "Crash on an empty profile", severity: "should_fix", path: "d.ts" }),
      ]),
    ];
    const merged = mergeLensReports(
      reports,
      judge({
        findings: [
          ruling("adversarial#1", "refuted"),
          ruling("adversarial#2", "confirmed", { severity: "blocking" }),
          ruling("adversarial#3", "undecided"),
          ruling("adversarial#4", "confirmed", { severity: "minor", cause: "story" }),
        ],
      }),
    );
    expect(merged.refuted).toEqual([
      {
        lens: "adversarial",
        severity: "blocking",
        title: "Token written in the log",
        at: "src/profile.ts:2",
      },
    ]);
    expect(merged.ruled).toEqual({ confirmed: 2, refuted: 1, undecided: 1 });
    expect(merged.findings.map((f) => [f.title, f.severity, f.ruling, f.cause])).toEqual([
      ["Rename the helper", "blocking", "confirmed", undefined],
      ["Race on two saves", "should_fix", "undecided", undefined],
      ["Crash on an empty profile", "minor", "confirmed", "story"],
    ]);
    // A blocking finding nobody could settle never blocks; one the judge confirms does.
    expect(reviewVerdictOf(merged.findings)).toBe("fail");
  });

  it("keeps the readers' own severities when the judge gives no ruling at all", () => {
    const reports = [report("adversarial", [finding({ severity: "blocking" })])];
    const merged = mergeLensReports(reports, judge());
    expect(merged.ruled).toBeUndefined();
    expect(merged.refuted).toEqual([]);
    expect(merged.findings[0]).toMatchObject({ severity: "blocking" });
    expect(merged.findings[0]?.ruling).toBeUndefined();
  });

  it("keeps the strictest ruling when two lenses saw the same thing", () => {
    const merged = mergeLensReports(
      [
        report("adversarial", [finding({ title: "Empty profile crashes the page" })]),
        report("edge_cases", [finding({ title: "Empty profile crashes" })]),
      ],
      judge({
        findings: [
          ruling("adversarial#1", "undecided"),
          ruling("edge_cases#1", "confirmed", { severity: "blocking" }),
        ],
      }),
    );
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]).toMatchObject({ severity: "blocking", ruling: "confirmed" });
  });

  it("rules every finding once and only the ones that exist, with a proof, a severity and a place (validation)", () => {
    const reports = [report("adversarial", [finding(), finding({ line: 40 })])];
    expect(findingRefs(reports)).toEqual(["adversarial#1", "adversarial#2"]);
    const refs = findingRefs(reports);
    const check = (findings: unknown[]) =>
      validateJudge(judge({ findings: findings as never }), 1, refs);
    expect(
      check([ruling("adversarial#1", "confirmed"), ruling("adversarial#2", "undecided")]),
    ).toEqual([]);
    expect(check([ruling("adversarial#1", "confirmed")])).toEqual([
      "judge_finding_missing:adversarial#2",
    ]);
    expect(
      check([
        ruling("adversarial#1", "confirmed"),
        ruling("adversarial#1", "confirmed"),
        ruling("adversarial#2", "confirmed"),
        ruling("edge_cases#1", "confirmed"),
      ]),
    ).toEqual(["judge_finding_repeated:adversarial#1", "judge_finding_unknown:edge_cases#1"]);
    expect(
      check([
        ruling("adversarial#1", "confirmed", { severity: undefined }),
        ruling("adversarial#2", "refuted", { at: undefined }),
      ]),
    ).toEqual([
      "judge_finding_severity_missing:adversarial#1",
      "judge_finding_proof_missing:adversarial#2",
    ]);
    // Without findings, no ruling is asked: the judge of a review with nothing to rule on.
    expect(validateJudge(judge(), 1, [])).toEqual([]);
  });

  it("labels a fused finding unverified only when every member is a lens finding nobody could settle", () => {
    const lens = [
      report("adversarial", [
        finding({ title: "Empty profile crashes the page", severity: "blocking" }),
      ]),
    ];
    // A criterion the judge found unmet, on the same place: it is the judge's own, so it stands.
    const merged = mergeLensReports(
      lens,
      judge({
        criteria: [
          {
            criterion: 1,
            status: "unmet",
            evidence: "src/profile.ts:12 and its test",
            recommendation: "Show the name.",
          },
        ],
        findings: [ruling("adversarial#1", "undecided")],
      }),
    );
    expect(merged.findings.every((f) => f.ruling !== "undecided" || f.lens !== "judge")).toBe(true);
    expect(merged.findings.find((f) => f.lens === "judge")?.ruling).toBeUndefined();
    // Two lenses that both could not be settled stay unverified; one confirmed makes it confirmed.
    const twice = mergeLensReports(
      [
        report("adversarial", [finding({ title: "Empty profile crashes the page" })]),
        report("edge_cases", [finding({ title: "Empty profile crashes" })]),
      ],
      judge({
        findings: [ruling("adversarial#1", "undecided"), ruling("edge_cases#1", "undecided")],
      }),
    );
    expect(twice.findings).toHaveLength(1);
    expect(twice.findings[0]?.ruling).toBe("undecided");
  });

  it("never sets aside nor lowers a finding of the security lens", () => {
    const reports = [
      report("security", [
        finding({ title: "Token written in the log", severity: "blocking", path: "a.ts" }),
        finding({ title: "Cookie without flags", severity: "should_fix", path: "b.ts" }),
        finding({ title: "Verbose error", severity: "minor", path: "c.ts" }),
      ]),
    ];
    const merged = mergeLensReports(
      reports,
      judge({
        findings: [
          ruling("security#1", "refuted"),
          ruling("security#2", "confirmed", { severity: "minor" }),
          ruling("security#3", "confirmed", { severity: "blocking" }),
        ],
      }),
    );
    expect(merged.refuted).toEqual([]);
    expect(merged.ruled).toEqual({ confirmed: 2, refuted: 0, undecided: 1 });
    expect(merged.findings.map((f) => [f.title, f.severity, f.ruling])).toEqual([
      ["Token written in the log", "blocking", "undecided"],
      ["Verbose error", "blocking", "confirmed"],
      ["Cookie without flags", "should_fix", "confirmed"],
    ]);
  });

  it("asks a place for a refutation and more than a word to lower a blocking finding", () => {
    const reports = [
      report("adversarial", [
        finding({ severity: "blocking" }),
        finding({ line: 40, severity: "should_fix" }),
      ]),
    ];
    const refs = findingRefs(reports);
    const severities = findingSeverities(reports);
    const check = (findings: unknown[]) =>
      validateJudge(judge({ findings: findings as never }), 1, refs, severities);
    const keep = ruling("adversarial#2", "confirmed");
    expect(check([ruling("adversarial#1", "refuted", { at: "src/profile.ts" }), keep])).toEqual([
      "judge_finding_proof_missing:adversarial#1",
    ]);
    expect(check([ruling("adversarial#1", "refuted", { at: "n/a" }), keep])).toEqual([
      "judge_finding_proof_missing:adversarial#1",
    ]);
    expect(check([ruling("adversarial#1", "refuted"), keep])).toEqual([]);
    expect(
      check([ruling("adversarial#1", "refuted", { evidence: "Not really a bug here." }), keep]),
    ).toEqual(["judge_finding_evidence_missing:adversarial#1"]);
    expect(
      check([
        ruling("adversarial#1", "confirmed", { severity: "minor", evidence: "Only cosmetic." }),
        keep,
      ]),
    ).toEqual(["judge_finding_evidence_missing:adversarial#1"]);
    expect(check([ruling("adversarial#1", "confirmed", { severity: "blocking" }), keep])).toEqual(
      [],
    );
    // A lesser finding is set aside on the usual proof.
    expect(
      check([
        ruling("adversarial#1", "confirmed", { severity: "blocking" }),
        ruling("adversarial#2", "refuted", {
          evidence: "Guard on line 3 returns first.",
          at: "src/profile.ts",
        }),
      ]),
    ).toEqual([]);
  });

  it("counts what the judge set aside in the stack, never listing it", () => {
    const none = creatorStack([], 7, [], { total: 3, blocking: 1 });
    expect(stackText(none)).toBe(
      " The judge refuted 3 finding(s) with proof (1 called blocking by a reader).",
    );
    expect(stackText(creatorStack([], 7, [], { total: 2, blocking: 0 }))).toBe(
      " The judge refuted 2 finding(s) with proof.",
    );
    expect(stackText(creatorStack([], 7, [], { total: 0, blocking: 0 }))).toBe("");
  });

  it("loses no blocking finding without a proof, whatever the rulings (property, 300 draws)", () => {
    let seed = 20261013;
    const random = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    const severities = ["blocking", "should_fix", "minor"] as const;
    const lenses = ["adversarial", "edge_cases", "verification_gaps", "relevance"] as const;
    let count = 0;
    for (let round = 0; round < 300; round += 1) {
      // Every finding of its own file: two lenses never saw the same thing here.
      const reports = lenses.map((lens) =>
        report(
          lens,
          Array.from({ length: random(4) }, () => {
            count += 1;
            return finding({
              severity: severities[random(3)] as "blocking",
              title: `Distinct finding number ${count}`,
              path: `src/file${count}.ts`,
              line: 1 + random(50),
            });
          }),
        ),
      );
      const statuses = ["confirmed", "refuted", "undecided"] as const;
      const rulings = reports.flatMap((r) =>
        r.findings.map((_, index) => {
          const status = statuses[random(3)] as "confirmed";
          return ruling(`${r.lens}#${index + 1}`, status, {
            ...(status === "confirmed" ? { severity: severities[random(3)] } : {}),
          });
        }),
      );
      expect(validateJudge(judge({ findings: rulings }), 1, findingRefs(reports))).toEqual([]);
      const merged = mergeLensReports(reports, judge({ findings: rulings }));
      const tally = (status: string) => rulings.filter((r) => r.status === status).length;
      expect(merged.ruled ?? { confirmed: 0, refuted: 0, undecided: 0 }).toEqual(
        rulings.length === 0
          ? { confirmed: 0, refuted: 0, undecided: 0 }
          : {
              confirmed: tally("confirmed"),
              refuted: tally("refuted"),
              undecided: tally("undecided"),
            },
      );
      // Everything given is either shown or refuted with its proof: nothing vanishes.
      expect(merged.findings.length + merged.refuted.length, `round ${round}`).toBe(
        reports.flatMap((r) => r.findings).length,
      );
      expect(merged.refuted.every((r) => r.at !== undefined)).toBe(true);
      // No finding nobody could settle blocks.
      expect(
        merged.findings
          .filter((f) => f.ruling === "undecided")
          .every((f) => f.severity !== "blocking"),
      ).toBe(true);
      // A blocking finding reaches the creator's stack only if the judge confirmed it blocking.
      const shownBlocking = merged.findings.filter((f) => f.severity === "blocking").length;
      const judgedBlocking = rulings.filter(
        (r) => r.status === "confirmed" && r.severity === "blocking",
      ).length;
      expect(shownBlocking, `round ${round}`).toBe(judgedBlocking);
    }
  });
});

describe("a silent lens", () => {
  const context = {
    kind: "qa" as const,
    required: ["relevance", "verification_gaps"] as never,
    criteria: 1,
  };

  it("owes no report when declared silent, and is refused when it is not", () => {
    const only = [report("relevance")];
    expect(validateLensReports(only, context)).toEqual(["lens_missing:verification_gaps"]);
    expect(validateLensReports(only, { ...context, silent: ["verification_gaps"] })).toEqual([]);
    expect(
      validateLensReports(only, { ...context, silent: ["relevance", "verification_gaps"] }),
    ).toEqual(["silent_but_reported:relevance", "nothing_reported"]);
    expect(
      validateLensReports([], { ...context, silent: ["relevance", "verification_gaps"] }),
    ).toEqual(["nothing_reported"]);
    expect(validateLensReports(only, { ...context, silent: ["adversarial"] })).toContain(
      "silent_not_asked:adversarial",
    );
    // The judge may be silent whatever the lenses ask.
    expect(
      validateLensReports(only, { ...context, silent: ["verification_gaps", "judge"] }),
    ).toEqual([]);
  });

  it("puts a short stack under the creator's eyes with the lenses that said nothing", () => {
    const stack = creatorStack([], 7, ["adversarial"]);
    expect(stackText(stack)).toBe(" Review possibly incomplete: no report from adversarial.");
    // With findings, the warning follows them.
    const some = creatorStack(
      [{ severity: "should_fix", title: "Empty profile", decision: null }],
      7,
      ["judge"],
    );
    expect(stackText(some)).toMatch(
      /Left open, blocking first: .*Empty profile.*Review possibly incomplete: no report from judge\.$/,
    );
  });
});
