import type { MethodConfig } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { NOTICE_COMMIT_MESSAGE } from "../docs/knowledge-notice.js";
import type { BranchMergeRequest } from "../stories/story-workspace.js";
import { MemoryFiles } from "../testing/memory-files.js";
import { afterMerge, mergedEvent, mergeStory } from "./story-merge.js";

/** A story merged without a pull request, the creator having chosen none. */

const COMMIT = "a".repeat(40);
const MERGE = "b".repeat(40);
const config = {} as MethodConfig;
const checkpoint = { id: "G-0000000001", story: "1-1" };

function stateOf(options: { branches: boolean }) {
  return {
    git_workflow: {
      workflow: {
        integration: "dev",
        production: "main",
        merge: "direct",
        story_branches: options.branches,
      },
      forge: false,
      source: "terminal",
      at: "",
      event: "",
      merges: 0,
    },
    stories: {
      "1-1": {
        started: {
          agent: "sam",
          branch: options.branches ? "feat/1-1-work" : "dev",
          base: "c".repeat(40),
          base_ref: options.branches ? "dev" : "c".repeat(40),
          worktree: options.branches ? "../shop.worktrees/1-1" : ".",
        },
      },
    },
  };
}

function context(outcome: (request: BranchMergeRequest) => unknown) {
  const requests: BranchMergeRequest[] = [];
  const merging = {
    mergeBranch: async (request: BranchMergeRequest) => {
      requests.push(request);
      return outcome(request);
    },
    removeWorktree: async () => ({ status: "removed" }),
  };
  return {
    requests,
    context: { storyWorkspace: merging } as unknown as CommandContext,
  };
}

describe("the merge by the engine, without a pull request", () => {
  it("merges the story's branch into the landing branch, on the commit reviewed, and records it", async () => {
    const { context: ctx, requests } = context(() => ({
      ok: true,
      commit: COMMIT,
      merge_commit: MERGE,
    }));
    const done = await mergeStory(
      ctx,
      config,
      stateOf({ branches: true }) as never,
      checkpoint,
      COMMIT,
    );
    expect(done).toMatchObject({
      forge: null,
      pr: null,
      url: null,
      direct: { into: "dev", on_base: false },
      merge_commit: MERGE,
      commit: COMMIT,
    });
    expect(requests).toEqual([
      {
        from: "feat/1-1-work",
        into: "dev",
        method: "merge",
        message: "Merge story 1-1",
        expect: COMMIT,
      },
    ]);
    const event = mergedEvent(done as never, "chat");
    expect(event.payload).toMatchObject({ direct: true, into: "dev", merge_commit: MERGE });
    expect(event.payload).not.toHaveProperty("pr");
    // The worktree of the story is removed after the merge, as with a pull request.
    expect((await afterMerge(ctx, done as never)).worktree.status).toBe("removed");
  });

  it("puts the late notice of the pages the merge put behind into a commit of the engine, the working copy staying clean", async () => {
    const page =
      "---\nid: kb-x\nkind: note\nowner: zoe\nlinks: []\ncode:\n  - src/\n---\n# X\n\nBody.\n";
    const files = new MemoryFiles({ ".agentplugged/docs/x.md": page });
    const order: string[] = [];
    const commits: { branch: string; paths: string[]; message: string }[] = [];
    const { context: base } = context(() => {
      order.push("merge");
      return { ok: true, commit: COMMIT, merge_commit: MERGE };
    });
    const workspace = {
      ...(base.storyWorkspace as object),
      commitFiles: async (request: {
        branch: string;
        files: { path: string; edit: (current: string) => string }[];
        message: string;
      }) => {
        order.push("commit");
        // Written and committed together: nothing is left uncommitted.
        for (const file of request.files) {
          files.seed(file.path, file.edit(files.files.get(file.path) ?? ""));
        }
        commits.push({
          branch: request.branch,
          paths: request.files.map((file) => file.path),
          message: request.message,
        });
        return { ok: true, commit: "d".repeat(40) };
      },
    };
    const diff =
      "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
    const ctx = {
      ...base,
      files,
      storyWorkspace: workspace,
      storyDiff: { diff: async () => diff },
    } as unknown as CommandContext;
    await mergeStory(ctx, config, stateOf({ branches: true }) as never, checkpoint, COMMIT);
    // The notice comes after the merge, on the branch it landed on, in a commit of its own.
    expect(order).toEqual(["merge", "commit"]);
    expect(commits).toEqual([
      { branch: "dev", paths: [".agentplugged/docs/x.md"], message: NOTICE_COMMIT_MESSAGE },
    ]);
    expect(files.files.get(".agentplugged/docs/x.md")).toContain("la story 1-1");
    expect(files.files.get(".agentplugged/docs/x.md")).toContain("`src/a.ts`");
    // With a pull request workflow, the engine commits nothing.
    const pr = stateOf({ branches: true }) as { git_workflow: { workflow: { merge: string } } };
    pr.git_workflow.workflow.merge = "pr";
    expect(
      (await import("../docs/knowledge-notice.js")).noticeBranchOf(pr as never),
    ).toBeUndefined();
  });

  it("delivers a story built on the landing branch where it is: nothing to merge, no worktree", async () => {
    const { context: ctx, requests } = context(() => {
      throw new Error("never called");
    });
    const done = await mergeStory(
      ctx,
      config,
      stateOf({ branches: false }) as never,
      checkpoint,
      COMMIT,
    );
    expect(done).toMatchObject({ direct: { into: "dev", on_base: true }, merge_commit: null });
    expect(requests).toEqual([]);
    expect((await afterMerge(ctx, done as never)).worktree.status).toBe("absent");
  });

  it.each([
    ["conflict", "direct_conflict"],
    ["base_dirty", "base_dirty"],
    ["head_moved", "head_moved"],
    ["branch_missing", "base_missing"],
    ["failed", "direct_failed"],
  ])("says why Git refused (%s), and merges nothing", async (reason, failure) => {
    const { context: ctx } = context(() => ({ ok: false, reason, message: "refused" }));
    const done = await mergeStory(
      ctx,
      config,
      stateOf({ branches: true }) as never,
      checkpoint,
      COMMIT,
    );
    expect(done).toMatchObject({ code: "MERGE_FAILED", details: { reason: failure } });
  });
});
