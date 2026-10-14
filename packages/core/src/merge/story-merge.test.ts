import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import type { StoryForge } from "../stories/story-forge.js";
import { answered } from "../testing/checkpoint-state.js";
import { changedFiles, mergeStory, mergesOn } from "./story-merge.js";

/** The merge rule, alone, on a state and a forge in memory. */

const HEAD = "d".repeat(40);
const CONFIG = { format_version: 1 } as never;
const CHECKPOINT = { id: "G-0000000001", story: "1-1" };

function forge(overrides: Partial<StoryForge> = {}): StoryForge {
  return {
    inspect: async () => ({
      repository: true,
      prefix: "",
      remotes: [{ name: "origin", url: "https://gitlab.com/ada/shop.git" }],
      head: HEAD,
      commits: 1,
    }),
    cli: async () => "ready",
    push: async () => ({ ok: true }),
    pullRequests: async () => [],
    create: async () => ({ number: 1, url: "" }),
    update: async () => {},
    pullRequest: async () => ({ state: "open", head: HEAD, merge_commit: null }),
    merge: async () => ({ ok: true, merge_commit: null }),
    ...overrides,
  };
}

function state(pr = true) {
  return {
    stories: {
      "1-1": {
        started: { branch: "feat/1-1-x", base: "c".repeat(40), base_ref: "origin/main" },
        ci: { commit: HEAD },
        ...(pr
          ? {
              pull_request: {
                forge: "gitlab",
                number: 7,
                url: "https://gitlab.com/ada/shop/-/merge_requests/7",
              },
            }
          : {}),
      },
    },
  };
}

const context = (storyForge: StoryForge) => ({ storyForge }) as unknown as CommandContext;
const reasonOf = (value: unknown) =>
  value instanceof AgentPluggedError ? value.details.reason : undefined;

describe("mergeStory", () => {
  it("merges only an approval of the engine's merge checkpoint", () => {
    const merge = { type: "story" as const, story: "1-1", source: "merge" as const };
    expect(mergesOn(merge, "approved")).toBe(true);
    expect(mergesOn(merge, "approved_with_reservations")).toBe(true);
    expect(mergesOn(merge, "changes_requested")).toBe(false);
    expect(mergesOn({ ...merge, source: undefined }, "approved")).toBe(false);
  });

  it("refuses without a pull request, without the branch's head, or a GitLab rebase", async () => {
    expect(
      reasonOf(await mergeStory(context(forge()), CONFIG, state(false), CHECKPOINT, HEAD)),
    ).toBe("no_pull_request");
    expect(
      reasonOf(await mergeStory(context(forge()), CONFIG, state(), CHECKPOINT, undefined)),
    ).toBe("head_unreadable");
    const rebase = { format_version: 1, pr: { merge_method: "rebase" } } as never;
    let merged = false;
    const watched = forge({
      merge: async () => {
        merged = true;
        return { ok: true, merge_commit: null };
      },
    });
    expect(reasonOf(await mergeStory(context(watched), rebase, state(), CHECKPOINT, HEAD))).toBe(
      "method_unsupported",
    );
    expect(merged).toBe(false);
  });

  it("never merges another repository, nor records a merge of another commit", async () => {
    const moved = forge({
      inspect: async () => ({
        repository: true,
        prefix: "",
        remotes: [{ name: "origin", url: "https://gitlab.com/ada/fork.git" }],
        head: HEAD,
        commits: 1,
      }),
    });
    expect(reasonOf(await mergeStory(context(moved), CONFIG, state(), CHECKPOINT, HEAD))).toBe(
      "other_repository",
    );
    const byHand = forge({
      pullRequest: async () => ({ state: "merged", head: HEAD, merge_commit: null }),
    });
    // A merge the creator did at the forge is recorded, whatever the channel.
    const recorded = await mergeStory(context(byHand), CONFIG, state(), CHECKPOINT, HEAD);
    expect(recorded).toMatchObject({ already: true });
  });

  it("says a tool that fails, without a token in the message", async () => {
    const failing = forge({
      merge: async () => {
        throw new Error("glab: 401 Authorization: Bearer glpat-abcdefghijklmnop");
      },
    });
    const result = await mergeStory(context(failing), CONFIG, state(), CHECKPOINT, HEAD);
    expect(reasonOf(result)).toBe("forge_failed");
    expect(String((result as AgentPluggedError).details.message)).not.toContain("glpat-abc");
  });

  it("lists both sides of a renamed file, once each", () => {
    const diff = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 90%",
      "rename from old.ts",
      "rename to new.ts",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "",
    ].join("\n");
    expect(changedFiles(diff)).toEqual({ files: ["old.ts", "new.ts"], truncated: false });
    expect(changedFiles(undefined)).toEqual({ files: [], truncated: false });
  });

  it("delivers a started story by its merge only, never by an approval alone", () => {
    const approval = answered("G-0000000001", "approved", "2026-10-04T12:00:00.000Z", [], {
      type: "story",
      story: "1-1",
    } as never);
    const started = {
      status: "in_review",
      started: { branch: "feat/1-1-x" },
    } as unknown as StoryState;
    expect(storyDoneAt([approval], "1-1", started)).toBeUndefined();
    const merged = {
      ...started,
      merged: { at: "2026-10-04T12:00:01.000Z" },
    } as unknown as StoryState;
    expect(storyDoneAt([approval], "1-1", merged)).toBe("2026-10-04T12:00:01.000Z");
  });

  it("never marks done a story nobody worked on because a story point was approved", () => {
    const doc = [".agentplugged/stories/2-4.md", "a".repeat(40)] as const;
    const approval = answered("G-0000000001", "approved", "2026-10-04T12:00:00.000Z", [doc], {
      type: "story",
      story: "2-4",
    } as never);
    // Its file validated with the wrong type of point: no start, no status.
    expect(storyDoneAt([approval], "2-4", undefined)).toBeUndefined();
    expect(storyDoneAt([approval], "2-4", {} as unknown as StoryState)).toBeUndefined();
    // The point a blocked result opened never ends a story, whatever happened to it.
    const blocked = answered("G-0000000002", "approved", "2026-10-04T12:00:00.000Z", [], {
      type: "story",
      story: "2-5",
      source: "blocked_result",
    } as never);
    const worked = {
      status: "blocked",
      status_by: { agent: "sam", at: "2026-10-04T11:00:00.000Z" },
    } as unknown as StoryState;
    expect(storyDoneAt([blocked], "2-5", worked)).toBeUndefined();
  });
});
