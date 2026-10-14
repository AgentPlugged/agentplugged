import type {
  AuditFinding,
  AuditPillarResult,
  ProofKind,
  RequirementEntry,
} from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { mergeHold } from "../ci/ci-rules.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import {
  budgetOf,
  buildRegistry,
  ciProofProblem,
  commandsOf,
  gapPointProblem,
  gapSettled,
  MAX_GAPS_SHOWN,
  measureResult,
  openGaps,
  pillarOf,
  proofIsStale,
  proofOf,
  proofProblem,
  type RequirementItem,
  releaseHold,
  requirementProofState,
  requirementsView,
  sameRegistry,
  validateAuditReport,
} from "./requirement-rules.js";

const PRD = [
  "---",
  "id: prd",
  "kind: prd",
  "owner: maya",
  "---",
  "# PRD",
  "",
  "- EF-1: The visitor signs in.",
  "- ENF-1: A page answers in at most 300 ms (p95), measured by `pnpm bench`.",
  "- ENF-2: The sign-in has tests for its failure cases, measured by the test suite.",
  "- ENF-3: (retired) Old limit.",
  "- ENF-4: No known vulnerability in the dependencies, measured by `npm audit`.",
  "- ENF-5: Les écrans restent accessibles au clavier (WCAG AA), vérifié par relecture.",
  "",
].join("\n");

const ARCHITECTURE = [
  "---",
  "id: architecture",
  "kind: architecture",
  "owner: alex",
  "---",
  "# Architecture",
  "",
  "### AD-1 — One writer per piece of data",
  "",
  "- **Binds:** the journal.",
  "- **Budget:** a replay takes under 2 s for 10 000 events.",
  "",
  "### AD-2 — Plain decision",
  "",
  "- **Binds:** the CLI.",
  "",
].join("\n");

const STORY = (id: string, requirements: string[]) =>
  [
    "---",
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `requirements: [${requirements.join(", ")}]`,
    "---",
    `# Story ${id}`,
    "",
  ].join("\n");

const FILES = [
  { path: ".agentplugged/docs/prd.md", text: PRD },
  { path: ".agentplugged/docs/architecture.md", text: ARCHITECTURE },
  { path: ".agentplugged/stories/1-1-a.md", text: STORY("1-1", ["ENF-1"]) },
  { path: ".agentplugged/stories/1-2-b.md", text: STORY("1-2", ["ENF-1", "ENF-2"]) },
];

const registry = () =>
  buildRegistry(
    FILES.map((file) => parseDocumentFile(file.path, file.text)),
    FILES,
  );

