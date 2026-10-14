import type { ProjectionState } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { INSTRUMENTATION_MARKER, instrumentedFiles } from "../merge/story-files.js";
import { instrumentationProblem } from "./story-instrumentation.js";

/**
 * The temporary code of a diagnosis: the marker `agentplugged:debug` on
 * a line the branch added keeps the story from its review, until it is taken out.
 */

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

const diffOf = (added: string, path = "src/cart.ts") =>
  [
    `diff --git a/${path} b/${path}`,
    "index 111..222 100644",
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,3 @@",
    " const total = 1;",
    `+${added}`,
    " export {};",
    "",
  ].join("\n");

const state = {
  stories: {
    "1-3": {
      started: {
        agent: "sam",
        branch: "feat/1-3-cart",
        base: BASE,
        base_ref: "main",
        worktree: "../shop.worktrees/1-3",
      },
    },
  },
} as unknown as ProjectionState["state"];

function contextWith(diff: string | undefined, commit: string | null = HEAD): CommandContext {
  return {
    storyDiff: { diff: async () => diff },
    proofRunner: { workingCopy: async () => (commit === null ? {} : { commit, clean: true }) },
  } as unknown as CommandContext;
}

describe("the marker of temporary diagnostic code", () => {
  it("is found on an added line, in any comment style, and only there", () => {
    expect(INSTRUMENTATION_MARKER).toBe("agentplugged:debug");
    expect(instrumentedFiles(diffOf(`console.log(total); // ${INSTRUMENTATION_MARKER}`))).toEqual([
      "src/cart.ts",
    ]);
    expect(
      instrumentedFiles(diffOf(`print(total)  # ${INSTRUMENTATION_MARKER}`, "cart.py")),
    ).toEqual(["cart.py"]);
    expect(instrumentedFiles(diffOf("console.log(total);"))).toEqual([]);
    // The marker opens the comment; a text that only names it is no probe, and neither is a file of words.
    expect(instrumentedFiles(diffOf(`<!-- ${INSTRUMENTATION_MARKER} -->`, "page.html"))).toEqual([
      "page.html",
    ]);
    expect(instrumentedFiles(diffOf(`const M = "${INSTRUMENTATION_MARKER}";`))).toEqual([]);
    expect(instrumentedFiles(diffOf(`// see ${INSTRUMENTATION_MARKER}`))).toEqual([]);
    expect(
      instrumentedFiles(diffOf(`log(x) // ${INSTRUMENTATION_MARKER}`, "docs/probes.md")),
    ).toEqual([]);
    expect(instrumentedFiles(undefined)).toEqual([]);
    // A line that was already there (context) or removed is not the branch's addition.
    const removed = diffOf("x").replace(" const total = 1;", `-// ${INSTRUMENTATION_MARKER}`);
    expect(instrumentedFiles(removed)).toEqual([]);
  });
});

describe("the gate before the review", () => {
  it("refuses a story whose branch still carries the marker, and names the files", async () => {
    const problem = await instrumentationProblem(
      contextWith(diffOf(`console.log(total); // ${INSTRUMENTATION_MARKER}`)),
      state,
      "1-3",
    );
    expect(problem?.details.reason).toContain("debug_instrumentation_left");
    expect(problem?.details.reason).toContain("src/cart.ts");
  });

  it("lets a clean branch go, and invents nothing when it cannot read", async () => {
    expect(await instrumentationProblem(contextWith(diffOf("const x = 1;")), state, "1-3")).toBe(
      undefined,
    );
    // No diff, no commit, no runner, no story: nothing is refused.
    expect(await instrumentationProblem(contextWith(undefined), state, "1-3")).toBe(undefined);
    expect(
      await instrumentationProblem(contextWith(diffOf(INSTRUMENTATION_MARKER), null), state, "1-3"),
    ).toBe(undefined);
    expect(await instrumentationProblem({} as CommandContext, state, "1-3")).toBe(undefined);
    expect(
      await instrumentationProblem(contextWith(diffOf(INSTRUMENTATION_MARKER)), {}, "1-3"),
    ).toBe(undefined);
  });
});
