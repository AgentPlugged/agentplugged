import { toBase64url } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { ErrorCode, type PhaseId, type ReadinessFinding } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { versionsOf } from "../critique/critique-rules.js";
import { checkDocuments } from "../docs/check-docs.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import {
  type AgentNextResult,
  type CommandContext,
  createCommandRegistry,
  createUlidFactory,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type ReadyResult,
  type RecordedEvent,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";
import {
  analyse,
  gateOf,
  gatePassed,
  type ReadyCopy,
  stackOf,
  validateReadyReport,
  verdictOf,
} from "./readiness-rules.js";

/**
 * The readiness gate: what the engine computes, the closed report of the agent, the
 * verdict, the decision a blocking one opens, the creator's gestures, and what `next` proposes.
 */

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};
const SEED = toBase64url(new Uint8Array(32).fill(9));

const PRD_PATH = ".agentplugged/docs/prd.md";
const ARCH_PATH = ".agentplugged/docs/architecture.md";
const UX_PATH = ".agentplugged/docs/ux.md";

const doc = (kind: string, owner: string, body: string[]) =>
  [
    "---",
    `id: ${kind}`,
    `kind: ${kind}`,
    `owner: ${owner}`,
    "---",
    `# ${kind}`,
    "",
    ...body,
    "",
  ].join("\n");

const PRD = doc("prd", "iris", [
  "## Exports",
  "",
  "- EF-1: The visitor exports their data.",
  "- EF-2: The visitor deletes their account.",
  "- ENF-1: A page answers in at most 300 ms, measured by `pnpm bench`.",
  "- PU-1: The visitor exports then leaves.",
]);
const UX = doc("ux", "iris", ["## Screens", "", "The export screen (PU-1)."]);
const ARCH = doc("architecture", "iris", ["## Storage", "", "Data lives in one file per account."]);

const story = (id: string, requirements: string[], text = "") =>
  [
    "---",
    `id: ${id}`,
    "kind: story",
    "owner: sam",
    `requirements: [${requirements.join(", ")}]`,
    "---",
    `# Story ${id}`,
    "",
    text,
    "",
  ].join("\n");

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

async function product() {
  const files = new MemoryFiles();
  let clock = Date.UTC(2026, 9, 13, 9, 0, 0);
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now, newId: createUlidFactory({ now }) });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...shippedAgent("sam", "Sam", "code", "build"),
      ...shippedAgent("quentin", "Quentin", "quality", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const init = await initCommand.run(human, { profile: resolveProfile("new-product") });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const synced = await syncCommand.run(human, {});
  if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  const agent: CommandContext = { ...human, actor: "agent", human: undefined };
  const registry = createCommandRegistry();
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const run = async <T = unknown>(name: string, input: Record<string, unknown>) => {
    const result = await call(name, input);
    if (!result.ok) {
      throw new Error(
        `${name} failed: ${result.error.code} ${JSON.stringify(result.error.details)}`,
      );
    }
    return result.value as T;
  };
  const approve = async (checkpoint: string | undefined, extra: Record<string, unknown> = {}) => {
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision: "approved",
      ...extra,
    });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  };
  const closers: Partial<Record<PhaseId, string>> = {
    framing: "iris",
    planning: "main",
    design: "main",
  };
  for (const phase of ["framing", "planning", "design"] as const) {
    const opened = await run<RecordedEvent>("open_checkpoint", {
      agent: closers[phase],
      type: "phase_end",
      phase,
      risk: "low",
      title: `End of ${phase}`,
      summary: "Ready.",
    });
    await approve(opened.checkpoint);
  }
  files.seed(PRD_PATH, PRD);
  files.seed(ARCH_PATH, ARCH);
  files.seed(UX_PATH, UX);
  files.seed(".agentplugged/stories/1-1-export.md", story("1-1", ["EF-1"]));
  /** The creator validates the document as it is now. */
  const validate = async (path: string) => {
    const text = await files.readText(path);
    const opened = await run<RecordedEvent>("open_checkpoint", {
      agent: "iris",
      type: "document",
      risk: "low",
      title: "Document to validate",
      summary: "Ready.",
      documents: [{ path, branch: "main", blob_sha: versionsOf(text)[0] }],
    });
    await approve(opened.checkpoint);
  };
  const validateAll = async () => {
    for (const path of [PRD_PATH, ARCH_PATH, UX_PATH]) await validate(path);
  };
  const ready = (input: Record<string, unknown> = {}) =>
    run<ReadyResult>("ready", { agent: "quentin", ...input });
  const next = () => run<AgentNextResult>("next", {});
  return {
    files,
    journal,
    call,
    run,
    ready,
    next,
    validate,
    validateAll,
    approve,
    registry,
    human,
  };
}

