import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { freeIdOf, isUnifiedDiff, parseSource, readFree, sourceLabel } from "./review-free.js";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,2 @@\n x\n+y\n";

describe("where a free review reads its diff", () => {
  it("reads the words of the source", () => {
    expect(parseSource("uncommitted")).toEqual({ kind: "uncommitted" });
    expect(parseSource(" pr:42 ")).toEqual({ kind: "pr", number: 42 });
    expect(parseSource("PR:#7")).toEqual({ kind: "pr", number: 7 });
    expect(parseSource("branch:feat/profile")).toEqual({ kind: "branch", name: "feat/profile" });
    expect(parseSource("a1b2c3d..HEAD")).toEqual({
      kind: "range",
      from: "a1b2c3d",
      to: "HEAD",
      dots: "..",
    });
    expect(parseSource("main...feat/x")).toEqual({
      kind: "range",
      from: "main",
      to: "feat/x",
      dots: "...",
    });
    expect(parseSource("HEAD~3..HEAD")).toMatchObject({ from: "HEAD~3", to: "HEAD" });
  });

  it("refuses what could pass for an option, a path, a range of ranges or a number that is not one", () => {
    for (const source of [
      "",
      "last week",
      "pr:0",
      "pr:abc",
      "pr:12345678901",
      "branch:",
      "branch:--output=x",
      "branch:a..b",
      "--output=x..HEAD",
      "main..--upload-pack=x",
      "a....b",
      "a..b..c",
      "../etc/passwd..HEAD",
      "a b..c",
    ]) {
      expect(parseSource(source), source).toBeUndefined();
    }
  });

  it("names a source, and a diff by its hash", () => {
    expect(sourceLabel({ kind: "uncommitted" })).toBe("uncommitted work");
    expect(sourceLabel({ kind: "pasted" })).toBe("pasted diff");
    expect(sourceLabel({ kind: "pr", number: 3 })).toBe("pr:3");
    expect(sourceLabel({ kind: "branch", name: "x" })).toBe("branch:x");
    expect(sourceLabel({ kind: "range", from: "a", to: "b", dots: "..." })).toBe("a...b");
    expect(freeIdOf(DIFF, "Show it.")).toMatch(/^[0-9a-f]{64}$/);
    expect(freeIdOf(DIFF, "Show it.")).toBe(freeIdOf(DIFF, "Show it."));
    expect(freeIdOf(`${DIFF}+z\n`, "Show it.")).not.toBe(freeIdOf(DIFF, "Show it."));
    // Another intent is another review of the same diff: the two never share what the engine kept.
    expect(freeIdOf(DIFF, "Hide it.")).not.toBe(freeIdOf(DIFF, "Show it."));
  });

  it("takes a unified diff and nothing else", () => {
    expect(isUnifiedDiff(DIFF)).toBe(true);
    expect(isUnifiedDiff("--- a\n+++ b\n")).toBe(false);
    expect(isUnifiedDiff("")).toBe(false);
  });

  it("reads a pasted diff as it is, and says why it cannot read the others", async () => {
    const none = {} as CommandContext;
    expect(await readFree(none, { diff: DIFF })).toEqual({
      label: "pasted diff",
      diff: DIFF,
      messages: "",
    });
    expect(await readFree(none, { diff: "hello" })).toMatchObject({ why: expect.any(String) });
    expect(await readFree(none, { source: "nonsense" })).toMatchObject({
      why: expect.stringContaining("none of"),
    });
    // No port for Git or the forge: said, not guessed.
    expect(await readFree(none, { source: "uncommitted" })).toMatchObject({
      why: expect.stringContaining("Git cannot be read"),
    });
    expect(await readFree(none, { source: "pr:3" })).toMatchObject({
      why: expect.stringContaining("forge"),
    });
  });

  it("hands the request to Git as it was parsed, and refuses an empty change", async () => {
    const seen: unknown[] = [];
    const context = {
      storyDiff: {
        diff: async () => undefined,
        free: async (request: unknown) => {
          seen.push(request);
          return seen.length === 1
            ? { diff: DIFF, messages: "Fix it\n---\n" }
            : { diff: "", messages: "" };
        },
      },
    } as unknown as CommandContext;
    expect(await readFree(context, { source: "a..b" })).toEqual({
      label: "a..b",
      diff: DIFF,
      messages: "Fix it\n---\n",
    });
    expect(await readFree(context, { source: "branch:x" })).toMatchObject({
      why: "branch:x has no change to review",
    });
    expect(seen).toEqual([
      { kind: "range", from: "a", to: "b", dots: ".." },
      { kind: "branch", name: "x" },
    ]);
  });
});