describe("reading the requirements", () => {
  it("takes the pillar from the words, in English and in French", () => {
    expect(pillarOf("A page answers in 300 ms")).toBe("performance");
    expect(pillarOf("No known vulnerability")).toBe("security");
    expect(pillarOf("Les écrans restent accessibles au clavier")).toBe("accessibility");
    expect(pillarOf("Licences of dependencies are permissive")).toBe("dependencies");
    expect(pillarOf("The service is available 99.9 % of the time")).toBe("reliability");
    expect(pillarOf("Empty state and loading state are shown")).toBe("interface");
    expect(pillarOf("Coverage stays above 80 %")).toBe("tests");
    expect(pillarOf("Code stays readable")).toBe("maintainability");
    expect(pillarOf("Something else entirely")).toBe("reliability");
  });

  it("reads a numbered bound with its direction and unit, never converting it", () => {
    expect(budgetOf("p95 ≤ 200 ms")).toEqual({ op: "max", value: 200, unit: "ms" });
    expect(budgetOf("under 2 s")).toEqual({ op: "max", value: 2, unit: "s" });
    expect(budgetOf("at least 99.9 % available")).toEqual({ op: "min", value: 99.9, unit: "%" });
    expect(budgetOf("au moins 80 % de couverture")).toEqual({ op: "min", value: 80, unit: "%" });
    expect(budgetOf("moins de 1,5 Mo")).toEqual({ op: "max", value: 1.5, unit: "Mo" });
    expect(budgetOf("fast and reliable")).toBeUndefined();
  });

  it("takes the expected proof from the way the requirement says it is checked", () => {
    expect(proofOf("measured by a code review", undefined)).toBe("review");
    expect(proofOf("checked in the CI pipeline", undefined)).toBe("ci");
    expect(proofOf("answers in time", { op: "max", value: 3, unit: "s" })).toBe("measure");
    expect(proofOf("vérifié par relecture", { op: "max", value: 3, unit: "s" })).toBe("review");
    expect(proofOf("measured by a dependency audit", undefined)).toBe("analysis");
    expect(proofOf("measured by the test suite", undefined)).toBe("test");
  });

  it("keeps the commands the project wrote between backticks, and no other", () => {
    expect(commandsOf("measured by `pnpm bench` and `make audit`")).toEqual([
      "pnpm bench",
      "make audit",
    ]);
    expect(commandsOf("measured by the test suite")).toEqual([]);
  });

  it("builds the register from the PRD and the budgets of the decisions, in order", () => {
    const items = registry();
    expect(items.map((item) => item.id)).toEqual(["AD-1", "ENF-1", "ENF-2", "ENF-4", "ENF-5"]);
    const byId = new Map(items.map((item) => [item.id, item]));
    expect(byId.get("ENF-1")).toMatchObject({
      pillar: "performance",
      proof: "measure",
      budget: { op: "max", value: 300, unit: "ms" },
      commands: ["pnpm bench"],
      stories: ["1-1", "1-2"],
    });
    expect(byId.get("ENF-2")).toMatchObject({ proof: "test", stories: ["1-2"], commands: [] });
    expect(byId.get("ENF-4")).toMatchObject({
      pillar: "security",
      proof: "analysis",
      commands: ["npm audit"],
      stories: [],
    });
    expect(byId.get("ENF-5")).toMatchObject({ pillar: "accessibility", proof: "review" });
    // A decision without a numbered budget is not a requirement of the register.
    expect(byId.has("AD-2")).toBe(false);
    expect(byId.get("AD-1")).toMatchObject({ budget: { op: "max", value: 2, unit: "s" } });
    // A retired requirement is no longer expected.
    expect(byId.has("ENF-3")).toBe(false);
  });

  it("is deterministic, and its digest ignores the stories that cite a requirement", () => {
    const first = registry();
    expect(registry()).toEqual(first);
    const more = [
      ...FILES,
      { path: ".agentplugged/stories/1-3-c.md", text: STORY("1-3", ["ENF-4"]) },
    ];
    const second = buildRegistry(
      more.map((file) => parseDocumentFile(file.path, file.text)),
      more,
    );
    const digest = (items: RequirementEntry[], id: string) =>
      items.find((item) => item.id === id)?.digest;
    expect(digest(second, "ENF-4")).toBe(digest(first, "ENF-4"));
    expect(second.find((item) => item.id === "ENF-4")?.stories).toEqual(["1-3"]);
    const edited = PRD.replace("at most 300 ms", "at most 250 ms");
    const changed = buildRegistry(
      [parseDocumentFile(FILES[0]?.path ?? "", edited)],
      [{ path: FILES[0]?.path ?? "", text: edited }],
    );
    expect(digest(changed, "ENF-1")).not.toBe(digest(first, "ENF-1"));
  });

  it("tells whether the journal already holds the register the documents say", () => {
    const items = registry();
    expect(sameRegistry([], {})).toBe(true);
    expect(sameRegistry(items, {})).toBe(false);
    const held = {
      requirements: {
        at: "2026-10-09T10:00:00.000Z",
        items: Object.fromEntries(items.map((item) => [item.id, stateItem(item)])),
      },
    };
    expect(sameRegistry(items, held)).toBe(true);
    expect(sameRegistry(items.slice(1), held)).toBe(false);
  });
});

function stateItem(entry: RequirementEntry, extra: Partial<RequirementItem> = {}): RequirementItem {
  return {
    id: entry.id,
    pillar: entry.pillar,
    proof: entry.proof,
    text: entry.text,
    budget: entry.budget ?? null,
    commands: entry.commands,
    stories: entry.stories,
    digest: entry.digest,
    since: "2026-10-09T10:00:00.000Z",
    proved: null,
    gap: null,
    ...extra,
  };
}

