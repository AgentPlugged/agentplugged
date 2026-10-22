import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  AgentPluggedError,
  type ApprovedStory,
  approvedStoryDocuments,
  type CheckpointState,
  type CommandContext,
  checkDocuments,
  checkDocumentsDetailed,
  compareStories,
  createCommandRegistry,
  type DocsBase,
  type DocsCheckResult,
  type DocumentFile,
  frozenIntents,
  initCommand,
  intentOf,
  MemoryKeyStore,
  MemoryStateStore,
  parseDocumentFile,
  parseSections,
  type RecordedEvent,
  type ReviewList,
  resolveProfile,
  type StateStore,
  storyDocumentsOf,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";

const PRD_PATH = ".agentplugged/docs/prd.md";
const EPIC_PATH = ".agentplugged/epics/epic-1.md";
const storyPath = (id: string) => `.agentplugged/stories/${id}.md`;
const owners = new Set(["maya", "izzy", "sam", "quentin"]);

const PRD = [
  "---",
  "id: prd",
  "kind: prd",
  "owner: maya",
  "---",
  "# PRD",
  "",
  "EF-1 : Ada signs in with a passkey.",
  "EF-2 : Ada exports her data as CSV.",
  "EF-3 : (retired) Ada prints her data.",
  "ENF-1 : Every page answers within a second.",
  "PU-1 : Ada's first day with the product.",
  "",
].join("\n");

function epic(extra = ""): string {
  return `---\nid: epic-1\nkind: epic\nowner: izzy\n${extra}---\n# Epic 1\n`;
}

const BODY = [
  "## Context",
  "",
  "EF-1 and the passkey flow of the UX specification.",
  "",
  "## Intent",
  "",
  "Ada signs in without a password.",
  "",
  "## Acceptance criteria",
  "",
  "- Given a passkey, when Ada signs in, then she lands on her home page.",
  "",
  "## Out of scope",
  "",
  "- Account recovery.",
  "",
].join("\n");

interface StoryOptions {
  readonly requirements?: string;
  readonly dependsOn?: string;
  readonly extra?: string;
  readonly body?: string;
}

function story(id: string, options: StoryOptions = {}): string {
  const header = [
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `title: Story ${id}`,
    `epic: epic-${id.split("-")[0]}`,
    "reviewer: quentin",
    `requirements: ${options.requirements ?? "[EF-1, EF-2, ENF-1]"}`,
    "budget_usd: 8",
    `branch: feat/${id}`,
    `depends_on: ${options.dependsOn ?? "[]"}`,
  ].join("\n");
  return `---\n${header}\n${options.extra ?? ""}---\n# Story ${id}\n\n${options.body ?? BODY}`;
}

function files(record: Record<string, string>): DocumentFile[] {
  return Object.entries(record).map(([path, text]) => ({ path, text }));
}

function check(record: Record<string, string>, approvals: readonly ApprovedStory[] = []) {
  return checkDocuments({ current: files(record), owners, approvals, onBranch: new Set() });
}

function detailed(
  record: Record<string, string>,
  approvals: readonly ApprovedStory[],
  onBranch: ReadonlySet<string> | null = new Set(),
) {
  return checkDocumentsDetailed({
    current: files(record),
    owners,
    approvals,
    onBranch: onBranch ?? undefined,
  });
}

const breakdown = (stories: Record<string, string>, extraEpic = ""): Record<string, string> => ({
  [PRD_PATH]: PRD,
  [EPIC_PATH]: epic(extraEpic),
  ...Object.fromEntries(Object.entries(stories).map(([id, text]) => [storyPath(id), text])),
});

const summary = (problems: ReturnType<typeof check>) =>
  problems.map((problem) => [problem.code, problem.details.path, problem.details.line]);