const errorOf = (result: { ok: boolean; error?: unknown }) =>
  result.ok ? undefined : (result.error as { code: string; details: Record<string, unknown> });

const CONFLICT: ReadinessFinding = {
  severity: "blocking",
  kind: "conflict",
  claim: "The PRD wants an export, the architecture keeps one file per account.",
  passages: ["prd: EF-1", "architecture: Storage"],
  proposal: "Say in the architecture how an export reads those files.",
};
const SUMMARY = "Read the PRD and the architecture: an export has no recorded source.";

describe("what the engine computes", () => {
  const copyOf = (files: Record<string, string>, problems: ReadyCopy["problems"] = []) =>
    ({
      documents: Object.entries(files).map(([path, text]) => parseDocumentFile(path, text)),
      texts: new Map(Object.entries(files)),
      problems,
      needsUx: true,
    }) satisfies ReadyCopy;

  const epic = (outOfScope: string[] = []) =>
    [
      "---",
      "id: epic-1",
      "kind: epic",
      "owner: izzy",
      `out_of_scope: [${outOfScope.join(", ")}]`,
      "---",
      "# Epic 1",
      "",
    ].join("\n");

  it("traces both ways: journeys and decisions no story cites, a story that traces to nothing", () => {
    const arch = doc("architecture", "iris", ["## Decisions", "", "- AD-1: One file per account."]);
    const copy = copyOf({
      [PRD_PATH]: PRD,
      [ARCH_PATH]: arch,
      ".agentplugged/epics/epic-1.md": epic(),
      ".agentplugged/stories/1-1-export.md": story("1-1", ["EF-1"]),
      ".agentplugged/stories/1-2-loose.md": story("1-2", []),
    });
    const keys = analyse(copy, {}, 0).findings.map((f) => f.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "journey_orphan:PU-1",
        "decision_orphan:AD-1",
        "story_orphan:1-2",
        "doc_unvalidated:prd",
        "doc_unvalidated:architecture",
      ]),
    );
    const minor = analyse(copy, {}, 0).findings.find((f) => f.key === "decision_orphan:AD-1");
    expect(minor?.severity).toBe("minor");
  });

  it("clears the orphans a story or an epic cites", () => {
    const arch = doc("architecture", "iris", ["## Decisions", "", "- AD-1: One file per account."]);
    const copy = copyOf({
      [PRD_PATH]: PRD,
      [ARCH_PATH]: arch,
      ".agentplugged/epics/epic-1.md": epic(["EF-2"]),
      ".agentplugged/stories/1-1-export.md": story("1-1", ["EF-1", "AD-1"], "Delivers PU-1."),
    });
    const keys = analyse(copy, {}, 0).findings.map((f) => f.key);
    expect(keys.filter((k) => /orphan/.test(k))).toEqual([]);
  });

  it("lists a UX element no story carries as a finding of its own, not as a bare docs check code", () => {
    const ux = doc("ux", "iris", [
      "## Elements",
      "",
      "| Id | Kind | Element |",
      "| --- | --- | --- |",
      "| UX-1 | component | Export button |",
      "| UX-2 | state | Empty export |",
    ]);
    const files = {
      [PRD_PATH]: PRD,
      [UX_PATH]: ux,
      ".agentplugged/epics/epic-1.md": epic(["EF-2"]),
      ".agentplugged/stories/1-1-export.md": story("1-1", ["EF-1"], "## Context\n\n- PU-1, UX-1."),
    };
    const problems = checkDocuments({
      current: Object.entries(files).map(([path, text]) => ({ path, text })),
      owners: new Set(["iris", "sam"]),
    });
    expect(problems.map((p) => p.details.reason)).toContain("ux_element_uncovered");
    const found = analyse(copyOf(files, problems), {}, 0).findings;
    const keys = found.map((f) => f.key);
    expect(keys).toContain("ux_element_orphan:UX-2");
    expect(keys).not.toContain("ux_element_orphan:UX-1");
    expect(keys.filter((k) => k.startsWith("docs_check:LAUNCH_DOCUMENT_INVALID"))).toEqual([]);
    const orphan = found.find((f) => f.key === "ux_element_orphan:UX-2");
    expect(orphan).toMatchObject({ severity: "should_fix", owner: "izzy", origin: "engine" });
  });

  it("reports an identifier cited and defined nowhere, once, and a requirement no story carries", () => {
    const base = {
      code: ErrorCode.DOC_LINK_DANGLING,
      message_key: "x",
    };
    const copy = copyOf(
      {
        [PRD_PATH]: PRD,
        ".agentplugged/stories/1-1-export.md": story("1-1", ["EF-9"]),
      },
      [
        {
          ...base,
          details: { path: ".agentplugged/stories/1-1-export.md", line: 5, link: "EF-9" },
        },
        {
          ...base,
          details: { path: ".agentplugged/stories/1-2.md", line: 5, link: "EF-9" },
        },
        {
          code: ErrorCode.REQ_NOT_COVERED,
          message_key: "y",
          details: { path: PRD_PATH, line: 9, id: "ENF-1" },
        },
      ],
    );
    const found = analyse(copy, {}, 0).findings;
    const unknown = found.filter((f) => f.key.startsWith("unknown_id:"));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.text).toContain("(+1 more)");
    expect(unknown[0]?.severity).toBe("blocking");
    expect(found.find((f) => f.key === "req_uncovered:ENF-1")?.severity).toBe("should_fix");
  });

  it("before the stories are cut, traces nothing yet; the short path stands on its spec", () => {
    const before = analyse(copyOf({ [PRD_PATH]: PRD, [ARCH_PATH]: ARCH }), {}, 0);
    expect(before.inventory.stage).toBe("breakdown");
    expect(before.findings.some((f) => /orphan|uncovered/.test(f.key))).toBe(false);
    const spec = doc("spec", "iris", ["- EF-1: The visitor exports their data."]);
    const short = analyse(
      copyOf({ ".agentplugged/docs/spec.md": spec }),
      { skips: { full_path: { step: "full_path" } } },
      0,
    );
    expect(short.inventory.track).toBe("short");
    expect(short.findings.map((f) => f.key)).toEqual(["doc_unvalidated:spec"]);
  });

  it("computes the verdict from what is left open", () => {
    expect(verdictOf([])).toBe("ready");
    expect(verdictOf([{ severity: "minor" }])).toBe("ready");
    expect(verdictOf([{ severity: "minor" }, { severity: "should_fix" }])).toBe("reserves");
    expect(verdictOf([{ severity: "should_fix" }, { severity: "blocking" }])).toBe("blocking");
  });

  it("bounds the list it shows and counts the rest", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      key: `k${i}`,
      severity: "minor" as const,
      origin: "engine" as const,
      text: "x",
      owner: "izzy",
      fix: "y",
    }));
    const { lines, more } = stackOf(many);
    expect(lines).toHaveLength(12);
    expect(more).toBe(8);
  });
});