const proof = (at: string, result: "pass" | "fail" = "pass") => ({
  kind: "test" as const,
  result,
  source: "src/a.test.ts:3",
  measured: null,
  budget: null,
  note: null,
  at,
  by: "quentin",
  event: "E1",
});

/** A state with a register of `ids`, and the stories delivered at the given times. */
function stateWith(
  items: Record<string, Partial<RequirementItem>>,
  delivered: Record<string, string> = {},
) {
  const entries = new Map(registry().map((entry) => [entry.id, entry]));
  const stories: Record<string, unknown> = {};
  const checkpoints: Record<string, unknown> = {};
  for (const [story, at] of Object.entries(delivered)) {
    stories[story] = { started: {}, merged: { at } };
  }
  return {
    requirements: {
      at: "2026-10-09T10:00:00.000Z",
      items: Object.fromEntries(
        Object.entries(items).map(([id, extra]) => {
          const entry = entries.get(id);
          if (entry === undefined) throw new Error(`no ${id}`);
          return [id, stateItem(entry, extra)];
        }),
      ),
    },
    stories,
    checkpoints,
  };
}

describe("the state of a requirement", () => {
  it("is without proof until a proof is recorded, proven by a passing one, failed by a failing one", () => {
    const state = stateWith({
      "ENF-2": {},
      "ENF-4": { proved: proof("2026-10-09T11:00:00.000Z") },
      "ENF-5": { proved: proof("2026-10-09T11:00:00.000Z", "fail") },
    });
    const items = state.requirements.items;
    expect(requirementProofState(state, items["ENF-2"] as RequirementItem)).toEqual({
      state: "unproven",
      why: "no_proof",
    });
    expect(requirementProofState(state, items["ENF-4"] as RequirementItem)).toEqual({
      state: "proven",
    });
    expect(requirementProofState(state, items["ENF-5"] as RequirementItem)).toEqual({
      state: "failed",
      why: "failed",
    });
  });

  it("no longer counts a proof older than the delivery of a story the requirement covers", () => {
    const delivered = { "1-2": "2026-10-09T12:00:00.000Z" };
    const state = stateWith(
      {
        // ENF-2 is covered by story 1-2 only.
        "ENF-2": { proved: proof("2026-10-09T11:00:00.000Z") },
        "ENF-4": { proved: proof("2026-10-09T11:00:00.000Z") },
      },
      delivered,
    );
    const items = state.requirements.items;
    expect(proofIsStale(state, items["ENF-2"] as RequirementItem, "2026-10-09T11:00:00.000Z")).toBe(
      true,
    );
    expect(requirementProofState(state, items["ENF-2"] as RequirementItem)).toEqual({
      state: "unproven",
      why: "stale",
    });
    // ENF-4 is cited by no story: it covers all the code, any delivery makes its proof stale.
    expect(requirementProofState(state, items["ENF-4"] as RequirementItem).why).toBe("stale");
    // A proof made after the delivery stands.
    const fresh = stateWith({ "ENF-2": { proved: proof("2026-10-09T13:00:00.000Z") } }, delivered);
    expect(
      requirementProofState(fresh, fresh.requirements.items["ENF-2"] as RequirementItem).state,
    ).toBe("proven");
    // A story that does not cover the requirement changes nothing.
    const other = stateWith(
      { "ENF-2": { proved: proof("2026-10-09T11:00:00.000Z") } },
      { "1-1": "2026-10-09T12:00:00.000Z" },
    );
    expect(
      requirementProofState(other, other.requirements.items["ENF-2"] as RequirementItem).state,
    ).toBe("proven");
  });

  it("settles a gap by the creator's acceptance or deferral, not by a decision to fix it", () => {
    const gap = (decision: "fix" | "accept" | "defer", at: string) => ({
      decision,
      reason: "r",
      version: null,
      checkpoint: "G-0123456789",
      at,
      by: "quentin",
      event: "E2",
    });
    const base = { proved: proof("2026-10-09T11:00:00.000Z", "fail") };
    const accepted = stateWith({
      "ENF-2": { ...base, gap: gap("accept", "2026-10-09T11:30:00.000Z") },
    });
    expect(gapSettled(accepted.requirements.items["ENF-2"] as RequirementItem)).toBe(true);
    const deferred = stateWith({
      "ENF-2": { ...base, gap: gap("defer", "2026-10-09T11:30:00.000Z") },
    });
    expect(gapSettled(deferred.requirements.items["ENF-2"] as RequirementItem)).toBe(true);
    const fix = stateWith({ "ENF-2": { ...base, gap: gap("fix", "2026-10-09T11:30:00.000Z") } });
    expect(gapSettled(fix.requirements.items["ENF-2"] as RequirementItem)).toBe(false);
    // A failure recorded after the acceptance reopens the gap.
    const reopened = stateWith({
      "ENF-2": {
        proved: proof("2026-10-09T12:00:00.000Z", "fail"),
        gap: gap("accept", "2026-10-09T11:30:00.000Z"),
      },
    });
    expect(gapSettled(reopened.requirements.items["ENF-2"] as RequirementItem)).toBe(false);
  });
});