describe("the story contract (rule 7)", () => {
  it("accepts a valid breakdown (matrix: valid)", () => {
    expect(
      check(breakdown({ "1-1": story("1-1"), "1-2": story("1-2", { dependsOn: "[1-1]" }) })),
    ).toEqual([]);
  });

  it("names a missing field (matrix: missing field)", () => {
    const text = story("1-1").replace("budget_usd: 8\n", "");
    expect(check(breakdown({ "1-1": text }))).toEqual([
      {
        code: ErrorCode.DOC_HEADER_INVALID,
        message_key: "error.doc_header_invalid",
        details: {
          path: storyPath("1-1"),
          line: 1,
          field: "budget_usd",
          reason: "missing",
          reason_key: "reason.required",
        },
      },
    ]);
  });

  it("refuses the epic of another story id, once (matrix: wrong epic)", () => {
    const text = story("2-1").replace("epic: epic-2", "epic: epic-1");
    expect(check(breakdown({ "2-1": text })).map((p) => [p.code, p.details.field])).toEqual([
      [ErrorCode.DOC_HEADER_INVALID, "epic"],
    ]);
  });

  it("refuses the numbers 0 in story and epic ids", () => {
    const record = breakdown({ "1-0": story("1-0") });
    record[".agentplugged/epics/epic-0.md"] = epic().replace("id: epic-1", "id: epic-0");
    expect(check(record).map((p) => [p.code, p.details.path, p.details.field])).toEqual([
      [ErrorCode.DOC_HEADER_INVALID, ".agentplugged/epics/epic-0.md", "id"],
      [ErrorCode.DOC_HEADER_INVALID, storyPath("1-0"), "id"],
    ]);
  });

  it("refuses the template markers left in a title or a section, never in code", () => {
    const body = BODY.replace(
      "Ada signs in without a password.",
      "<why this story exists>, see `<not a marker>`.",
    ).concat('\n```\n<inside code, not a marker>\n```\n<br> and <a href="x"> are fine.\n');
    const text = story("1-1", { body }).replace("title: Story 1-1", 'title: "<one line, what>"');
    expect(check(breakdown({ "1-1": text })).map((p) => [p.code, p.details.marker])).toEqual([
      [ErrorCode.DOC_PLACEHOLDER_LEFT, "<one line, what>"],
      [ErrorCode.DOC_PLACEHOLDER_LEFT, "<why this story exists>"],
    ]);
  });

  it("refuses an epic that no document holds (matrix: missing epic)", () => {
    const record = breakdown({ "1-1": story("1-1") });
    delete record[EPIC_PATH];
    expect(check(record).map((p) => [p.code, p.message_key, p.details.link])).toEqual([
      [ErrorCode.DOC_LINK_DANGLING, "error.doc_link_dangling.epic", "epic-1"],
    ]);
  });

  it("refuses a status, an unknown reviewer, and requirements or stories that do not exist", () => {
    const text = story("1-2", {
      requirements: "[EF-1, EF-2, ENF-1, EF-3, EF-9]",
      dependsOn: "[9-9]",
    })
      .replace("reviewer: quentin", "reviewer: nobody")
      .replace("budget_usd: 8", "budget_usd: 8\nstatus: done");
    const problems = check(breakdown({ "1-2": text }));
    expect(problems.map((p) => [p.code, p.details.field, p.details.link])).toEqual([
      [ErrorCode.DOC_HEADER_INVALID, "reviewer", undefined],
      [ErrorCode.DOC_LINK_DANGLING, "requirements", "EF-3"],
      [ErrorCode.DOC_LINK_DANGLING, "requirements", "EF-9"],
      [ErrorCode.DOC_HEADER_INVALID, "status", undefined],
      [ErrorCode.DOC_LINK_DANGLING, "depends_on", "9-9"],
    ]);
    expect(problems.find((p) => p.details.link === "9-9")?.message_key).toBe(
      "error.doc_link_dangling.story",
    );
  });

  it("names each missing, empty or doubled section (matrix: missing section)", () => {
    const body = BODY.replace("## Intent", "## Notes")
      .replace("- Account recovery.", "")
      .concat("\n## Context\n\nAgain.\n");
    const problems = check(breakdown({ "1-1": story("1-1", { body }) }));
    expect(problems.map((p) => [p.code, p.message_key, p.details.section])).toEqual([
      [ErrorCode.STORY_SECTION_INVALID, "error.story_section_invalid.missing", "intent"],
      [ErrorCode.STORY_SECTION_INVALID, "error.story_section_invalid.empty", "out_of_scope"],
      [ErrorCode.STORY_SECTION_INVALID, "error.story_section_invalid.duplicate", "context"],
    ]);
  });

  it("accepts the French section titles, in any case", () => {
    const body = BODY.replace("## Context", "## Contexte")
      .replace("## Intent", "## INTENTION")
      .replace("## Acceptance criteria", "## Critères d’acceptation")
      .replace("## Out of scope", "## Hors périmètre");
    expect(check(breakdown({ "1-1": story("1-1", { body }) }))).toEqual([]);
  });

  it("leaves a story of another kind to the folder rule", () => {
    const record = breakdown({});
    record[storyPath("1-1")] = "---\nid: s-1\nkind: note\nowner: izzy\n---\n# Note\n";
    expect(check(record).map((p) => p.code)).toEqual([ErrorCode.DOC_KIND_MISMATCH]);
  });
});