describe("the closed report of the agent", () => {
  const copy: ReadyCopy = {
    documents: [PRD_PATH, ARCH_PATH].map((p) => parseDocumentFile(p, p === PRD_PATH ? PRD : ARCH)),
    texts: new Map([
      [PRD_PATH, PRD],
      [ARCH_PATH, ARCH],
    ]),
    problems: [],
    needsUx: true,
  };

  it("lists what is missing: passages in documents and in the text, proposals, summary", () => {
    const problems = validateReadyReport(
      {
        agent: "quentin",
        summary: "short",
        findings: [
          { severity: "blocking", kind: "conflict", claim: "x", passages: ["prd: EF-1"] },
          { severity: "minor", kind: "gap", claim: "x", passages: ["ux: Screens"] },
          { severity: "minor", kind: "gap", claim: "x", passages: ["prd: EF-77"] },
          { severity: "minor", kind: "gap", claim: "x", passages: ["no colon"] },
        ],
      },
      copy,
      "full",
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        "summary_missing",
        "conflict_one_document:1",
        "proposal_missing:1",
        "document_unknown:2.1",
        "passage_unknown:3.1",
        "passage_format:4.1",
      ]),
    );
  });

  it("accepts a whole report, an empty one with its summary, and caps the short path lower", () => {
    expect(
      validateReadyReport(
        { agent: "quentin", summary: SUMMARY, findings: [CONFLICT] },
        copy,
        "full",
      ),
    ).toEqual([]);
    expect(
      validateReadyReport({ agent: "quentin", summary: SUMMARY, findings: [] }, copy, "full"),
    ).toEqual([]);
    const seven = Array.from({ length: 7 }, () => ({ ...CONFLICT }));
    expect(
      validateReadyReport({ agent: "quentin", summary: SUMMARY, findings: seven }, copy, "short"),
    ).toContain("too_many_findings:7>6");
  });

  it("does not take a passage that is in a code block, nor one of another document", () => {
    const fenced = doc("prd", "iris", ["```", "- EF-5: in code", "```"]);
    const withCode: ReadyCopy = {
      ...copy,
      texts: new Map([
        [PRD_PATH, fenced],
        [ARCH_PATH, ARCH],
      ]),
    };
    const problems = validateReadyReport(
      {
        agent: "quentin",
        summary: SUMMARY,
        findings: [{ ...CONFLICT, passages: ["prd: EF-5", "architecture: Exports"] }],
      },
      withCode,
      "full",
    );
    expect(problems).toEqual(
      expect.arrayContaining(["passage_unknown:1.1", "passage_unknown:1.2"]),
    );
  });
});

