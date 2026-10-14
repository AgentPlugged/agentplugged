import { describe, expect, it } from "vitest";
import {
  GitReleasedPayloadSchema,
  GitWorkflowSchema,
  GitWorkflowSetPayloadSchema,
  recommendedGitWorkflow,
  resolveGitWorkflow,
  sameWorkflow,
} from "./git-workflow.js";

describe("the Git workflow", () => {
  it("accepts main alone, main + dev, and the branches the creator names", () => {
    expect(GitWorkflowSchema.safeParse({}).success).toBe(true);
    expect(GitWorkflowSchema.safeParse({ integration: "dev", production: "main" }).success).toBe(
      true,
    );
    expect(GitWorkflowSchema.safeParse({ integration: "release/next" }).success).toBe(true);
  });

  it("refuses what cannot be a workflow", () => {
    for (const wrong of [
      { production: "main" },
      { integration: "dev", production: "dev" },
      { integration: "bad name" },
      { integration: "-x" },
      { integration: "main" },
      { integration: "a/.b" },
      { integration: "x.lock/y" },
      { ci: "sometimes" },
      { merge: "squash" },
      { unknown: true },
      { environments: { staging: { url: "a\nb" } } },
    ]) {
      expect(GitWorkflowSchema.safeParse(wrong).success, JSON.stringify(wrong)).toBe(false);
    }
  });

  it("resolves the defaults: what the engine did before the creator could choose", () => {
    expect(resolveGitWorkflow(undefined)).toMatchObject({
      staged: false,
      story_branches: true,
      ci: "remote",
      merge: "pr",
      review: true,
    });
    expect(resolveGitWorkflow({ integration: "dev" }).staged).toBe(true);
    // Without a branch of its own, a story has no pull request.
    expect(resolveGitWorkflow({ story_branches: false, merge: "pr" }).merge).toBe("direct");
  });

  it("recommends a pull request and a remote CI on a forge, a direct merge and a local CI elsewhere", () => {
    expect(recommendedGitWorkflow({ forge: true })).toEqual({
      story_branches: true,
      ci: "remote",
      merge: "pr",
      review: true,
    });
    expect(recommendedGitWorkflow({ forge: false })).toMatchObject({
      ci: "local",
      merge: "direct",
    });
  });

  it("compares two workflows whatever the order of their keys", () => {
    expect(sameWorkflow({ ci: "none", review: false }, { review: false, ci: "none" })).toBe(true);
    expect(sameWorkflow({ ci: "none" }, undefined)).toBe(false);
  });

  it("records a release with the stories it carried", () => {
    const released = {
      from: "dev",
      to: "main",
      commit: "a".repeat(40),
      via: "pr",
      pr: 7,
      url: "https://github.com/ada/shop/pull/7",
      stories: ["1-2", "10-36"],
      checkpoint: "G-0000000001",
    };
    expect(GitReleasedPayloadSchema.safeParse(released).success).toBe(true);
    expect(GitReleasedPayloadSchema.safeParse({ ...released, stories: ["x"] }).success).toBe(false);
  });

  it("records a choice with what the engine read", () => {
    expect(
      GitWorkflowSetPayloadSchema.safeParse({
        workflow: { integration: "dev" },
        previous: null,
        source: "chat",
        forge: true,
        main: "main",
      }).success,
    ).toBe(true);
  });
});