describe("the coverage of the PRD (rule 8)", () => {
  it("names each active EF and ENF no story covers (matrix: not covered)", () => {
    const problems = check(breakdown({ "1-1": story("1-1", { requirements: "[EF-1]" }) }));
    expect(summary(problems)).toEqual([
      [ErrorCode.REQ_NOT_COVERED, PRD_PATH, 9],
      [ErrorCode.REQ_NOT_COVERED, PRD_PATH, 11],
    ]);
    expect(problems.map((p) => p.details.id)).toEqual(["EF-2", "ENF-1"]);
  });

  it("counts an epic's out_of_scope as covered (matrix: out of scope)", () => {
    const record = breakdown(
      { "1-1": story("1-1", { requirements: "[EF-1]" }) },
      "out_of_scope: [EF-2, ENF-1]\n",
    );
    expect(check(record)).toEqual([]);
  });

  it("refuses an out_of_scope that names no active requirement", () => {
    const record = breakdown({ "1-1": story("1-1") }, "out_of_scope: [EF-3]\n");
    expect(check(record).map((p) => [p.code, p.details.field, p.details.link])).toEqual([
      [ErrorCode.DOC_LINK_DANGLING, "out_of_scope", "EF-3"],
    ]);
  });

  it("does not check coverage before the first story (matrix: no stories)", () => {
    expect(check({ [PRD_PATH]: PRD })).toEqual([]);
  });

  it("counts only the stories kept: a second story of the same id covers nothing", () => {
    const record = breakdown({ "1-1": story("1-1", { requirements: "[EF-1, ENF-1]" }) });
    record[".agentplugged/stories/z-copy.md"] = story("1-1");
    expect(check(record).map((p) => [p.code, p.details.id])).toEqual([
      [ErrorCode.REQ_NOT_COVERED, "EF-2"],
      [ErrorCode.DOC_ID_DUPLICATE, "1-1"],
    ]);
  });
});

describe("the dependency graph (rule 9)", () => {
  it("orders stories by epic, then number, as numbers", () => {
    expect(["2-1", "1-10", "1-9", "10-1"].sort(compareStories)).toEqual([
      "1-9",
      "1-10",
      "2-1",
      "10-1",
    ]);
  });

  it("refuses a dependency on a later story (matrix: future story)", () => {
    const problems = check(
      breakdown({ "1-1": story("1-1", { dependsOn: "[1-2]" }), "1-2": story("1-2") }),
    );
    expect(problems).toEqual([
      {
        code: ErrorCode.STORY_DEPENDENCY_FORWARD,
        message_key: "error.story_dependency_forward",
        details: { path: storyPath("1-1"), line: 11, story: "1-1", dependency: "1-2" },
      },
    ]);
  });

  it("reports a loop once, with its stories in order (matrix: cycle)", () => {
    const problems = check(
      breakdown({
        "1-1": story("1-1"),
        "1-2": story("1-2", { dependsOn: "[1-1, 1-3]" }),
        "1-3": story("1-3", { dependsOn: "[1-2]" }),
      }),
    );
    expect(
      problems.map((p) => [p.code, p.details.path, p.details.cycle ?? p.details.dependency]),
    ).toEqual([
      [ErrorCode.STORY_DEPENDENCY_CYCLE, storyPath("1-2"), ["1-2", "1-3"]],
      [ErrorCode.STORY_DEPENDENCY_FORWARD, storyPath("1-2"), "1-3"],
    ]);
  });

  it("reports a story that depends on itself as a loop", () => {
    const problems = check(breakdown({ "1-1": story("1-1", { dependsOn: "[1-1]" }) }));
    expect(problems.map((p) => [p.code, p.details.cycle])).toEqual([
      [ErrorCode.STORY_DEPENDENCY_CYCLE, ["1-1"]],
    ]);
  });

  it("accepts a dependency on an earlier epic", () => {
    const record = {
      ...breakdown({ "1-1": story("1-1") }),
      ".agentplugged/epics/epic-2.md": epic().replace("epic-1", "epic-2"),
      [storyPath("2-1")]: story("2-1", { dependsOn: "[1-1]" }),
    };
    expect(check(record)).toEqual([]);
  });
});

