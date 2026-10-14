import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { DOMAIN_IDS, ErrorCode, type PhaseId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type AgentStateView,
  ARCHITECTURE_PATH,
  ARCHITECTURE_SECURITY_REVIEW_PATH,
  type ArchitectureReview,
  type CommandContext,
  createCommandRegistry,
  type DocsBase,
  designSecurityReviewGap,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
  parseReviewLine,
  type RecordedEvent,
  type ReviewList,
  resolveProfile,
  syncCommand,
  type ToolProbe,
} from "../index.js";
import type { AgentState } from "../projection/agent-reducers.js";
import {
  MemoryFiles,
  SHIPPED_IRIS,
  SHIPPED_IRIS_AGENT,
  shippedMethod,
} from "../testing/memory-files.js";

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const SEED = toBase64url(new Uint8Array(32).fill(7));
const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};
const blob = (text: string) => gitBlobId(utf8(text));
const ARCHITECTURE_V1 =
  "---\nid: architecture\nkind: architecture\nowner: alex\n---\n# Architecture\n\nVersion 1.\n";
const ARCHITECTURE_V2 = ARCHITECTURE_V1.replace("Version 1.", "Version 2.");
const REVIEW =
  "---\nid: architecture-security-review\nkind: note\nowner: chloe\nlinks:\n  - architecture\n---\n# Review\n\nNo blocking finding.\n";
const doc = (path: string, text: string) => ({ path, branch: "main", blob_sha: blob(text) });
/** The first line of the summary Chloé submits with her review. */
const reviewLine = (
  review: string,
  architecture: string,
  counts = "verdict=no-blocking findings=2 blocking=0",
) =>
  `Architecture security review: ${counts} review=${blob(review)} architecture=${blob(architecture)}\nTwo low findings.`;

/** A shipped agent built on the sample one. */
function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

/** A product with Chloé (and Alex unless told otherwise), the profile limited to `phases`. */
async function product(
  phases: PhaseId[],
  options: { domains?: readonly string[]; alex?: boolean; docsBase?: DocsBase } = {},
) {
  const files = new MemoryFiles();
  let clock = NOW;
  const now = () => {
    clock += 1000;
    return clock;
  };
  const keys = new MemoryKeyStore(SEED);
  const journal = new MemoryStateStore({ keys, now });
  const human: CommandContext = {
    files,
    tools: NO_TOOL,
    method: shippedMethod({
      ...(options.alex === false ? {} : shippedAgent("alex", "Alex", "architecture", "design")),
      ...shippedAgent("chloe", "Chloé", "security", "build"),
    }),
    actor: "human",
    engineVersion: "1.0.0",
    journal,
    now,
    interactive: true,
    human: { keys, presence: new SoftwareAuthenticator({ available: false }) },
  };
  const profile = resolveProfile("new-product", {
    phases,
    domains: (options.domains ?? DOMAIN_IDS) as typeof DOMAIN_IDS,
  });
  const init = await initCommand.run(human, { profile });
  if (!init.ok) throw new Error(`init failed: ${init.error.code}`);
  const registry = createCommandRegistry();
  const sync = async () => {
    const synced = await syncCommand.run(human, {});
    if (!synced.ok) throw new Error(`sync failed: ${synced.error.code}`);
  };
  await sync();
  const agent: CommandContext = {
    ...human,
    actor: "agent",
    human: undefined,
    ...(options.docsBase === undefined ? {} : { docsBase: options.docsBase }),
  };
  const call = (name: string, input: Record<string, unknown>) => registry.run(name, agent, input);
  const submit = (summary: string, extra: Record<string, unknown> = {}) =>
    call("submit_result", {
      agent: "chloe",
      status: "complete",
      summary,
      assumptions: [],
      open_questions: [],
      conflicts: [],
      ...extra,
    });
  const openEnd = (documents: unknown[], by = "alex", phase: PhaseId = "design") =>
    call("open_checkpoint", {
      agent: by,
      type: "phase_end",
      phase,
      risk: "medium",
      title: `End of ${phase}`,
      summary: "Ready for approval.",
      documents,
    });
  const reasonOf = async (documents: unknown[]) => {
    const result = await openEnd(documents);
    if (result.ok) throw new Error("the end opened");
    expect(result.error.code).toBe(ErrorCode.SECURITY_REVIEW_MISSING);
    return result.error.details.reason;
  };
  const answer = async (checkpoint: string, decision: string, note?: string) => {
    const answered = await registry.run("review", human, {
      action: "resolve",
      checkpoint,
      decision,
      ...(note === undefined ? {} : { note }),
    });
    if (!answered.ok) throw new Error(`review failed: ${answered.error.code}`);
  };
  const next = async () => {
    const result = await registry.run("next", { ...human, human: undefined }, {});
    if (!result.ok) throw new Error(`next failed: ${result.error.code}`);
    return result.value as NextResult;
  };
  const state = async () => {
    const result = await registry.run("get_state", agent, { full: true });
    if (!result.ok) throw new Error(`get_state failed: ${result.error.code}`);
    return result.value as AgentStateView;
  };
  const list = async () => {
    const result = await registry.run("review", human, { action: "list" });
    if (!result.ok) throw new Error(`review list failed: ${result.error.code}`);
    return result.value as ReviewList;
  };
  const disable = async (id: string) => {
    const result = await registry.run("agent", human, { action: "disable", id });
    if (!result.ok) throw new Error(`agent disable failed: ${result.error.code}`);
    await sync();
  };
  const idOf = (result: Awaited<ReturnType<typeof openEnd>>) => {
    if (!result.ok) throw new Error(result.error.code);
    return (result.value as RecordedEvent).checkpoint as string;
  };
  return { files, submit, openEnd, reasonOf, answer, next, state, list, disable, idOf };
}