describe("the release gate and the compact view", () => {
  it("holds the release while a requirement has no valid proof or a failed one", () => {
    expect(releaseHold({})).toBeUndefined();
    const state = stateWith({
      "ENF-1": { proved: proof("2026-10-09T11:00:00.000Z") },
      "ENF-2": { proved: proof("2026-10-09T11:00:00.000Z", "fail") },
      "ENF-4": {},
    });
    expect(releaseHold(state)).toEqual({
      open: 2,
      failed: 1,
      engine: 0,
      reported: 1,
      requirements: "ENF-2:failed, ENF-4:no_proof",
    });
    const proven = stateWith({ "ENF-1": { proved: proof("2026-10-09T11:00:00.000Z") } });
    expect(releaseHold(proven)).toBeUndefined();
    expect(openGaps(proven)).toEqual([]);
  });

  it("renders the register in a bounded form", () => {
    expect(requirementsView({})).toBeUndefined();
    const state = stateWith({
      "ENF-1": { proved: proof("2026-10-09T11:00:00.000Z") },
      "ENF-2": { proved: proof("2026-10-09T11:00:00.000Z", "fail") },
      "ENF-4": {},
    });
    expect(requirementsView(state)).toEqual({
      total: 3,
      proven: 1,
      failed: 1,
      unproven: 1,
      settled: 0,
      gaps: ["ENF-2:failed:test", "ENF-4:no_proof:analysis"],
    });
  });

  it("shows at most eight gaps, and says how many more", () => {
    const items: RequirementItem[] = Array.from({ length: 30 }, (_, index) =>
      stateItem({
        id: `ENF-${index + 1}`,
        pillar: "reliability",
        proof: "test",
        text: "t",
        commands: [],
        stories: [],
        digest: "abcdefabcdef",
      }),
    );
    const state = {
      requirements: {
        at: "2026-10-09T10:00:00.000Z",
        items: Object.fromEntries(items.map((item) => [item.id, item])),
      },
    };
    const view = requirementsView(state);
    expect(view?.gaps).toHaveLength(MAX_GAPS_SHOWN);
    expect(view?.more).toBe(22);
    expect(JSON.stringify(view).length).toBeLessThan(400);
    expect(releaseHold(state)?.requirements).toContain("(+22)");
  });
});