describe("sections", () => {
  it("runs a section up to the next level 1 or 2 heading, code fences included", () => {
    const sections = parseSections(
      "## Intent\n\nKeep it.\n### Detail\n```\n## not a heading\n```\n# Top\nnone\n## Next\nx\n",
      10,
    );
    expect(sections).toEqual([
      {
        title: "intent",
        line: 10,
        lines: ["", "Keep it.", "### Detail", "```", "## not a heading", "```"],
      },
      { title: "next", line: 19, lines: ["x", ""] },
    ]);
  });

  it("reads setext headings: `---` opens a section, `===` ends it", () => {
    const sections = parseSections("Intent\n---\nKeep it.\n\nTop\n===\nnone\n- item\n---\n", 1);
    expect(sections.map((section) => [section.title, section.line])).toEqual([["intent", 1]]);
    expect(sections[0]?.lines).toEqual(["Keep it.", ""]);
  });

  it("accepts a story whose sections are setext headings", () => {
    const body = BODY.replace(/^## (.+)$/gm, "$1\n---");
    expect(check(breakdown({ "1-1": story("1-1", { body }) }))).toEqual([]);
  });

  it("compares an intent without trailing spaces, line endings or outer blank lines", () => {
    const a = parseDocumentFile(storyPath("1-1"), story("1-1"));
    const b = parseDocumentFile(
      storyPath("1-1"),
      story("1-1")
        .replace("Ada signs in without a password.", "\n\nAda signs in without a password.   ")
        .replaceAll("\n", "\r\n"),
    );
    expect(intentOf(a)).toBe("Ada signs in without a password.");
    expect(intentOf(b)).toBe(intentOf(a));
  });
});

describe("frozen intents (rule 10)", () => {
  const BLOB = "a".repeat(40);
  const approval = (overrides: Partial<ApprovedStory> = {}): ApprovedStory => ({
    checkpoint: "G-0000000001",
    path: storyPath("1-1"),
    blob: BLOB,
    state: "read",
    story: "1-1",
    intent: "Ada signs in without a password.",
    ...overrides,
  });
  const missing = (overrides: Partial<ApprovedStory> = {}) =>
    approval({ state: "missing", story: undefined, intent: undefined, ...overrides });
  const reasons = (result: ReturnType<typeof detailed>) => ({
    problems: result.problems.map((p) => [p.code, p.details.reason, p.details.path]),
    // The stories here are in the former format, without excerpts: that warning is not about intents.
    warnings: result.warnings
      .filter((w) => w.reason !== "sheet_legacy")
      .map((w) => [w.reason, w.details.story ?? null]),
    compared: result.compared,
  });

  it("accepts an unchanged intent, whatever the other sections (matrix: other section)", () => {
    const text = story("1-1").replace("- Account recovery.", "- Account recovery, and export.");
    expect(reasons(detailed(breakdown({ "1-1": text }), [approval()]))).toEqual({
      problems: [],
      warnings: [],
      compared: 1,
    });
  });

  it("refuses a changed intent (matrix: intent changed)", () => {
    const text = story("1-1").replace("without a password", "with a password");
    expect(check(breakdown({ "1-1": text }), [approval()])).toEqual([
      {
        code: ErrorCode.STORY_INTENT_CHANGED,
        message_key: "error.story_intent_changed.changed",
        details: {
          path: storyPath("1-1"),
          line: 19,
          story: "1-1",
          checkpoint: "G-0000000001",
          reason: "changed",
          approved_path: storyPath("1-1"),
          blob: BLOB,
        },
      },
    ]);
  });

  it("takes the last approval of a story (matrix: new approval)", () => {
    const text = story("1-1").replace("without a password", "with a passkey only");
    const later = approval({
      checkpoint: "G-0000000002",
      blob: "b".repeat(40),
      intent: "Ada signs in with a passkey only.",
    });
    expect(check(breakdown({ "1-1": text }), [approval(), later])).toEqual([]);
  });

  it("reports a frozen story removed only from a branch that held it", () => {
    const record = breakdown({ "1-2": story("1-2") });
    expect(reasons(detailed(record, [approval()], new Set([BLOB])))).toEqual({
      problems: [[ErrorCode.STORY_INTENT_CHANGED, "removed", storyPath("1-1")]],
      warnings: [],
      compared: 0,
    });
    // `main` before the breakdown was merged: this branch never had the story.
    expect(reasons(detailed(record, [approval()], new Set()))).toEqual({
      problems: [],
      warnings: [["not_on_branch", "1-1"]],
      compared: 0,
    });
    // The history could not be read: a warning, never a failure.
    expect(reasons(detailed(record, [approval()], null))).toEqual({
      problems: [],
      warnings: [["history_unreadable", "1-1"]],
      compared: 0,
    });
  });

  it("reports an approved version without an intent section, never freezes an empty intent", () => {
    const noIntent = approval({ state: "no_intent", intent: undefined });
    expect(reasons(detailed(breakdown({ "1-1": story("1-1") }), [noIntent]))).toEqual({
      problems: [[ErrorCode.STORY_INTENT_CHANGED, "no_intent", storyPath("1-1")]],
      warnings: [],
      compared: 0,
    });
  });

  it("warns, never fails, on an approved blob Git does not hold (matrix: missing blob)", () => {
    expect(reasons(detailed(breakdown({ "1-1": story("1-1") }), [missing()]))).toEqual({
      problems: [],
      warnings: [["blob_missing", "1-1"]],
      compared: 0,
    });
    // A path no story holds: still a warning.
    const elsewhere = missing({ path: ".agentplugged/stories/sign-in.md" });
    expect(reasons(detailed(breakdown({ "1-1": story("1-1") }), [elsewhere]))).toEqual({
      problems: [],
      warnings: [["blob_missing", null]],
      compared: 0,
    });
  });

  it("clears an older unreadable approval with a newer readable one, same path or renamed", () => {
    const text = story("1-1");
    // Unreadable, then readable at the same path: no problem, no warning.
    expect(reasons(detailed(breakdown({ "1-1": text }), [missing(), approval()]))).toEqual({
      problems: [],
      warnings: [],
      compared: 1,
    });
    // The story moved: the older approval listed another path, the newer one names the story.
    // Its file name still starts with the story id, as the method names stories.
    const renamed = missing({ path: ".agentplugged/stories/1-1-sign-in.md" });
    expect(reasons(detailed(breakdown({ "1-1": text }), [renamed, approval()]))).toEqual({
      problems: [],
      warnings: [],
      compared: 1,
    });
  });

  it("compares with the older readable approval when the newer one cannot be read", () => {
    const newer = missing({ checkpoint: "G-0000000002", blob: "b".repeat(40) });
    // The older one verifies: a warning only.
    expect(reasons(detailed(breakdown({ "1-1": story("1-1") }), [approval(), newer]))).toEqual({
      problems: [],
      warnings: [["blob_missing", "1-1"]],
      compared: 1,
    });
    // It differs: the newer approval may allow it, so a warning, never a failure.
    const text = story("1-1").replace("without a password", "with a passkey only");
    expect(reasons(detailed(breakdown({ "1-1": text }), [approval(), newer]))).toEqual({
      problems: [],
      warnings: [
        ["blob_missing", "1-1"],
        ["intent_unverified", "1-1"],
      ],
      compared: 1,
    });
  });

  it("reads the approved blobs: missing, without intent, or read", () => {
    const approved = [
      { checkpoint: "G-1", path: storyPath("1-1"), blob: BLOB },
      { checkpoint: "G-1", path: storyPath("1-2"), blob: "c".repeat(40) },
      { checkpoint: "G-1", path: storyPath("1-3"), blob: "d".repeat(40) },
      { checkpoint: "G-1", path: storyPath("1-4"), blob: "f".repeat(40) },
    ];
    const blobs = new Map([
      [BLOB, story("1-1")],
      ["d".repeat(40), "---\nid: n\nkind: note\nowner: izzy\n---\n"],
      ["f".repeat(40), story("1-4", { body: BODY.replace("## Intent", "## Notes") })],
    ]);
    expect(
      frozenIntents(approved, blobs).map((entry) => [entry.state, entry.story, entry.intent]),
    ).toEqual([
      ["read", "1-1", "Ada signs in without a password."],
      ["missing", undefined, undefined],
      ["no_intent", undefined, undefined],
      ["no_intent", "1-4", undefined],
    ]);
  });

  it("keeps only the stories of approved document checkpoints, in the order of the answers", () => {
    const at = (iso: string) => Date.parse(iso);
    const base = {
      type: "document",
      status: "resolved",
      documents: [
        { path: storyPath("1-1"), branch: "plan", blob_sha: BLOB },
        { path: EPIC_PATH, branch: "plan", blob_sha: "e".repeat(40) },
      ],
    };
    const checkpoint = (id: string, decision: string, when: string, extra = {}) =>
      ({
        ...base,
        id,
        resolution: { decision, at: when, event: `E${id}` },
        ...extra,
      }) as unknown as CheckpointState;
    const list = [
      checkpoint("G-2", "approved", "2026-10-03T12:00:00Z"),
      checkpoint("G-1", "approved_with_reservations", "2026-10-02T12:00:00Z"),
      checkpoint("G-3", "rejected", "2026-10-04T12:00:00Z"),
      checkpoint("G-4", "approved", "2026-10-04T12:00:00Z", { type: "story" }),
      {
        ...checkpoint("G-5", "approved", "2026-10-04T12:00:00Z"),
        status: "open",
        resolution: null,
      },
    ];
    expect(
      approvedStoryDocuments(list as CheckpointState[], at("2026-10-05T00:00:00Z")).approved.map(
        (entry) => entry.checkpoint,
      ),
    ).toEqual(["G-1", "G-2"]);
  });

  it("normalises the paths and blob ids a checkpoint lists, and reports a story path elsewhere", () => {
    const checkpoint = {
      id: "G-1",
      documents: [
        { path: ".agentplugged\\stories\\1-1.md", branch: "plan", blob_sha: "A".repeat(40) },
        { path: "product/.agentplugged/stories/1-2.md", branch: "plan", blob_sha: BLOB },
        { path: "stories/1-3.md", branch: "plan", blob_sha: BLOB },
        { path: EPIC_PATH, branch: "plan", blob_sha: BLOB },
      ],
    } as unknown as CheckpointState;
    expect(storyDocumentsOf(checkpoint)).toEqual({
      stories: [
        { checkpoint: "G-1", path: storyPath("1-1"), blob: "a".repeat(40) },
        { checkpoint: "G-1", path: storyPath("1-2"), blob: BLOB },
      ],
      mismatched: [{ checkpoint: "G-1", path: "stories/1-3.md" }],
    });
  });
});

describe("docs check with the journal", () => {
  const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
  const NO_TOOL: ToolProbe = {
    which: async () => undefined,
    version: async () => undefined,
    extensions: async () => [],
  };
  const APPROVED = "a".repeat(40);
  const AGAIN = "b".repeat(40);

  async function product() {
    const files = new MemoryFiles();
    let clock = NOW;
    const now = () => {
      clock += 1000;
      return clock;
    };
    const keys = new MemoryKeyStore(toBase64url(new Uint8Array(32).fill(9)));
    const journal = new MemoryStateStore({ keys, now });
    const blobs = new Map<string, string>();
    const history = new Set<string>();
    const docsBase: DocsBase = {
      read: async () => ({ found: false, reason: "no_commit" }),
      readBlobs: async (ids) =>
        new Map(ids.flatMap((id) => (blobs.has(id) ? [[id, blobs.get(id) ?? ""]] : []))),
      blobsInHistory: async (ids) => new Set(ids.filter((id) => history.has(id))),
    };
    const human: CommandContext = {
      files,
      tools: NO_TOOL,
      method: shippedMethod(),
      actor: "human",
      engineVersion: "1.0.0",
      journal,
      now,
      interactive: true,
      human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
      docsBase,
    };
    const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
    if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
    const synced = await syncCommand.run(human, {});
    if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
    const registry = createCommandRegistry();
    const agent: CommandContext = { ...human, actor: "agent", human: undefined };
    const reader: CommandContext = { ...human, human: undefined };
    const open = async (blob: string) => {
      const opened = await registry.run("open_checkpoint", agent, {
        agent: "main",
        type: "document",
        risk: "low",
        title: "Validate the breakdown of epic 1",
        summary: "Epic 1 and its story.",
        documents: [{ path: storyPath("1-1"), branch: "plan/epic-1", blob_sha: blob }],
      });
      if (!opened.ok) throw new Error(`open failed: ${opened.error.code}`);
      return (opened.value as RecordedEvent).checkpoint as string;
    };
    const answer = async (checkpoint: string, decision: string) => {
      const answered = await registry.run("review", human, {
        action: "resolve",
        checkpoint,
        decision,
        ...(decision === "approved" ? {} : { note: "Not yet." }),
      });
      if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
    };
    const docsCheck = async (context: CommandContext = reader) => {
      const result = await registry.run("docs", context, { action: "check" });
      if (!result.ok) throw new Error(`docs failed: ${result.error.code}`);
      const value = result.value as DocsCheckResult;
      // The stories here are in the former format: that warning is not what these tests read.
      return { ...value, warnings: value.warnings.filter((w) => w.reason !== "sheet_legacy") };
    };
    const list = async () => {
      const result = await registry.run("review", human, { action: "list" });
      if (!result.ok) throw new Error(`review list failed: ${result.error.code}`);
      return result.value as ReviewList;
    };
    for (const [path, text] of Object.entries(breakdown({ "1-1": story("1-1") }))) {
      files.seed(path, text);
    }
    blobs.set(APPROVED, story("1-1"));
    history.add(APPROVED);
    return { files, blobs, open, answer, docsCheck, list, reader, docsBase };
  }

  it("freezes the intent once the creator approves, and refuses a change after", async () => {
    const { files, open, answer, docsCheck } = await product();
    const checkpoint = await open(APPROVED);
    // Open, nothing is frozen yet (matrix: not approved).
    files.seed(storyPath("1-1"), story("1-1").replace("without a password", "with a password"));
    expect(await docsCheck()).toMatchObject({ intents: { compared: 0 }, problems: [] });
    await answer(checkpoint, "approved");
    const after = await docsCheck();
    expect(after.intents).toEqual({ compared: 1 });
    expect(after.problems.map((p) => [p.code, p.details.checkpoint])).toEqual([
      [ErrorCode.STORY_INTENT_CHANGED, checkpoint],
    ]);
    // Back to the approved intent: nothing to report.
    files.seed(storyPath("1-1"), story("1-1"));
    expect((await docsCheck()).problems).toEqual([]);
  });

  it("freezes nothing on a refusal, and lets a new approval change the intent", async () => {
    const { files, blobs, open, answer, docsCheck } = await product();
    const changed = story("1-1").replace("without a password", "with a passkey only");
    blobs.set(AGAIN, changed);
    // Refused outright: nothing frozen, the intent may still change.
    await answer(await open(APPROVED), "rejected");
    files.seed(storyPath("1-1"), changed);
    expect(await docsCheck()).toMatchObject({ intents: { compared: 0 }, problems: [] });
    await answer(await open(APPROVED), "approved");
    expect((await docsCheck()).problems.map((p) => p.code)).toEqual([
      ErrorCode.STORY_INTENT_CHANGED,
    ]);
    await answer(await open(AGAIN), "changes_requested");
    expect((await docsCheck()).problems.map((p) => p.code)).toEqual([
      ErrorCode.STORY_INTENT_CHANGED,
    ]);
    await answer(await open(AGAIN), "approved");
    expect((await docsCheck()).problems).toEqual([]);
  });

  it("warns on an approved blob the repository does not hold (matrix: missing blob)", async () => {
    const { open, answer, docsCheck } = await product();
    await answer(await open("c".repeat(40)), "approved");
    const result = await docsCheck();
    expect(result.problems).toEqual([]);
    expect(result.warnings.map((w) => w.reason)).toEqual(["blob_missing"]);
  });

  it("keeps rules 1 to 9 when rule 10's inputs cannot be read", async () => {
    const { files, open, answer, docsCheck, reader, docsBase } = await product();
    await answer(await open(APPROVED), "approved");
    // A rule 7 problem, to show that the other rules still run.
    files.seed(storyPath("1-1"), story("1-1").replace("reviewer: quentin", "reviewer: nobody"));
    const failing = (error: Error): DocsBase => ({
      ...docsBase,
      readBlobs: async () => {
        throw error;
      },
    });
    const cases: [string, CommandContext, string][] = [
      [
        "no Git binary",
        {
          ...reader,
          docsBase: failing(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" })),
        },
        "Git",
      ],
      [
        "unreadable journal",
        {
          ...reader,
          journal: {
            ...(reader.journal as StateStore),
            list: async () => {
              throw new Error("bad pack");
            },
          },
        },
        "journal",
      ],
    ];
    for (const [name, context, source] of cases) {
      const result = await docsCheck(context);
      expect(
        result.problems.map((p) => p.details.field),
        name,
      ).toEqual(["reviewer"]);
      expect(
        result.warnings.map((w) => [w.reason, w.details.source]),
        name,
      ).toEqual([["unverified", source]]);
    }
    // A broken method.yaml: the same.
    files.seed(".agentplugged/method.yaml", "format_version: [\n");
    const broken = await docsCheck();
    expect(broken.problems.map((p) => p.details.field)).toEqual(["reviewer"]);
    expect(broken.warnings.map((w) => [w.reason, w.details.source])).toEqual([
      ["unverified", "journal"],
    ]);
  });

  it("finds nothing approved without Git or without a journal branch", async () => {
    const { reader, docsCheck } = await product();
    const noGit: CommandContext = {
      ...reader,
      journal: {
        ...(reader.journal as StateStore),
        list: async () => {
          throw new AgentPluggedError(ErrorCode.NOT_A_GIT_REPO, "error.not_a_git_repo", {});
        },
      },
    };
    expect(await docsCheck(noGit)).toMatchObject({
      intents: { compared: 0 },
      warnings: [],
      problems: [],
    });
    // A fresh journal (no branch yet): nothing approved, no warning.
    const fresh: CommandContext = {
      ...reader,
      journal: new MemoryStateStore({ keys: new MemoryKeyStore(toBase64url(new Uint8Array(32))) }),
    };
    expect(await docsCheck(fresh)).toMatchObject({ intents: { compared: 0 }, warnings: [] });
  });

  it("shows on the review card what approving freezes, and what it changes", async () => {
    const { blobs, open, answer, list } = await product();
    const first = await open(APPROVED);
    expect((await list()).intents?.[first]).toEqual([
      {
        path: storyPath("1-1"),
        story: "1-1",
        intent: ["Ada signs in without a password."],
        more: false,
        status: "new",
        frozen_by: null,
      },
    ]);
    await answer(first, "approved");
    blobs.set(AGAIN, story("1-1").replace("without a password", "with a passkey only"));
    const second = await open(AGAIN);
    expect((await list()).intents?.[second]?.map((p) => [p.status, p.frozen_by])).toEqual([
      ["changes", first],
    ]);
  });
});