describe("the gate end to end", () => {
  it("computes before the agent judges, and writes nothing", async () => {
    const p = await product();
    const before = p.journal.events.length;
    const checked = await p.ready();
    expect(p.journal.events.length).toBe(before);
    expect(checked).toMatchObject({
      stage: "build",
      track: "full",
      judged: "none",
      verdict: "blocking",
    });
    expect(checked.stack.join("\n")).toContain("doc_unvalidated:prd");
    expect(checked.stack.join("\n")).toContain("req_uncovered:EF-2");
    expect(checked.documents).toEqual([ARCH_PATH, PRD_PATH, UX_PATH]);
    expect(checked.stack.length).toBeLessThanOrEqual(12);
  });

  it("refuses a report that is not whole, nothing written", async () => {
    const p = await product();
    const before = p.journal.events.length;
    const result = await p.call("ready", {
      agent: "quentin",
      summary: SUMMARY,
      findings: [{ ...CONFLICT, passages: ["prd: EF-1", "tests: Screens"] }],
    });
    expect(errorOf(result)?.code).toBe(ErrorCode.INVALID_ARGUMENTS);
    expect(String(errorOf(result)?.details.reason)).toContain("document_unknown:1.2");
    expect(p.journal.events.length).toBe(before);
  });

  it("a blocking verdict opens a decision; going on all the same passes the gate", async () => {
    const p = await product();
    await p.validateAll();
    const reported = await p.ready({ summary: SUMMARY, findings: [CONFLICT] });
    expect(reported).toMatchObject({ judged: "current", verdict: "blocking", decision: true });
    expect(reported.report).toMatch(/^R-[0-9A-Z]{10}$/);
    const state = await p.run<{
      checkpoints: Record<string, { type: string; options: unknown[] }>;
    }>("get_state", { full: true });
    const decision = Object.values(state.checkpoints ?? {}).find((c) => c.type === "decision");
    expect(decision?.options).toHaveLength(2);
    const step = await p.next();
    expect(step.readiness?.gate).toBe("blocked");
    const waiting = step.waiting.find((w) => w.type === "decision");
    expect(waiting).toBeDefined();
    await p.approve(waiting?.id, { decision: "option_chosen", option: "go_on" });
    const after = await p.next();
    expect(after.readiness?.gate).toBe("reserves");
  });

  it("settles by the creator's gestures: accept with a reason, or have the author correct", async () => {
    const p = await product();
    await p.validateAll();
    const reported = await p.ready({
      summary: SUMMARY,
      findings: [CONFLICT, { ...CONFLICT, severity: "should_fix", claim: "Another one." }],
    });
    expect(reported.stack.some((l) => l.startsWith("J1 · blocking"))).toBe(true);
    // The creator's words and a reason are both required to accept.
    const noReason = await p.call("ready", {
      agent: "quentin",
      items: [{ id: "J1", gesture: "accept" }],
      quote: "ok",
    });
    expect(String(errorOf(noReason)?.details.reason)).toContain("reason_missing:J1");
    const unknown = await p.call("ready", {
      agent: "quentin",
      items: [{ id: "J9", gesture: "fix" }],
      quote: "ok",
    });
    expect(String(errorOf(unknown)?.details.reason)).toContain("not_open:J9");
    const settled = await p.ready({
      items: [
        { id: "J1", gesture: "fix" },
        { id: "J2", gesture: "accept", reason: "Known, handled in a later story." },
        { id: "req_uncovered:EF-2", gesture: "accept", reason: "Out of the first version." },
      ],
      quote: "je corrige le premier, j'accepte les autres",
    });
    expect(settled.settled).toEqual({ fix: 1, accept: 2 });
    expect(settled.fix).toEqual([{ owner: "iris", lines: [expect.stringContaining("J1")] }]);
    const checked = await p.ready();
    expect(checked.stack.join("\n")).not.toContain("J2 ·");
    expect(checked.stack.join("\n")).not.toContain("req_uncovered:EF-2");
    expect(checked.accepted).toBe(2);
  });

  it("holds only for the documents it read: a change makes the reading stale", async () => {
    const p = await product();
    await p.validateAll();
    await p.ready({ summary: SUMMARY, findings: [] });
    expect((await p.ready()).judged).toBe("current");
    p.files.seed(PRD_PATH, `${PRD}\n- EF-3: Something new.\n`);
    expect((await p.ready()).judged).toBe("stale");
    expect(
      gatePassed(
        gateOf(
          analyse({ documents: [], texts: new Map(), problems: [], needsUx: false }, {}, 0),
          {},
        ),
      ),
    ).toBe(false);
  });

  it("is proposed by next before the first story, once the creator has not skipped it", async () => {
    const p = await product();
    const step = await p.next();
    expect(step.readiness).toMatchObject({ gate: "check", stage: "build", why: "none" });
    await p.validateAll();
    await p.ready({ summary: SUMMARY, findings: [] });
    const done = await p.next();
    // Reserves remain (stories without sections, requirements no story carries): said, not imposed.
    expect(done.readiness?.gate).toBe("reserves");
    p.files.seed(PRD_PATH, `${PRD}\n- EF-3: Something new.\n`);
    expect((await p.next()).readiness).toMatchObject({ gate: "check", why: "stale" });
  });
  const decisionsOf = async (p: Awaited<ReturnType<typeof product>>) => {
    const state = await p.run<{ checkpoints: Record<string, { type: string }> }>("get_state", {
      full: true,
    });
    return Object.values(state.checkpoints ?? {}).filter((c) => c.type === "decision");
  };
  const CHANGED = `${PRD}\n- EF-3: Something new.\n`;

  it("opens one decision for the same blocking points, and does not ask again after the creator went on", async () => {
    const p = await product();
    // Nothing validated: the engine itself finds blocking points.
    const first = await p.ready({ summary: SUMMARY, findings: [] });
    expect(first).toMatchObject({ verdict: "blocking", decision: true });
    await p.ready({ summary: SUMMARY, findings: [] });
    expect(await decisionsOf(p)).toHaveLength(1);
    const waiting = (await p.next()).waiting.find((w) => w.type === "decision");
    await p.approve(waiting?.id, { decision: "option_chosen", option: "go_on" });
    // A document changes: the reading is stale, but the points the creator went on with stay waived.
    p.files.seed(PRD_PATH, CHANGED);
    expect((await p.ready()).judged).toBe("stale");
    const again = await p.ready({ summary: SUMMARY, findings: [] });
    expect(again.verdict).not.toBe("blocking");
    expect(again.decision).toBeUndefined();
    expect(await decisionsOf(p)).toHaveLength(1);
  });

  it("ties an acceptance to the version of the document it was given for", async () => {
    const p = await product();
    await p.validateAll();
    p.files.seed(PRD_PATH, CHANGED);
    const keyOf = async () =>
      (await p.ready()).stack
        .map((line) => line.split(" · ")[0])
        .find((k) => k?.startsWith("doc_changed:prd@"));
    const key = await keyOf();
    expect(key).toBeDefined();
    await p.ready({
      items: [{ id: key as string, gesture: "accept", reason: "I am still writing it." }],
      quote: "je finis ce document",
    });
    expect(await keyOf()).toBeUndefined();
    p.files.seed(PRD_PATH, `${PRD}\n- EF-3: Something else again.\n`);
    expect(await keyOf()).toBeDefined();
  });

  it("says so when epics are written and no story is", async () => {
    const p = await product();
    p.files.seed(
      ".agentplugged/epics/epic-1.md",
      ["---", "id: epic-1", "kind: epic", "owner: iris", "---", "# Epic 1", ""].join("\n"),
    );
    await p.files.remove(".agentplugged/stories/1-1-export.md");
    expect((await p.ready()).stack.join("\n")).toContain("stories_missing");
  });
});