describe("the security review joined to the end of the design phase", () => {
  it("asks Alex, or the creator, for the architecture first: never Chloé", async () => {
    const withAtlas = await product(["design", "build"]);
    expect(await withAtlas.next()).toMatchObject({ step: "design", agent: "alex", you: false });
    const withoutAtlas = await product(["design", "build"], { alex: false });
    expect(await withoutAtlas.next()).toMatchObject({ step: "design", agent: null, you: true });
    withAtlas.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    expect(await withAtlas.next()).toMatchObject({ step: "security_review", agent: "chloe" });
  });

  it("opens the end only with Chloé's review of the architecture cited", async () => {
    const p = await product(["design", "build"]);
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    const architecture = doc(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    const review = doc(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    expect(await p.reasonOf([architecture, review])).toBe("not_submitted");
    // Another review of his (a dependency audit, the threat model), or one on a story: no.
    expect((await p.submit("Dependency audit: no finding.")).ok).toBe(true);
    expect((await p.submit(reviewLine(REVIEW, ARCHITECTURE_V1), { story: "3-7" })).ok).toBe(true);
    expect(await p.reasonOf([architecture, review])).toBe("not_submitted");
    expect(await p.next()).toMatchObject({ step: "security_review", agent: "chloe" });

    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    expect((await p.submit(reviewLine(REVIEW, ARCHITECTURE_V1))).ok).toBe(true);
    expect(await p.next()).toMatchObject({ step: "phase_end", agent: "alex" });

    expect(await p.reasonOf([architecture])).toBe("not_attached");
    expect(await p.reasonOf([review])).toBe("architecture_not_attached");
    expect(await p.reasonOf([architecture, { ...review, path: review.path.toUpperCase() }])).toBe(
      "path_case",
    );
    expect(await p.reasonOf([architecture, { ...review, blob_sha: "c".repeat(40) }])).toBe(
      "review_mismatch",
    );
    // The working copy must hold the versions cited.
    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, `${REVIEW}Edited.\n`);
    expect(await p.reasonOf([architecture, review])).toBe("review_file_changed");
    await p.files.remove(ARCHITECTURE_SECURITY_REVIEW_PATH);
    expect(await p.reasonOf([architecture, review])).toBe("review_file_missing");
    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V2);
    expect(await p.reasonOf([architecture, review])).toBe("architecture_changed");
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);

    // A path written with `\` is the same path.
    const id = p.idOf(
      await p.openEnd([architecture, { ...review, path: review.path.replaceAll("/", "\\") }]),
    );
    const view = await p.state();
    expect(view.checkpoints[id]).toMatchObject({
      type: "phase_end",
      phase: "design",
      recipient_role: "tech_lead",
    });
    // The card's data: the verdict Chloé submitted for the review cited.
    expect((await p.list()).security_reviews?.[id]).toMatchObject({
      verdict: "no-blocking",
      findings: 2,
      blocking: 0,
      review: blob(REVIEW),
      architecture: blob(ARCHITECTURE_V1),
    });
  });

  it("refuses a review file Chloé does not own", async () => {
    const p = await product(["design", "build"]);
    const forged = REVIEW.replace("owner: chloe", "owner: alex");
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, forged);
    expect((await p.submit(reviewLine(forged, ARCHITECTURE_V1))).ok).toBe(true);
    const documents = [
      doc(ARCHITECTURE_PATH, ARCHITECTURE_V1),
      doc(ARCHITECTURE_SECURITY_REVIEW_PATH, forged),
    ];
    expect(await p.reasonOf(documents)).toBe("review_not_security_reviewer");
  });

  it("refuses the old review once the refused architecture was edited", async () => {
    const p = await product(["design", "build"]);
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    expect((await p.submit(reviewLine(REVIEW, ARCHITECTURE_V1))).ok).toBe(true);
    const review = doc(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    const first = p.idOf(await p.openEnd([doc(ARCHITECTURE_PATH, ARCHITECTURE_V1), review]));
    await p.answer(first, "changes_requested", "Split the billing module.");

    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V2);
    const edited = doc(ARCHITECTURE_PATH, ARCHITECTURE_V2);
    expect(await p.next()).toMatchObject({ step: "security_review", agent: "chloe" });
    expect(await p.reasonOf([edited, review])).toBe("stale");

    const updated = `${REVIEW}Reviewed again.\n`;
    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, updated);
    expect((await p.submit(reviewLine(updated, ARCHITECTURE_V2))).ok).toBe(true);
    expect(await p.next()).toMatchObject({ step: "changes_requested", agent: "alex" });
    p.idOf(await p.openEnd([edited, doc(ARCHITECTURE_SECURITY_REVIEW_PATH, updated)]));
  });

  it("counts only a review submitted since the design phase began", async () => {
    const p = await product(["planning", "design", "build"]);
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    // Chloé answered during planning: before the design phase, it is not its review.
    expect((await p.submit(reviewLine(REVIEW, ARCHITECTURE_V1))).ok).toBe(true);
    await p.answer(p.idOf(await p.openEnd([], "main", "planning")), "approved");
    expect(await p.next()).toMatchObject({ phase: "design", step: "security_review" });
    const documents = [
      doc(ARCHITECTURE_PATH, ARCHITECTURE_V1),
      doc(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW),
    ];
    expect(await p.reasonOf(documents)).toBe("not_submitted");
    expect((await p.submit(reviewLine(REVIEW, ARCHITECTURE_V1))).ok).toBe(true);
    p.idOf(await p.openEnd(documents));
  });

  it("asks nothing without the security domain, nor with Chloé disabled", async () => {
    const off = await product(["design", "build"], {
      domains: DOMAIN_IDS.filter((domain) => domain !== "security"),
    });
    off.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    expect(await off.next()).toMatchObject({ step: "phase_end", agent: "alex" });
    off.idOf(await off.openEnd([doc(ARCHITECTURE_PATH, ARCHITECTURE_V1)]));

    const disabled = await product(["design", "build"]);
    disabled.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    expect(await disabled.next()).toMatchObject({ step: "security_review" });
    await disabled.disable("chloe");
    expect(await disabled.next()).toMatchObject({ step: "phase_end", agent: "alex" });
    disabled.idOf(await disabled.openEnd([doc(ARCHITECTURE_PATH, ARCHITECTURE_V1)]));
  });
});