describe("proofs", () => {
  const entries = new Map(registry().map((entry) => [entry.id, stateItem(entry)]));
  const item = (id: string) => entries.get(id) as RequirementItem;

  it("decides a measure itself, against the budget, in its direction", () => {
    expect(measureResult({ op: "max", value: 300, unit: "ms" }, 300)).toBe("pass");
    expect(measureResult({ op: "max", value: 300, unit: "ms" }, 301)).toBe("fail");
    expect(measureResult({ op: "min", value: 80, unit: "%" }, 80)).toBe("pass");
    expect(measureResult({ op: "min", value: 80, unit: "%" }, 79.9)).toBe("fail");
  });

  it("accepts an analysis or a measure only from a command the project declares", () => {
    expect(
      proofProblem(item("ENF-4"), { kind: "analysis", source: "npm audit --json" }, null),
    ).toBe(undefined);
    expect(proofProblem(item("ENF-4"), { kind: "analysis", source: "snyk test" }, null)).toBe(
      "command_not_declared:npm audit",
    );
    expect(proofProblem(item("ENF-1"), { kind: "measure", source: "pnpm bench" }, null)).toBe(
      undefined,
    );
    // A requirement that declares no command leaves the choice of the tool to the project.
    expect(proofProblem(item("ENF-5"), { kind: "analysis", source: "any tool" }, null)).toBe(
      undefined,
    );
    // A measure needs a budget.
    expect(proofProblem(item("ENF-4"), { kind: "measure", source: "npm audit" }, null)).toBe(
      "no_budget",
    );
  });

  it("accepts a test only when it is one that cites the requirement", () => {
    const cites = [{ path: "src/signin.test.ts", line: 4 }];
    expect(
      proofProblem(item("ENF-2"), { kind: "test", source: "src/signin.test.ts:4" }, cites),
    ).toBe(undefined);
    expect(
      proofProblem(item("ENF-2"), { kind: "test", source: "src/other.test.ts:1" }, cites),
    ).toBe("source_not_a_citing_test");
    expect(proofProblem(item("ENF-2"), { kind: "test", source: "src/a.test.ts:1" }, [])).toBe(
      "no_test_cites_it",
    );
    // The tests cannot be read here: nothing is said against the source.
    expect(proofProblem(item("ENF-2"), { kind: "test", source: "src/a.test.ts:1" }, null)).toBe(
      undefined,
    );
  });
});

describe("the audit report", () => {
  const known = new Map<string, ProofKind>([
    ["ENF-1", "measure"],
    ["ENF-2", "review"],
    ["ENF-3", "test"],
  ]);
  const result = (pillar: AuditPillarResult["pillar"], extra: Partial<AuditPillarResult> = {}) =>
    ({
      pillar,
      verdict: "pass",
      reads: ["src/a.ts"],
      summary: "Read.",
      ...extra,
    }) as AuditPillarResult;
  const finding = (extra: Partial<AuditFinding> = {}) =>
    ({
      pillar: "performance",
      severity: "should_fix",
      where: "src/a.ts:10",
      what: "A loop reads the whole table.",
      fix: "Add an index.",
      action: "story",
      ...extra,
    }) as AuditFinding;

  it("accepts a whole report", () => {
    expect(
      validateAuditReport(
        {
          results: [
            result("performance", { verdict: "issues" }),
            result("tests", { verified: ["ENF-2"] }),
          ],
          findings: [finding({ action: "gap", requirement: "ENF-1" })],
        },
        known,
      ),
    ).toEqual([]);
  });

  it("refuses a report that is not whole, with everything that is missing", () => {
    const problems = validateAuditReport(
      {
        results: [
          result("performance", { verdict: "issues", reads: [] }),
          result("performance"),
          result("tests", {
            reads: Array.from({ length: 41 }, (_, index) => `src/f${index}.ts`),
            verified: ["ENF-9", "ENF-1", "ENF-3"],
          }),
          result("security", { verdict: "pass" }),
          result("accessibility", { verdict: "not_applicable", reads: [], verified: ["ENF-2"] }),
        ],
        findings: [
          finding({ severity: "blocking", fix: undefined }),
          finding({ action: "gap" }),
          finding({ action: "gap", requirement: "ENF-8" }),
          finding({ action: "note", severity: "blocking" }),
          finding({ action: "note", severity: "should_fix" }),
          finding({ pillar: "interface" }),
          finding({ pillar: "security" }),
          finding({ action: "gap", requirement: "ENF-1", pillar: "tests" }),
        ],
      },
      known,
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "result_repeated:performance",
        "reads_missing:performance",
        "reads_too_many:tests:41",
        "verified_unknown:tests:ENF-9",
        "fix_missing:performance#1",
        "requirement_missing:performance#2",
        "requirement_unknown:performance#3:ENF-8",
        "note_needs_a_minor_finding:performance#4",
        "note_needs_a_minor_finding:performance#5",
        "verified_not_a_review_proof:ENF-1:measure",
        "verified_not_a_review_proof:ENF-3:test",
        "verified_needs_a_pass_with_reads:accessibility",
        "finding_not_audited:interface#6",
        "finding_with_verdict:security",
        "verified_and_failed:ENF-1",
      ]),
    );
  });

  it("refuses a verdict that says issues without a finding, and not applicable with one", () => {
    expect(
      validateAuditReport(
        {
          results: [
            result("quality", { verdict: "issues" }),
            result("interface", { verdict: "not_applicable", reads: [] }),
          ],
          findings: [finding({ pillar: "interface" })],
        },
        known,
      ),
    ).toEqual(["issues_without_finding:quality", "finding_with_verdict:interface"]);
    expect(
      validateAuditReport(
        { results: [result("interface", { verdict: "not_applicable", reads: [] })], findings: [] },
        known,
      ),
    ).toEqual([]);
  });
});

