import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_SOURCES,
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  FORGE_LINK_REASONS,
  isStoryBranch,
  OpenPullRequestInputSchema,
  PULL_REQUEST_REASONS,
  STORY_EVENT_TYPES,
  STORY_START_REASONS,
  StartStoryInputSchema,
  StoryPrOpenedPayloadSchema,
  StoryStartedPayloadSchema,
} from "./index.js";

const PAYLOAD = {
  agent: "sam",
  branch: "feat/1-1-sign-up",
  base: "a".repeat(40),
  base_ref: "main",
  worktree: "../shop.worktrees/1-1",
};

describe("story start", () => {
  it("registers story.started at version 1 and its error code", () => {
    expect(EVENT_TYPE_REGISTRY[STORY_EVENT_TYPES.started]?.version).toBe(1);
    expect(ErrorCode.STORY_NOT_STARTABLE).toBe("STORY_NOT_STARTABLE");
    expect(STORY_START_REASONS).toContain("not_in_sprint");
  });

  it("accepts a started story with a relative worktree and a commit id", () => {
    expect(StoryStartedPayloadSchema.safeParse(PAYLOAD).success).toBe(true);
    expect(
      StoryStartedPayloadSchema.safeParse({ ...PAYLOAD, base: "b".repeat(64), agent: "creator" })
        .success,
    ).toBe(true);
  });

  it("never records an absolute path, a bad commit or an extra field", () => {
    for (const worktree of ["/home/ada/shop.worktrees/1-1", "C:/shop/1-1", "..\\shop\\1-1", ""]) {
      expect(StoryStartedPayloadSchema.safeParse({ ...PAYLOAD, worktree }).success, worktree).toBe(
        false,
      );
    }
    expect(StoryStartedPayloadSchema.safeParse({ ...PAYLOAD, base: "A".repeat(40) }).success).toBe(
      false,
    );
    expect(StoryStartedPayloadSchema.safeParse({ ...PAYLOAD, path: "x" }).success).toBe(false);
  });

  it("checks the input of start_story", () => {
    expect(StartStoryInputSchema.safeParse({ agent: "sam", story: "1-1" }).success).toBe(true);
    expect(StartStoryInputSchema.safeParse({ agent: "sam", story: "1" }).success).toBe(false);
    expect(
      StartStoryInputSchema.safeParse({ agent: "sam", story: "1-1", actor: "human" }).success,
    ).toBe(false);
  });

  it("knows a story's branch: feat/<id>-<slug>", () => {
    expect(isStoryBranch("1-1", "feat/1-1-sign-up")).toBe(true);
    expect(isStoryBranch("1-1", "feat/1-1")).toBe(false);
    expect(isStoryBranch("1-1", "feat/1-12-x")).toBe(false);
    expect(isStoryBranch("1-1", "feat/1-1-Sign")).toBe(false);
    expect(isStoryBranch("1-1", "fix/1-1-x")).toBe(false);
  });
});

describe("story pull request", () => {
  const OPENED = {
    forge: "github",
    number: 12,
    url: "https://github.com/ada/shop/pull/12",
    action: "opened",
    branch: "feat/1-1-sign-up",
    base: "main",
    head: "a".repeat(40),
    criteria: [true, false],
    tests: "passed",
    tests_summary: "42 tests pass.",
    body_sha256: "b".repeat(64),
  };

  it("registers story.pr_opened at version 1, its error codes and the forge checkpoint", () => {
    expect(EVENT_TYPE_REGISTRY[STORY_EVENT_TYPES.prOpened]?.version).toBe(1);
    expect(ErrorCode.PULL_REQUEST_NOT_OPENABLE).toBe("PULL_REQUEST_NOT_OPENABLE");
    expect(ErrorCode.FORGE_NOT_LINKED).toBe("FORGE_NOT_LINKED");
    expect(ErrorCode.PULL_REQUEST_FAILED).toBe("PULL_REQUEST_FAILED");
    expect(CHECKPOINT_SOURCES).toContain("forge_unlinked");
    expect(PULL_REQUEST_REASONS).toContain("tests_not_passed");
    expect(FORGE_LINK_REASONS).toContain("not_logged_in");
  });

  it("accepts a pull request, never a cost, credentials nor an extra field", () => {
    expect(StoryPrOpenedPayloadSchema.safeParse(OPENED).success).toBe(true);
    expect(StoryPrOpenedPayloadSchema.safeParse({ ...OPENED, usd: 1 }).success).toBe(false);
    for (const url of [
      "https://ada:token@github.com/ada/shop/pull/12",
      "git@github.com:ada/shop.git",
      "https://github.com/ada/shop/pull/12\nx",
      "https://github.com/a b",
    ]) {
      expect(StoryPrOpenedPayloadSchema.safeParse({ ...OPENED, url }).success, url).toBe(false);
    }
    expect(StoryPrOpenedPayloadSchema.safeParse({ ...OPENED, number: 0 }).success).toBe(false);
    expect(StoryPrOpenedPayloadSchema.safeParse({ ...OPENED, forge: "bitbucket" }).success).toBe(
      false,
    );
  });

  it("checks the input of open_pull_request", () => {
    const input = {
      agent: "sam",
      story: "1-1",
      criteria: [true],
      tests: { status: "passed", summary: "All green." },
    };
    expect(OpenPullRequestInputSchema.safeParse(input).success).toBe(true);
    const unreported = { ...input, tests: { status: "not_reported", summary: "x" } };
    expect(OpenPullRequestInputSchema.safeParse(unreported).success).toBe(false);
    expect(OpenPullRequestInputSchema.safeParse({ ...input, body: "mine" }).success).toBe(false);
  });
});
