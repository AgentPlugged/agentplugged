import { gitBlobId, toBase64url, utf8 } from "@agentplugged/crypto";
import { SoftwareAuthenticator } from "@agentplugged/crypto/webauthn-software";
import { describe, expect, it } from "vitest";
import {
  type CommandContext,
  createCommandRegistry,
  type DocsBase,
  type DocsCheckResult,
  initCommand,
  MemoryKeyStore,
  MemoryStateStore,
  type NextResult,
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

/**
 * The creator validates a new version of the
 * PRD, `docs check` warns that a page of the base is behind it, `next` calls Zoé; once the page
 * records the validated version, both are quiet again.
 */

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const SEED = toBase64url(new Uint8Array(32).fill(7));
const PRD = ".agentplugged/docs/prd.md";
const PAGE = ".agentplugged/docs/reference/requirements.md";
const NOTES = ".agentplugged/docs/release-notes/1-0-0.md";

const PRD_A = "---\nid: prd\nkind: prd\nowner: iris\n---\n# PRD\n\nVersion A.\n";
const PRD_B = "---\nid: prd\nkind: prd\nowner: iris\n---\n# PRD\n\nVersion B.\n";
const A = gitBlobId(utf8(PRD_A));
const B = gitBlobId(utf8(PRD_B));

const NO_TOOL: ToolProbe = {
  which: async () => undefined,
  version: async () => undefined,
  extensions: async () => [],
};

/** Outside a Git repository: no base, no blob, no history. */
const NO_GIT: DocsBase = {
  read: async () => ({ found: false, reason: "no_repository" }),
  readBlobs: async () => new Map(),
  blobsInHistory: async () => new Set(),
};

/** A Git base at `HEAD` holding the PRD at version A. */
const GIT_BASE: DocsBase = {
  read: async () => ({
    found: true,
    commit: "c".repeat(40),
    files: [{ path: PRD, text: PRD_A }],
  }),
  readBlobs: async () => new Map(),
  blobsInHistory: async () => new Set(),
};

function shippedAgent(id: string, name: string, domain: string, phase: string) {
  return {
    [`agents/${id}/SKILL.md`]: SHIPPED_IRIS.replace("name: iris", `name: ${id}`)
      .replace("domain: product", `domain: ${domain}`)
      .replace("phase: framing", `phase: ${phase}`)
      .replace("# Iris", `# ${name}`),
    [`agents/${id}/agent.yaml`]: SHIPPED_IRIS_AGENT.replace("name: Iris", `name: ${name}`),
  };
}

const page = (blob: string) =>
  `---\nid: kb-requirements\nkind: note\nowner: zoe\nlinks: [prd]\nsources:\n  - path: ${PRD}\n    blob: ${blob}\n---\n# Requirements\n\nLast updated: 2026-10-04 — first generation\n`;

const notes =
  "---\nid: kb-release-1-0-0\nkind: note\nowner: zoe\nlinks: [prd]\n---\n# 1.0.0\n\nLast updated: 2026-10-01 — release\n";

/** A product in memory, with Zoé; `docsBase` reads the base of `docs check`. */
async function product(docsBase: DocsBase = NO_GIT) {
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
    method: shippedMethod(shippedAgent("zoe", "Zoé", "docs", "build")),
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
  const value = async <T>(
    name: string,
    context: CommandContext,
    input: Record<string, unknown>,
  ) => {
    const result = await registry.run(name, context, input);
    if (!result.ok) throw new Error(`${name} failed: ${result.error.code}`);
    return result.value as T;
  };
  /** The PRD at `blob`, cited at `path` by a `document` checkpoint the creator answers. */
  const validate = async (blob: string, decision = "approved", path = PRD) => {
    const opened = await value<RecordedEvent>("open_checkpoint", agent, {
      agent: "iris",
      type: "document",
      risk: "low",
      title: "PRD to review",
      summary: "The PRD changed.",
      documents: [{ path, branch: "main", blob_sha: blob }],
    });
    await value("review", human, {
      action: "resolve",
      checkpoint: opened.checkpoint,
      decision,
      ...(decision === "approved" ? {} : { note: "Not yet." }),
    });
  };
  const check = () => value<DocsCheckResult>("docs", reader, { action: "check" });
  const next = () => value<NextResult>("next", reader, {});
  return { files, journal, validate, check, next };
}

const reasons = (result: DocsCheckResult) => result.warnings.map((entry) => entry.reason);

describe("a page of the knowledge base behind a validated document", () => {
  it("is reported by docs check and handed to Zoé by next, until it records that version", async () => {
    const { files, validate, check, next } = await product();
    files.seed(PRD, PRD_A);
    files.seed(PAGE, page(A));
    files.seed(NOTES, notes);
    // Never validated: the page is not behind anything.
    expect((await check()).warnings).toEqual([]);
    expect((await next()).step).toBe("framing");

    await validate(A);
    expect((await check()).warnings).toEqual([]);
    expect((await next()).step).toBe("framing");

    // Validated at B on another branch: this one still holds A, nothing is behind yet.
    await validate(B);
    expect((await check()).warnings).toEqual([]);
    expect((await next()).step).toBe("framing");

    // Merged here: the page is behind; the release notes never are.
    files.seed(PRD, PRD_B);
    const checked = await check();
    expect(checked.problems).toEqual([]);
    expect(checked.warnings).toEqual([
      expect.objectContaining({
        reason: "kb_stale",
        details: expect.objectContaining({ path: PAGE, source: PRD, blob: B, recorded: A }),
      }),
    ]);
    expect(await next()).toMatchObject({ step: "knowledge_base_update", agent: "zoe" });

    files.seed(PAGE, page(B));
    expect((await check()).warnings).toEqual([]);
    expect((await next()).step).toBe("framing");
  });

  it("never leaves the working copy dirty: with a pull request workflow, `next` tells the late pages instead", async () => {
    const { files, validate, next, check } = await product();
    files.seed(PRD, PRD_B);
    files.seed(PAGE, page(A));
    files.seed(NOTES, notes);
    expect((await next()).late_pages).toBeUndefined();
    await validate(B);
    const late = await next();
    // The creator's workflow (a pull request by default) gives the engine no commit: no file written.
    expect(files.files.get(PAGE)).toBe(page(A));
    expect(files.writes.filter((path) => path === PAGE)).toEqual([]);
    expect(late.late_pages).toEqual([{ path: PAGE, stories: [], documents: [PRD], paths: [] }]);
    // `docs check` says the same, and the release notes are never late.
    const checked = await check();
    expect(checked.problems).toEqual([]);
    expect(reasons(checked)).toEqual(["kb_stale"]);
    // Zoé updates the page: nothing left to tell.
    files.seed(PAGE, page(B));
    expect((await next()).late_pages).toBeUndefined();
    expect(files.files.get(NOTES)).toBe(notes);
  });

  it("warns the same way with a Git base", async () => {
    const { files, validate, check } = await product(GIT_BASE);
    files.seed(PRD, PRD_B);
    files.seed(PAGE, page(A));
    await validate(A);
    await validate(B);
    const checked = await check();
    expect(checked.base).not.toBeNull();
    expect(checked.warnings).toEqual([
      expect.objectContaining({
        reason: "kb_stale",
        details: expect.objectContaining({ blob: B, recorded: A }),
      }),
    ]);
  });

  it("takes no refused nor changes-requested checkpoint for a validation", async () => {
    const { files, validate, check, next } = await product();
    files.seed(PRD, PRD_B);
    files.seed(PAGE, page(A));
    await validate(A);
    await validate(B, "changes_requested");
    await validate(B, "rejected");
    expect((await check()).warnings).toEqual([]);
    // The refused document goes back to its author: no knowledge-base update.
    expect((await next()).step).toBe("changes_requested");
  });

  it("finds the document of a product in a sub-folder of its repository", async () => {
    const { files, validate, check, next } = await product();
    files.seed(PRD, PRD_B);
    files.seed(PAGE, page(A));
    await validate(B, "approved", `shop/${PRD}`);
    expect(reasons(await check())).toEqual(["kb_stale"]);
    expect((await next()).step).toBe("knowledge_base_update");
  });

  it("gives no freshness warning when the journal cannot be read", async () => {
    const { files, journal, validate, check } = await product();
    files.seed(PRD, PRD_B);
    files.seed(PAGE, page(A));
    await validate(B);
    journal.listFailure = new Error("journal: unreadable");
    const checked = await check();
    expect(reasons(checked)).toContain("unverified");
    expect(reasons(checked).filter((reason) => reason.startsWith("kb_"))).toEqual([]);
  });

  it("reads the same documents in next and docs check", async () => {
    const { files, validate, check, next } = await product();
    files.seed(PRD, PRD_B);
    // A page outside docs/, and a page behind a symbolic link: neither is read by either.
    files.seed(".agentplugged/stories/kb-elsewhere.md", page(A).replace("kb-requirements", "kb-x"));
    files.seed(PAGE, page(A));
    const links = new Set([PAGE]);
    Object.assign(files, { isSymbolicLink: async (path: string) => links.has(path) });
    await validate(B);
    expect(reasons(await check())).toEqual([]);
    expect((await next()).step).toBe("framing");
    links.delete(PAGE);
    expect(reasons(await check())).toEqual(["kb_stale"]);
    expect((await next()).step).toBe("knowledge_base_update");
  });
});