describe("reading numbers and budgets without inventing them", () => {
  it("reads groups of thousands and refuses a number that can be read two ways", () => {
    expect(budgetOf("at least 1 000 req/s")).toEqual({ op: "min", value: 1000, unit: "req/s" });
    expect(budgetOf("under 10\u00a0000 requêtes")).toEqual({
      op: "max",
      value: 10000,
      unit: "requêtes",
    });
    expect(budgetOf("under 0.125 s")).toEqual({ op: "max", value: 0.125, unit: "s" });
    expect(budgetOf("at least 1,000 req/s")).toBeUndefined();
    expect(budgetOf("under 1.000 requêtes")).toBeUndefined();
  });

  it("states no budget when the text states two, or only an arrow", () => {
    expect(budgetOf("availability at least 99.9 % and p95 ≤ 200 ms")).toBeUndefined();
    expect(budgetOf("under 100 users, p95 < 2 s")).toBeUndefined();
    expect(budgetOf("the flow a -> 5 steps")).toBeUndefined();
    expect(budgetOf("the flow a => 5 steps")).toBeUndefined();
  });

  it("expects a measure only when there is a budget, and a CI only for the CI", () => {
    expect(proofOf("measured by a benchmark", undefined)).toBe("analysis");
    expect(proofOf("Le profil utilisateur est chiffré", undefined)).toBe("test");
    expect(proofOf("lisible, celui-ci est vérifié par les tests", undefined)).toBe("test");
    expect(proofOf("green in the CI", undefined)).toBe("ci");
  });

  it("reads a budget written on the line of the decision itself", () => {
    const text = [
      "---",
      "id: architecture",
      "kind: architecture",
      "owner: alex",
      "---",
      "# Architecture",
      "",
      "- AD-4: Replay stays fast — budget under 60 s for 1 000 000 events.",
      "",
    ].join("\n");
    const files = [{ path: ".agentplugged/docs/architecture.md", text }];
    const items = buildRegistry(
      files.map((file) => parseDocumentFile(file.path, file.text)),
      files,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "AD-4",
      budget: { op: "max", value: 60, unit: "s" },
      text: "Replay stays fast — budget under 60 s for 1 000 000 events.",
    });
  });
});

describe("which points the release gate holds", () => {
  const state = stateWith({ "ENF-2": {} });
  const hold = (type: string, status: string, phase: string | null = null) =>
    mergeHold(state, { type, status, story: null, phase } as never);

  it("holds an open release, one whose waiver ran out, and the end of the delivery phase", () => {
    expect(hold("release", "open").release).toMatchObject({ open: 1 });
    // A waived point is answerable again once its deadline is past: held as an open one is.
    expect(hold("release", "waived").release).toMatchObject({ open: 1 });
    expect(hold("phase_end", "open", "delivery").release).toMatchObject({ open: 1 });
  });

  it("holds nothing else: an answered release, another phase, another kind of point", () => {
    expect(hold("release", "resolved")).toEqual({});
    expect(hold("phase_end", "open", "design")).toEqual({});
    expect(hold("decision", "open")).toEqual({});
    expect(mergeHold({}, { type: "release", status: "open", story: null } as never)).toEqual({});
  });
});

