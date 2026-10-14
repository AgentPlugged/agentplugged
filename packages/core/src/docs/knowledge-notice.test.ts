import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { describe, expect, it } from "vitest";
import { answered } from "../testing/checkpoint-state.js";
import { MemoryFiles } from "../testing/memory-files.js";
import {
  type LateReason,
  NOTICE_COMMIT_MESSAGE,
  type NoticeCommitter,
  noticeBranchOf,
  syncLateNotices,
  withLateNotice,
} from "./knowledge-notice.js";

/** A page that is behind says so itself, written by the engine. */

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const LATER = Date.UTC(2026, 9, 12, 12, 0, 0);
const PAGE = ".agentplugged/docs/reference/billing.md";
const PRD = ".agentplugged/docs/prd.md";

const HEADER = "---\nid: kb-billing\nkind: note\nowner: zoe\nlinks: []\nsources: []\n";
const page = (code = "  - src/billing/\n", last = "") =>
  `${HEADER}code:\n${code}last_story: ${last}\n---\n# Billing\n\nLast updated: 2026-10-01\n\nThe tax is 20 %.\n`;

const REASON: LateReason = { stories: ["4-3"], documents: [], paths: ["src/billing/tax.ts"] };
const merged = (seq: number, story: string, files: string[]) => ({ story, seq, files });

describe("the late notice of a page", () => {
  it("is written right after the header, dated, with the story and the paths", () => {
    const text = page();
    const out = withLateNotice(text, REASON, NOW);
    const close = "<!-- /agentplugged:late -->\n";
    const end = out.indexOf(close) + close.length;
    const head = out.slice(0, end);
    expect(
      head.startsWith(
        `${HEADER}code:\n  - src/billing/\nlast_story: \n---\n<!-- agentplugged:late since=2026-10-09 -->\n`,
      ),
    ).toBe(true);
    expect(head).toContain("la story 4-3 depuis le 2026-10-09");
    expect(head).toContain("`src/billing/tax.ts`");
    expect(out.slice(end)).toBe("# Billing\n\nLast updated: 2026-10-01\n\nThe tax is 20 %.\n");
  });

  it("is taken away byte for byte when the page is up to date again", () => {
    for (const text of [page(), page().replaceAll("\n", "\r\n")]) {
      const noticed = withLateNotice(text, REASON, NOW);
      expect(noticed).not.toBe(text);
      expect(withLateNotice(noticed, undefined, LATER)).toBe(text);
    }
  });

  it("is idempotent and keeps its first date while the page stays behind", () => {
    const once = withLateNotice(page(), REASON, NOW);
    expect(withLateNotice(once, REASON, LATER)).toBe(once);
    const more = withLateNotice(once, { ...REASON, stories: ["4-3", "4-5"] }, LATER);
    expect(more).toContain("since=2026-10-09");
    expect(more).toContain("la story 4-3, 4-5");
    expect(more.match(/agentplugged:late since/g)).toHaveLength(1);
    expect(withLateNotice(more, undefined, LATER)).toBe(page());
  });

  it("names the validated document a page is behind", () => {
    const out = withLateNotice(page(), { stories: [], documents: [PRD], paths: [] }, NOW);
    expect(out).toContain(`le document \`${PRD}\``);
    expect(out).toContain("le code concerné");
  });

  it("never changes anything outside its block, and leaves a page with no header alone", () => {
    const text = page();
    const noticed = withLateNotice(text, REASON, NOW);
    const start = noticed.indexOf("<!-- agentplugged:late");
    const end =
      noticed.indexOf("<!-- /agentplugged:late -->\n") + "<!-- /agentplugged:late -->\n".length;
    expect(noticed.slice(0, start) + noticed.slice(end)).toBe(text);
    expect(withLateNotice("# No header\n", REASON, NOW)).toBe("# No header\n");
    // A notice mangled by hand (no closing line) is not touched either.
    const mangled = `${HEADER}---\n<!-- agentplugged:late since=2026-10-09 -->\n> half\n# T\n`;
    expect(withLateNotice(mangled, undefined, NOW)).toBe(mangled);
    expect(withLateNotice(mangled, REASON, NOW)).toBe(mangled);
  });
});

/**
 * A workspace that commits like Git does: the files are written and committed together, so the
 * copy has nothing left uncommitted (`dirty` stays empty), and every commit is recorded.
 */
function committing(memory: MemoryFiles, options: { current?: string; refuse?: boolean } = {}) {
  const commits: { branch: string; paths: string[]; message: string }[] = [];
  const dirty = new Set<string>();
  const workspace: NoticeCommitter["workspace"] = {
    commitFiles: async (request) => {
      if (options.current !== undefined && options.current !== request.branch) {
        return { ok: false, reason: "not_current", message: request.branch };
      }
      if (options.refuse === true) return { ok: false, reason: "failed", message: "refused" };
      const changed = request.files.filter((file) => {
        const current = memory.files.get(file.path) ?? "";
        const text = file.edit(current);
        if (text !== current) memory.seed(file.path, text);
        return text !== current;
      });
      commits.push({
        branch: request.branch,
        paths: changed.map((file) => file.path),
        message: request.message,
      });
      return { ok: true, commit: "c".repeat(40) };
    },
  };
  return { workspace, commits, dirty };
}

