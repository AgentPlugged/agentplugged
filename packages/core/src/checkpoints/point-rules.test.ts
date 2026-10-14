import { DEFAULT_VALIDATION_POINTS, VALIDATION_POINTS } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { checkpointState } from "../testing/checkpoint-state.js";
import {
  deciderFor,
  delegationOf,
  delegationVerdict,
  isDelegated,
  POINT_DECIDERS,
  pointKindOf,
  pointsView,
} from "./point-rules.js";

/** Which kind of point a checkpoint is, and whether the creator kept it. */

const point = (overrides: Parameters<typeof checkpointState>[1]) =>
  checkpointState("G-POINT", overrides);

describe("the kind of a point", () => {
  it("reads the kind of a document from the agent that wrote it", () => {
    for (const [agent, kind] of [
      ["iris", "framing"],
      ["lou", "framing"],
      ["maya", "framing"],
      ["stella", "framing"],
      ["alex", "architecture"],
      ["izzy", "breakdown"],
      ["julien", "publication"],
      ["milo", "publication"],
      ["zoe", "other"],
      ["a-custom-agent", "other"],
    ] as const) {
      expect(pointKindOf(point({ type: "document", opened_by: agent })), agent).toBe(kind);
    }
  });

  it("reads the kind of a document from the files it cites before its author's name", () => {
    const cites = (path: string) => [{ path, branch: "main", blob_sha: "a".repeat(40) }];
    expect(
      pointKindOf(
        point({
          type: "document",
          opened_by: "zoe",
          documents: cites(".agentplugged/docs/architecture.md"),
        }),
      ),
    ).toBe("architecture");
    expect(
      pointKindOf(
        point({
          type: "document",
          opened_by: "alex",
          documents: cites(".agentplugged/docs/prd.md"),
        }),
      ),
    ).toBe("framing");
    expect(
      pointKindOf(
        point({
          type: "document",
          opened_by: "zoe",
          documents: cites(".agentplugged/stories/1-1-x.md"),
        }),
      ),
    ).toBe("breakdown");
  });

  it("reads the kind of the end of a phase from the phase", () => {
    for (const [phase, kind] of [
      ["framing", "framing"],
      ["planning", "framing"],
      ["design", "architecture"],
      ["build", "other"],
      ["delivery", "release"],
      ["launch", "publication"],
    ] as const) {
      expect(pointKindOf(point({ type: "phase_end", phase })), phase).toBe(kind);
    }
  });

  it("reads a merge, a release, a publication and a decision", () => {
    expect(pointKindOf(point({ type: "story", source: "merge", story: "1-1" }))).toBe("merge");
    expect(pointKindOf(point({ type: "release" }))).toBe("release");
    expect(pointKindOf(point({ type: "publication" }))).toBe("publication");
    expect(pointKindOf(point({ type: "decision" }))).toBe("other");
  });

  it("never gives a kind to what the creator alone decides or what asks for help", () => {
    for (const overrides of [
      { type: "permission" },
      { type: "memory" },
      { type: "creator_action" },
      { type: "decision", source: "merge_conflict" },
      { type: "decision", source: "review_loop" },
      { type: "decision", source: "fast_track" },
      { type: "decision", source: "forge_unlinked" },
      { type: "decision", source: "blocked_result" },
      { type: "permission", source: "untrusted_action" },
    ] as const) {
      expect(pointKindOf(point(overrides as never)), JSON.stringify(overrides)).toBeUndefined();
    }
  });
});

describe("what the creator keeps", () => {
  const fixed = delegationOf({ mode: "chat", points: ["framing", "release"] });

  it("leaves every point to the creator while they have not chosen", () => {
    expect(delegationOf({ mode: "chat", points: undefined })).toBeUndefined();
    expect(delegationVerdict(point({ type: "decision" }), undefined)).toEqual({
      delegated: false,
      why: "not_configured",
    });
  });

  it("hands the agents every point the creator did not keep, even with none kept", () => {
    expect(isDelegated(point({ type: "decision" }), fixed)).toBe(true);
    expect(isDelegated(point({ type: "story", source: "merge", story: "1-1" }), fixed)).toBe(true);
    expect(isDelegated(point({ type: "release" }), fixed)).toBe(false);
    expect(delegationVerdict(point({ type: "release" }), fixed)).toEqual({
      delegated: false,
      why: "kept",
      kind: "release",
    });
    const none = delegationOf({ mode: "chat", points: [] });
    expect(isDelegated(point({ type: "release" }), none)).toBe(true);
    expect(isDelegated(point({ type: "publication" }), none)).toBe(true);
  });

  it("keeps an escalation, a reopened point and an escalated one for the creator", () => {
    const none = delegationOf({ mode: "chat", points: [] });
    expect(delegationVerdict(point({ type: "permission" }), none)).toMatchObject({
      delegated: false,
      why: "escalation",
    });
    expect(
      delegationVerdict(point({ type: "decision", reopened_at: "2026-10-05T10:00:00.000Z" }), none),
    ).toMatchObject({ delegated: false, why: "reopened" });
    expect(
      delegationVerdict(
        point({
          type: "decision",
          escalated: { by: "sam", reason: "x", at: "2026-10-05T10:00:00.000Z", event: "E" },
        }),
        none,
      ),
    ).toMatchObject({ delegated: false, why: "escalated" });
  });

  it("keeps a high risk for the terminal at the strict level, the creator's key", () => {
    const strict = delegationOf({ mode: "strict", points: [] });
    expect(delegationVerdict(point({ type: "release", risk: "high" }), strict)).toMatchObject({
      delegated: false,
      why: "strict_high_risk",
    });
    expect(isDelegated(point({ type: "release", risk: "medium" }), strict)).toBe(true);
    const chat = delegationOf({ mode: "chat", points: [] });
    expect(isDelegated(point({ type: "release", risk: "high" }), chat)).toBe(true);
  });

  it("shows the points as the agents read them", () => {
    expect(pointsView(undefined)).toEqual({
      configured: false,
      fixed: [...VALIDATION_POINTS],
      delegated: [],
      proposed: [...DEFAULT_VALIDATION_POINTS],
    });
    expect(pointsView(["framing", "release"])).toMatchObject({
      configured: true,
      fixed: ["framing", "release"],
      delegated: ["architecture", "breakdown", "merge", "publication"],
    });
  });
});

describe("who decides a point", () => {
  const team = ["noah", "iris", "maya", "alex", "chloe", "quentin", "izzy", "sam"];

  it("proposes the reviewer of the kind, never the author", () => {
    expect(deciderFor("architecture", "alex", team)).toBe("chloe");
    expect(deciderFor("framing", "maya", team)).toBe("iris");
    expect(deciderFor("merge", null, team)).toBe("quentin");
  });

  it("never proposes Noah, and falls back on another active agent, then on the author", () => {
    expect(deciderFor("other", "izzy", ["noah", "sam"])).toBe("sam");
    expect(deciderFor("other", "sam", ["noah", "sam"])).toBe("sam");
    expect(deciderFor("other", "sam", ["noah"])).toBeNull();
    expect(deciderFor("other", null, [])).toBeNull();
    for (const kind of Object.keys(POINT_DECIDERS) as Array<keyof typeof POINT_DECIDERS>) {
      expect(POINT_DECIDERS[kind]).not.toContain("noah");
    }
  });
});