describe("the CI and the review as proofs", () => {
  const entries = new Map(registry().map((entry) => [entry.id, stateItem(entry)]));
  const item = (id: string) => entries.get(id) as RequirementItem;
  const ci = (status: string) => ({ ci: { status } });

  it("refuses a review proof typed by hand", () => {
    expect(proofProblem(item("ENF-5"), { kind: "review", source: "x" }, null)).toBe(
      "review_comes_from_an_audit",
    );
  });

  it("takes a CI proof only from a story whose CI the engine read green", () => {
    const state = { stories: { "1-1": ci("pass"), "1-2": ci("fail"), "1-3": {} } };
    // ENF-1 is cited by stories 1-1 and 1-2.
    expect(ciProofProblem(state, item("ENF-1"), "1-1")).toBeUndefined();
    expect(ciProofProblem(state, item("ENF-1"), "1-2")).toBe("ci_not_green:fail");
    expect(ciProofProblem(state, item("ENF-1"), "1-3")).toContain("no_ci_read");
    expect(ciProofProblem(state, item("ENF-1"), "9-9")).toContain("no_ci_read");
    // A story that does not cite the requirement does not cover it.
    expect(ciProofProblem({ stories: { "2-1": ci("pass") } }, item("ENF-2"), "2-1")).toContain(
      "source_not_a_covering_story",
    );
    // A requirement no story cites takes any story's CI.
    expect(
      ciProofProblem({ stories: { "2-1": ci("pass") } }, item("ENF-4"), "2-1"),
    ).toBeUndefined();
  });
});

describe("the creator's decision on a gap, one gesture each", () => {
  const point = (extra: Record<string, unknown> = {}) => ({
    id: "G-0123456789",
    type: "decision",
    title: "Gap on ENF-2",
    status: "resolved",
    opened_at: "2026-10-09T12:00:00.000Z",
    resolution: { decision: "option_chosen", option: "accept", source: "chat" },
    ...extra,
  });
  const base = (items: Record<string, Partial<RequirementItem>>, checkpoint = point()) => ({
    ...stateWith(items),
    checkpoints: { "G-0123456789": checkpoint },
  });
  const problem = (state: ReturnType<typeof base>, requirement = "ENF-2", option = "accept") =>
    gapPointProblem(state, requirement, option, "G-0123456789");

  it("accepts a decision point the creator answered with that option, naming the requirement", () => {
    expect(problem(base({ "ENF-2": {}, "ENF-4": {} }))).toBeUndefined();
  });

  it("refuses a point an agent or the auto level answered, another option or another kind of point", () => {
    for (const source of ["agent", "auto"]) {
      const state = base(
        { "ENF-2": {} },
        point({ resolution: { decision: "option_chosen", option: "accept", source } }),
      );
      expect(problem(state), source).toContain("not_a_point_the_creator_answered");
    }
    expect(problem(base({ "ENF-2": {} }), "ENF-2", "defer")).toContain("not_a_point_the_creator");
    expect(problem(base({ "ENF-2": {} }, point({ status: "open" })))).toContain("not_a_point");
    expect(problem(base({ "ENF-2": {} }, point({ type: "document" })))).toBe(
      "not_a_decision_point",
    );
  });

  it("refuses a point that is about another requirement", () => {
    expect(problem(base({ "ENF-2": {}, "ENF-4": {} }), "ENF-4")).toBe(
      "point_title_does_not_name_ENF-4",
    );
    // « ENF-20 » is not « ENF-2 ».
    expect(problem(base({ "ENF-2": {} }, point({ title: "Gap on ENF-20" })))).toBe(
      "point_title_does_not_name_ENF-2",
    );
  });

  it("refuses a point already used, and a point older than the requirement or than its latest proof", () => {
    const used = base({
      "ENF-2": {},
      "ENF-4": {
        gap: {
          decision: "accept",
          reason: "r",
          version: null,
          checkpoint: "G-0123456789",
          at: "2026-10-09T12:30:00.000Z",
          by: "omar",
          event: "E",
        },
      },
    });
    expect(problem(used)).toBe("point_already_used");
    const failed = base({ "ENF-2": { proved: proof("2026-10-09T13:00:00.000Z", "fail") } });
    expect(problem(failed)).toBe("point_older_than_the_proof");
    const changed = base({ "ENF-2": { since: "2026-10-09T12:30:00.000Z" } });
    expect(problem(changed)).toBe("point_older_than_the_requirement");
  });
});