describe("the late notices of the base", () => {
  const behind = { checkpoints: [], now: NOW, merges: [merged(1, "4-3", ["src/billing/tax.ts"])] };
  const direct = (memory: MemoryFiles) => {
    const git = committing(memory);
    return { git, committer: { branch: "main", workspace: git.workspace } as NoticeCommitter };
  };

  it("commits the notice of a page a merged story put behind, in a commit of the engine", async () => {
    const memory = new MemoryFiles({ [PAGE]: page() });
    const { git, committer } = direct(memory);
    const done = await syncLateNotices(memory, committer, behind);
    expect(done.committed).toEqual([PAGE]);
    expect(done.pending).toEqual([]);
    expect(git.commits).toEqual([
      { branch: "main", paths: [PAGE], message: NOTICE_COMMIT_MESSAGE },
    ]);
    expect(memory.files.get(PAGE)).toContain("la story 4-3 depuis le 2026-10-09");
    expect(memory.files.get(PAGE)).toContain("`src/billing/tax.ts`");
    // Nothing is left written outside the commit.
    expect(memory.writes.filter((path) => path !== PAGE)).toEqual([]);
  });

  it("takes the notice off, in a commit too, when the page is up to date again", async () => {
    const memory = new MemoryFiles({ [PAGE]: page() });
    const { git, committer } = direct(memory);
    await syncLateNotices(memory, committer, behind);
    // Zoé's commit brings the page to the story and removes the block: nothing left to do.
    memory.seed(PAGE, page("  - src/billing/\n", "4-3"));
    const quiet = await syncLateNotices(memory, committer, { ...behind, now: LATER });
    expect(quiet).toEqual({ committed: [], pending: [] });
    expect(git.commits).toHaveLength(1);
    // Zoé updated the page but left the block: the engine removes it, byte for byte.
    const kept = withLateNotice(page("  - src/billing/\n", "4-3"), REASON, NOW);
    memory.seed(PAGE, kept);
    const cleared = await syncLateNotices(memory, committer, { ...behind, now: LATER });
    expect(cleared.committed).toEqual([PAGE]);
    expect(memory.files.get(PAGE)).toBe(page("  - src/billing/\n", "4-3"));
  });

  it("writes nothing when the workflow allows no direct commit, and says which pages are behind", async () => {
    for (const committer of [
      { branch: undefined, workspace: committing(new MemoryFiles()).workspace },
      { branch: "main", workspace: undefined },
    ] satisfies NoticeCommitter[]) {
      const memory = new MemoryFiles({ [PAGE]: page() });
      const done = await syncLateNotices(memory, committer, behind);
      expect(done.committed).toEqual([]);
      expect(done.pending).toEqual([
        { path: PAGE, stories: ["4-3"], documents: [], paths: ["src/billing/tax.ts"] },
      ]);
      expect(memory.files.get(PAGE)).toBe(page());
      expect(memory.writes).toEqual([]);
    }
  });

  it("writes nothing and tells the pages when Git refuses (another branch, a failed commit)", async () => {
    for (const options of [{ current: "feat/1-1" }, { refuse: true }]) {
      const memory = new MemoryFiles({ [PAGE]: page() });
      const git = committing(memory, options);
      const done = await syncLateNotices(
        memory,
        { branch: "main", workspace: git.workspace },
        behind,
      );
      expect(done.committed).toEqual([]);
      expect(done.pending.map((entry) => entry.path)).toEqual([PAGE]);
      expect(memory.files.get(PAGE)).toBe(page());
    }
  });

  it("does nothing when no page is behind, and never twice the same thing", async () => {
    const memory = new MemoryFiles({ [PAGE]: page() });
    const { git, committer } = direct(memory);
    const other = { ...behind, merges: [merged(1, "4-3", ["src/other.ts"])] };
    expect(await syncLateNotices(memory, committer, other)).toEqual({ committed: [], pending: [] });
    await syncLateNotices(memory, committer, behind);
    expect(await syncLateNotices(memory, committer, behind)).toEqual({
      committed: [],
      pending: [],
    });
    expect(git.commits).toHaveLength(1);
  });

  it("notices a page behind a document the creator validated", async () => {
    const prd = "---\nid: prd\nkind: prd\nowner: iris\n---\n# PRD\n\nVersion B.\n";
    const blob = gitBlobId(utf8(prd));
    const memory = new MemoryFiles({
      [PRD]: prd,
      [PAGE]: `${HEADER.replace("sources: []", `sources:\n  - path: ${PRD}\n    blob: ${"a".repeat(40)}`)}code: []\nlast_story:\n---\n# Billing\n`,
    });
    const { committer } = direct(memory);
    const validated = answered("G-PRD", "approved", "2026-10-08T10:00:00.000Z", [[PRD, blob]]);
    const done = await syncLateNotices(memory, committer, {
      checkpoints: [validated],
      merges: [],
      now: NOW,
    });
    expect(done.committed).toEqual([PAGE]);
    expect(memory.files.get(PAGE)).toContain(`le document \`${PRD}\``);
  });

  it("leaves the other documents exactly as they were, and never fails", async () => {
    const memory = new MemoryFiles({ [PAGE]: page(), [PRD]: "# PRD\nuntouched\n" });
    const { committer } = direct(memory);
    await syncLateNotices(memory, committer, behind);
    expect(memory.files.get(PRD)).toBe("# PRD\nuntouched\n");
    const broken = {
      branch: "main",
      workspace: { commitFiles: async () => Promise.reject(new Error("x")) },
    };
    await expect(
      syncLateNotices(new MemoryFiles({ [PAGE]: page() }), broken, behind),
    ).resolves.toBeDefined();
  });

  it("lets the engine commit only where the creator's workflow merges without a pull request", () => {
    const flow = (workflow: Record<string, unknown>) => ({ git_workflow: { workflow } });
    expect(noticeBranchOf(flow({ merge: "direct", integration: "dev", production: "main" }))).toBe(
      "dev",
    );
    expect(noticeBranchOf(flow({ merge: "direct", production: "main" }))).toBe("main");
    expect(noticeBranchOf(flow({ merge: "pr", production: "main" }))).toBeUndefined();
    expect(noticeBranchOf({})).toBeUndefined();
  });
});