describe("the review line", () => {
  const review = "a".repeat(40);
  const architecture = "b".repeat(40);
  const line = (counts: string) =>
    `Architecture security review: ${counts} review=${review} architecture=${architecture}`;

  it("reads the verdict and its counts, and refuses a line that contradicts itself", () => {
    expect(parseReviewLine(`${line("verdict=blocking findings=5 blocking=2")}\nMore.`)).toEqual({
      verdict: "blocking",
      findings: 5,
      blocking: 2,
      review,
      architecture,
    });
    for (const counts of [
      "verdict=blocking findings=3 blocking=0",
      "verdict=no-blocking findings=3 blocking=1",
      "verdict=blocking findings=1 blocking=2",
    ]) {
      expect(parseReviewLine(line(counts)), counts).toBeUndefined();
    }
    expect(parseReviewLine(`Done.\n${line("verdict=no-blocking findings=0 blocking=0")}`)).toBe(
      undefined,
    );
  });

  it("refuses to guess on a date it cannot read", () => {
    const entry: ArchitectureReview = {
      verdict: "no-blocking",
      findings: 0,
      blocking: 0,
      review,
      architecture,
      status: "complete",
      at: "not a date",
    };
    const agents = {
      chloe: {
        status: null,
        task: null,
        story: null,
        last_signal_at: "2026-10-04T12:00:00.000Z",
        last_result: null,
        architecture_reviews: { [review]: entry },
      } satisfies AgentState,
    };
    expect(designSecurityReviewGap({ active: ["chloe"], agents, since: null })).toBe(
      "invalid_date",
    );
    expect(designSecurityReviewGap({ active: ["alex"], agents, since: null })).toBe(undefined);
  });
});

