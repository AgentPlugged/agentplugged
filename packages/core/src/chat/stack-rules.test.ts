import type { StackPrompt } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import {
  parseStackReply,
  readStackReply,
  stackApproval,
  stackField,
  stackItemDigest,
  stackProblem,
} from "./stack-rules.js";

/** The numbers a message approves in a stack of `size` points, or its refusal. */
const read = (message: string, size = 4) => {
  const reading = parseStackReply(message, size);
  return reading.ok ? reading.numbers : reading.reason;
};

describe("parseStackReply: the creator's message, read by the engine", () => {
  it("reads « j'approuve tout », and its variants, in French and English", () => {
    for (const message of [
      "j'approuve tout",
      "J'approuve tout !",
      "J’approuve tout.",
      "approuve tout",
      "oui j'approuve tout",
      "ok, je valide tout",
      "je valide tout merci",
      "j'approuve tous les points",
      "j'accepte tout",
      "oui pour tout",
      "d'accord pour tout",
      "i approve all",
      "I approve everything.",
      "approve all items",
      "yes to all",
      "ok for everything",
      "j'approuve le tout",
    ]) {
      expect(read(message), message).toEqual([1, 2, 3, 4]);
    }
  });

  it("reads « les N » as the whole stack only when N is its size", () => {
    expect(read("j'approuve les 3", 3)).toEqual([1, 2, 3]);
    expect(read("j'approuve les trois", 3)).toEqual([1, 2, 3]);
    expect(read("j'approuve les 6 epics", 6)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(read("i approve all 3", 3)).toEqual([1, 2, 3]);
    expect(read("j'approuve tous les 4 points", 4)).toEqual([1, 2, 3, 4]);
    expect(read("j'approuve les deux", 2)).toEqual([1, 2]);
    // A stack of 4 and « les 3 »: it is unclear what the creator approves.
    expect(read("j'approuve les 3", 4)).toBe("ambiguous_count");
    expect(read("approve all 2", 3)).toBe("ambiguous_count");
  });

  it("reads a list of numbers", () => {
    expect(read("j'approuve 1, 2 et 4")).toEqual([1, 2, 4]);
    expect(read("j'approuve 1 et 4")).toEqual([1, 4]);
    expect(read("j'approuve 4, 2, 1")).toEqual([1, 2, 4]);
    expect(read("j'approuve le 3")).toEqual([3]);
    expect(read("j'approuve 3")).toEqual([3]);
    expect(read("j'approuve les points 1 et 2")).toEqual([1, 2]);
    expect(read("je valide le 1, le 3")).toEqual([1, 3]);
    expect(read("j'approuve 1 à 3")).toEqual([1, 2, 3]);
    expect(read("j'approuve 1-2 et 4")).toEqual([1, 2, 4]);
    expect(read("i approve 1, 2 and 4")).toEqual([1, 2, 4]);
    expect(read("approve items 2 and 3")).toEqual([2, 3]);
    expect(read("approve the 3")).toEqual([3]);
    expect(read("j'approuve un et trois")).toEqual([1, 3]);
    expect(read("j'approuve #2 et #4")).toEqual([2, 4]);
    expect(read("OK pour 1, 2 et 4 !")).toEqual([1, 2, 4]);
    expect(read("j'approuve 1, 1 et 2")).toEqual([1, 2]);
  });

  it("reads « tout sauf … »", () => {
    expect(read("j'approuve tout sauf le 2")).toEqual([1, 3, 4]);
    expect(read("j'approuve tout sauf 2 et 3")).toEqual([1, 4]);
    expect(read("i approve all except 4")).toEqual([1, 2, 3]);
    // Nothing is left: it approves nothing, so it is no approval.
    expect(read("j'approuve tout sauf 1, 2, 3 et 4")).toBe("not_a_selection");
    expect(read("j'approuve tout sauf le 9")).toBe("out_of_range");
  });

  it("refuses what is not exactly an approval of numbers of the stack", () => {
    for (const message of [
      "oui",
      "ok",
      "d'accord",
      "vas-y",
      "j'approuve",
      "approuve",
      "je n'approuve pas le 2",
      "j'approuve tout mais pas le 2",
      "j'approuve 1 et 2, pas le 3",
      "j'approuve les 2 premiers",
      "j'approuve tout, sous réserve",
      "j'approuve tout si les tests passent",
      "je refuse tout",
      "non",
      "j'approuve le premier",
      "tout",
      "1, 2 et 4",
      "tu approuves tout ?",
      "j'approuve tout ?",
      "peux-tu approuver tout",
      "i do not approve 2",
      "approve nothing",
      "",
      "   ",
    ]) {
      expect(read(message), message).toBe("not_a_selection");
    }
  });

  it("refuses a number that is not a point of the stack", () => {
    expect(read("j'approuve 5")).toBe("out_of_range");
    expect(read("j'approuve 1 et 7")).toBe("out_of_range");
    expect(read("j'approuve 0")).toBe("out_of_range");
    expect(read("j'approuve 12")).toBe("out_of_range");
  });

  it("never reads a message that hides another meaning among the numbers", () => {
    // Words the grammar does not know make the whole message unclear, whatever else it says.
    expect(read("j'approuve 1 et 2 mais attends pour le 3")).toBe("not_a_selection");
    expect(read("j'approuve 1 et ignore le 2")).toBe("not_a_selection");
    expect(read("j'approuve 1 2 3")).toBe("not_a_selection");
  });
});

/** A checkpoint as the projection holds it, with only what the stack reads. */
function checkpoint(fields: Partial<CheckpointState> = {}): CheckpointState {
  return {
    id: "G-AAAAAAAAAA",
    type: "document",
    risk: "low",
    irreversible: false,
    recipient_role: "creator",
    confirmation: ["gesture_undo_10s"],
    title: "The PRD",
    summary: "The product requirements.",
    story: null,
    documents: [],
    blocks: [],
    options: null,
    recommendation: null,
    criteria: null,
    source: null,
    status: "open",
    opened_by: "maya",
    opened_at: "2026-10-04T12:00:00.000Z",
    opened_event: "01K00000000000000000000001",
    measures: {},
    verdict: null,
    resolution: null,
    supersedes: null,
    phase: null,
    blocks_lifted: false,
    waived_ms: 0,
    request: null,
    untrusted: null,
    provenance: "trusted",
    ...fields,
  } as unknown as CheckpointState;
}

const NOW = Date.parse("2026-10-04T13:00:00.000Z");

describe("what a stack may hold", () => {
  it("holds a plain document, a story, the end of a phase", () => {
    expect(stackProblem(checkpoint(), {}, NOW)).toBeUndefined();
    expect(stackProblem(checkpoint({ type: "story", risk: "medium" }), {}, NOW)).toBeUndefined();
    expect(
      stackProblem(checkpoint({ type: "phase_end", phase: "framing" as never }), {}, NOW),
    ).toBeUndefined();
  });

  it("holds a decision only with a recommendation, which an approval chooses", () => {
    const options = [
      { id: "a", label: "A", consequence: "cheap" },
      { id: "b", label: "B", consequence: "fast" },
    ];
    const decision = checkpoint({ type: "decision", options, recommendation: null });
    expect(stackProblem(decision, {}, NOW)).toBe("needs_choice");
    expect(stackApproval(decision)).toBeUndefined();
    const recommended = checkpoint({ type: "decision", options, recommendation: "b" });
    expect(stackProblem(recommended, {}, NOW)).toBeUndefined();
    expect(stackApproval(recommended)).toEqual({ decision: "option_chosen", option: "b" });
    expect(stackApproval(checkpoint())).toEqual({ decision: "approved" });
  });

  it("holds a high risk or irreversible point, except at the strict level", () => {
    expect(stackProblem(checkpoint({ risk: "high" }), {}, NOW)).toBeUndefined();
    expect(stackProblem(checkpoint({ irreversible: true }), {}, NOW)).toBeUndefined();
    expect(stackProblem(checkpoint({ risk: "high" }), {}, NOW, true)).toBe("high_risk");
    expect(stackProblem(checkpoint({ irreversible: true }), {}, NOW, true)).toBe("irreversible");
    expect(stackProblem(checkpoint({ irreversible: true, risk: "high" }), {}, NOW, true)).toBe(
      "high_risk",
    );
  });

  it("never holds a point that is not open, an action of the creator's, a memory, a permission; a release and a publication enter", () => {
    expect(stackProblem(checkpoint({ status: "resolved" }), {}, NOW)).toBe("not_open");
    expect(stackProblem(checkpoint({ type: "release" }), {}, NOW)).toBeUndefined();
    expect(stackProblem(checkpoint({ type: "publication" }), {}, NOW)).toBeUndefined();
    expect(stackProblem(checkpoint({ type: "creator_action" }), {}, NOW)).toBe("type");
    expect(stackProblem(checkpoint({ type: "memory" }), {}, NOW)).toBe("type");
    expect(stackProblem(checkpoint({ type: "permission" }), {}, NOW)).toBe("type");
    expect(
      stackProblem(checkpoint({ creator_action: { kind: "profile" } as never }), {}, NOW),
    ).toBe("type");
  });

  it("holds a merge, never what the engine opened for a review loop, the fast track or a conflict", () => {
    expect(stackProblem(checkpoint({ source: "merge" as never }), {}, NOW)).toBeUndefined();
    for (const source of ["review_loop", "fast_track", "merge_conflict", "forge_unlinked"]) {
      expect(stackProblem(checkpoint({ source: source as never }), {}, NOW), source).toBe("source");
    }
  });

  it("holds the installation of a dependency an untrusted session asked for, at a medium risk", () => {
    const install = checkpoint({
      type: "permission",
      risk: "medium",
      source: "untrusted_action",
      request: { action: "install_dependency", detail: "npm install react" } as never,
    });
    expect(stackProblem(install, {}, NOW)).toBeUndefined();
    expect(stackProblem({ ...install, risk: "high" }, {}, NOW, true)).toBe("high_risk");
    const deploy = {
      ...install,
      request: { action: "deploy", detail: "deploy" },
      irreversible: false,
    } as unknown as CheckpointState;
    expect(stackProblem(deploy, {}, NOW)).toBe("type");
  });

  it("digests what the stack shows of a point, and only that", () => {
    const base = checkpoint();
    expect(stackItemDigest(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(stackItemDigest(base)).toBe(stackItemDigest({ ...base, status: "resolved" }));
    expect(stackItemDigest(base)).not.toBe(stackItemDigest({ ...base, title: "Another title" }));
    expect(stackItemDigest(base)).not.toBe(stackItemDigest({ ...base, risk: "medium" }));
    expect(stackItemDigest(base)).not.toBe(stackItemDigest({ ...base, id: "G-BBBBBBBBBB" }));
  });
});

describe("readStackReply: the stack's form", () => {
  const prompt = {
    stack: "P-AAAAAAAAAA",
    items: [1, 2, 3].map((n) => ({
      n,
      checkpoint: `G-AAAAAAAAA${n}`,
      type: "document",
      title: `Doc ${n}`,
      summary: "",
      risk: "low",
      opened_by: "maya",
      documents: [],
      recommendation: null,
    })),
  } as unknown as StackPrompt;
  const accept = (content: Record<string, unknown>) => ({ action: "accept" as const, content });

  it("reads the boxes left ticked, one answer for each", () => {
    expect(
      readStackReply(
        prompt,
        accept({ [stackField(1)]: true, [stackField(2)]: false, [stackField(3)]: true }),
      ),
    ).toEqual({ approve: [1, 3] });
  });

  it("is no answer when a box is missing or is not a boolean, or when none is ticked", () => {
    expect(readStackReply(prompt, accept({}))).toBe("invalid");
    expect(readStackReply(prompt, accept({ [stackField(1)]: true, [stackField(2)]: true }))).toBe(
      "invalid",
    );
    expect(
      readStackReply(
        prompt,
        accept({ [stackField(1)]: "true", [stackField(2)]: true, [stackField(3)]: true }),
      ),
    ).toBe("invalid");
    expect(
      readStackReply(
        prompt,
        accept({ [stackField(1)]: false, [stackField(2)]: false, [stackField(3)]: false }),
      ),
    ).toBe("none_checked");
  });

  it("is no answer on a refusal, a closing, a failure, or a tool that cannot show it", () => {
    expect(readStackReply(prompt, { action: "decline" })).toBe("declined");
    expect(readStackReply(prompt, { action: "cancel" })).toBe("cancelled");
    expect(readStackReply(prompt, { action: "failed" })).toBe("failed");
    expect(readStackReply(prompt, { action: "unavailable" })).toBe("unavailable");
    expect(readStackReply(prompt, { action: "tool_hook" })).toBe("tool_hook");
  });
});