/** A Git base holding `committed` (path -> text) on every branch. */
function fakeBase(committed: Record<string, string>, found = true): DocsBase {
  return {
    read: async () =>
      found
        ? {
            found: true,
            commit: "c".repeat(40),
            files: Object.entries(committed).map(([path, text]) => ({ path, text })),
          }
        : { found: false, reason: "no_repository" },
    readBlobs: async () => new Map(),
    blobsInHistory: async () => new Set(),
  };
}

describe("the documents an end of phase cites are committed", () => {
  async function ready(base: DocsBase) {
    const p = await product(["design", "build"], { docsBase: base });
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    p.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    expect((await p.submit(reviewLine(REVIEW, ARCHITECTURE_V1))).ok).toBe(true);
    return p;
  }
  const documents = [
    doc(ARCHITECTURE_PATH, ARCHITECTURE_V1),
    doc(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW),
  ];

  it("refuses a review that is only in the object store, and names it", async () => {
    // The architecture is committed; the review is a blob of `git hash-object -w`, in no commit.
    const p = await ready(fakeBase({ [ARCHITECTURE_PATH]: ARCHITECTURE_V1 }));
    const refused = await p.openEnd(documents);
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.code).toBe(ErrorCode.DOCUMENT_NOT_COMMITTED);
    expect(refused.error.details).toMatchObject({
      phase: "design",
      documents: ARCHITECTURE_SECURITY_REVIEW_PATH,
      count: 1,
    });
  });

  it("asks for Chloé's review first: the committed check comes after it", async () => {
    const p = await product(["design", "build"], { docsBase: fakeBase({}) });
    p.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    const refused = await p.openEnd(documents);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe(ErrorCode.SECURITY_REVIEW_MISSING);
  });

  it("opens the end after a refusal once the documents are committed, nothing written before", async () => {
    const committed: Record<string, string> = { [ARCHITECTURE_PATH]: ARCHITECTURE_V1 };
    const base: DocsBase = {
      ...fakeBase({}),
      read: async () => ({
        found: true,
        commit: "c".repeat(40),
        files: Object.entries(committed).map(([path, text]) => ({ path, text })),
      }),
    };
    const p = await ready(base);
    expect((await p.openEnd(documents)).ok).toBe(false);
    expect(Object.values((await p.state()).checkpoints)).toHaveLength(0);
    committed[ARCHITECTURE_SECURITY_REVIEW_PATH] = REVIEW;
    expect((await p.openEnd(documents)).ok).toBe(true);
  });

  it("refuses a committed document that differs from the blob cited", async () => {
    const p = await ready(
      fakeBase({
        [ARCHITECTURE_PATH]: ARCHITECTURE_V2,
        [ARCHITECTURE_SECURITY_REVIEW_PATH]: REVIEW,
      }),
    );
    const refused = await p.openEnd(documents);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.details.documents).toBe(ARCHITECTURE_PATH);
  });

  it("opens the end once both are committed, with CRLF files too", async () => {
    const crlf = (text: string) => text.replaceAll("\n", "\r\n");
    const p = await ready(
      fakeBase({
        [ARCHITECTURE_PATH]: crlf(ARCHITECTURE_V1),
        [ARCHITECTURE_SECURITY_REVIEW_PATH]: REVIEW,
      }),
    );
    expect((await p.openEnd(documents)).ok).toBe(true);
  });

  it("refuses nothing when Git cannot say (no repository), nor without a reader", async () => {
    const without = await ready(fakeBase({}, false));
    expect((await without.openEnd(documents)).ok).toBe(true);
    const absent = await product(["design", "build"]);
    absent.files.seed(ARCHITECTURE_PATH, ARCHITECTURE_V1);
    absent.files.seed(ARCHITECTURE_SECURITY_REVIEW_PATH, REVIEW);
    expect((await absent.submit(reviewLine(REVIEW, ARCHITECTURE_V1))).ok).toBe(true);
    expect((await absent.openEnd(documents)).ok).toBe(true);
  });
});
