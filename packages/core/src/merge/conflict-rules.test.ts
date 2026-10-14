import { describe, expect, it } from "vitest";
import { hasConflictMarkers, parseConflictMarkers } from "./conflict-markers.js";
import {
  analyseConflict,
  checkResolution,
  conflictSummary,
  fileClass,
  forcedFiles,
  hunkClass,
  keepRuleOf,
  usefulLines,
} from "./conflict-rules.js";
import type { ConflictFileProbe, ConflictHunk, ConflictProbe } from "./merge-probe.js";

const hunk = (main: string[], story: string[], base: string[] = []): ConflictHunk => ({
  main,
  base,
  story,
});
const file = (path: string, hunks: ConflictHunk[], structural = false): ConflictFileProbe => ({
  path,
  structural,
  hunks,
  hunks_truncated: false,
});
const conflict = (files: ConflictFileProbe[]): Extract<ConflictProbe, { status: "conflict" }> => ({
  status: "conflict",
  main: "a".repeat(40),
  files,
  files_truncated: false,
});

describe("The markers of a conflicted file", () => {
  const marked = [
    "keep",
    "<<<<<<< main",
    "one",
    "||||||| base",
    "zero",
    "=======",
    "two",
    ">>>>>>> story",
    "tail",
    "<<<<<<< main",
    "x",
    "=======",
    "y",
    ">>>>>>> story",
  ].join("\n");

  it("reads the three sides of each block, with or without a base", () => {
    const { ok, hunks } = parseConflictMarkers(marked);
    expect(ok).toBe(true);
    expect(hunks).toEqual([
      { main: ["one"], base: ["zero"], story: ["two"] },
      { main: ["x"], base: [], story: ["y"] },
    ]);
  });

  it("refuses unbalanced or empty markers", () => {
    for (const text of [
      "<<<<<<< a\nx\n=======\ny\n",
      "x\n=======\ny\n>>>>>>> b\n",
      "<<<<<<< a\n<<<<<<< b\n=======\n>>>>>>> c\n",
      "no marker",
      ">>>>>>> alone\n",
    ]) {
      expect(parseConflictMarkers(text).ok, text).toBe(false);
    }
  });

  it("finds an opening or closing marker but not a Markdown underline", () => {
    expect(hasConflictMarkers("a\n<<<<<<< HEAD\nb")).toBe(true);
    expect(hasConflictMarkers("a\n>>>>>>> story")).toBe(true);
    expect(hasConflictMarkers("Title\n=======\ntext")).toBe(false);
    expect(hasConflictMarkers("x <<<<<<< y")).toBe(false);
  });
});

describe("What the engine reads of a conflict", () => {
  it("compares lines without whitespace nor blank lines", () => {
    expect(usefulLines(["  a b\t", "", "   ", "c"])).toEqual(["ab", "c"]);
  });

  it("calls whitespace what is the same code, additions what both sides add, the rest of substance", () => {
    expect(hunkClass(hunk(["a b  "], ["a b", ""]))).toBe("whitespace");
    // Inner spaces may sit in a string literal: never mere formatting.
    expect(hunkClass(hunk(['print("a  b")'], ['print("a b")']))).not.toBe("whitespace");
    // Indentation changes the meaning in some languages: never mere whitespace.
    expect(hunkClass(hunk(["if x:", "    run()"], ["if x:", "run()"], ["if x:"]))).toBe(
      "both_modified",
    );
    expect(hunkClass(hunk(["    run()"], ["\trun()"]))).not.toBe("whitespace");
    expect(hunkClass(hunk(["import a"], ["import b"]))).toBe("additions");
    expect(hunkClass(hunk(["x = 1"], ["x = 2"], ["x = 0"]))).toBe("both_modified");
    const big = Array.from({ length: 21 }, (_, index) => `line ${index}`);
    expect(hunkClass(hunk(big, ["other"]))).toBe("large");
    expect(hunkClass(hunk(big.slice(0, 20), ["other"]))).toBe("additions");
  });

  it("takes the heaviest class of a file, structural without a block", () => {
    expect(fileClass(file("a.ts", [hunk(["a"], ["a "]), hunk(["x"], ["y"])]))).toBe("additions");
    expect(fileClass(file("a.ts", [hunk(["a"], ["b"]), hunk(["x"], ["y"], ["z"])]))).toBe(
      "both_modified",
    );
    expect(fileClass(file("a.bin", [], true))).toBe("structural");
    expect(fileClass(file("a.ts", []))).toBe("structural");
    expect(fileClass({ ...file("a.ts", [hunk(["a"], ["b"])]), hunks_truncated: true })).toBe(
      "large",
    );
    expect(
      fileClass(
        file(
          "a.ts",
          Array.from({ length: 11 }, () => hunk(["a"], ["b"])),
        ),
      ),
    ).toBe("large");
  });

  it("lets a conflict be textual only when every block is text or additions, in bounds", () => {
    const light = analyseConflict(
      conflict([
        file("a.ts", [hunk(["import a"], ["import b"])]),
        file("b.ts", [hunk(["x"], ["x "])]),
      ]),
    );
    expect(light.ceiling).toBe("textual");
    expect(light.files).toEqual([
      { path: "a.ts", class: "additions" },
      { path: "b.ts", class: "whitespace" },
    ]);
    expect(forcedFiles(light)).toEqual([]);
    const heavy = analyseConflict(
      conflict([file("a.ts", [hunk(["x"], ["y"], ["z"])]), file("b.ts", [hunk(["i"], ["j"])])]),
    );
    expect(heavy.ceiling).toBe("substantive");
    expect(forcedFiles(heavy)).toEqual([{ path: "a.ts", class: "both_modified" }]);
    expect(analyseConflict(conflict([file("a.bin", [], true)])).ceiling).toBe("substantive");
    expect(analyseConflict(conflict([])).ceiling).toBe("substantive");
    expect(
      analyseConflict({ ...conflict([file("a.ts", [hunk(["i"], ["j"])])]), files_truncated: true })
        .ceiling,
    ).toBe("substantive");
    const many = Array.from({ length: 11 }, (_, index) =>
      file(`f${index}.ts`, [hunk(["i"], ["j"])]),
    );
    expect(analyseConflict(conflict(many)).ceiling).toBe("substantive");
  });

  it("asks a resolution to keep what the declaration promised", () => {
    expect(keepRuleOf("textual", undefined)).toBe("both");
    expect(keepRuleOf("substantive", "keep_story")).toBe("story");
    expect(keepRuleOf("substantive", "keep_main")).toBe("main");
    expect(keepRuleOf("substantive", "combine")).toBe("none");
  });
});

describe("The check of a resolution", () => {
  const files = [file("a.ts", [hunk(["import a"], ["import b"])])];
  const resolved = (text: string | undefined) => new Map([["a.ts", text]]);

  it("accepts a resolution that keeps both sides, in either order and with lines between", () => {
    expect(
      checkResolution({ files, keep: "both", resolved: resolved("import b\nrest\nimport a") }),
    ).toEqual({ ok: true, files: [] });
  });

  it("refuses a line moved out of its place, de-indented, or a side's order changed", () => {
    const two = [file("a.py", [hunk(["x = 1", "y = 2"], ["z = 3"])])];
    const at = (text: string) => new Map([["a.py", text]]);
    expect(
      checkResolution({ files: two, keep: "both", resolved: at("x = 1\ny = 2\nz = 3") }).ok,
    ).toBe(true);
    // The main side's two lines swapped: a choice.
    expect(
      checkResolution({ files: two, keep: "both", resolved: at("y = 2\nx = 1\nz = 3") }).ok,
    ).toBe(false);
    const indented = [file("a.py", [hunk(["    return x"], ["    return y"])])];
    // De-indented: in Python, another program.
    expect(
      checkResolution({ files: indented, keep: "both", resolved: at("return x\n    return y") }).ok,
    ).toBe(false);
  });

  it("refuses a resolution that loses a line of a side kept, or the file", () => {
    expect(checkResolution({ files, keep: "both", resolved: resolved("import a") })).toEqual({
      ok: false,
      why: "dropped",
      files: ["a.ts"],
    });
    expect(checkResolution({ files, keep: "both", resolved: resolved(undefined) }).why).toBe(
      "dropped",
    );
  });

  it("keeps one side when the creator chose it, nothing in particular when he combined", () => {
    expect(checkResolution({ files, keep: "story", resolved: resolved("import b") }).ok).toBe(true);
    expect(checkResolution({ files, keep: "story", resolved: resolved("import a") }).ok).toBe(
      false,
    );
    expect(checkResolution({ files, keep: "main", resolved: resolved("import a") }).ok).toBe(true);
    expect(checkResolution({ files, keep: "main", resolved: resolved("import b") }).ok).toBe(false);
    expect(checkResolution({ files, keep: "none", resolved: resolved("anything") }).ok).toBe(true);
    expect(checkResolution({ files, keep: "none", resolved: resolved(undefined) }).ok).toBe(true);
  });

  it("refuses a marker left, whatever the rule", () => {
    for (const keep of ["both", "none", "story"] as const) {
      expect(
        checkResolution({
          files,
          keep,
          resolved: resolved("import a\nimport b\n<<<<<<< main\n"),
        }),
      ).toEqual({ ok: false, why: "markers", files: ["a.ts"] });
    }
  });

  it("reads only the markers of a structural file", () => {
    const structural = [file("a.bin", [], true)];
    expect(
      checkResolution({ files: structural, keep: "both", resolved: new Map([["a.bin", "x"]]) }).ok,
    ).toBe(true);
    expect(
      checkResolution({
        files: structural,
        keep: "both",
        resolved: new Map([["a.bin", "<<<<<<< a"]]),
      }).why,
    ).toBe("markers");
  });
});

describe("The summary of a conflict of substance", () => {
  const base = {
    story: "4-3",
    main: "a".repeat(40),
    head: "b".repeat(40),
    rationale: "Both change the total.",
    recommendation: "keep_story" as const,
    files_truncated: false,
  };

  it("shows both versions of each block and the recommendation", () => {
    const text = conflictSummary({
      ...base,
      files: [
        {
          path: "src/cart.ts",
          class: "both_modified",
          hunks: [hunk(["total = a"], ["total = b"], ["total = 0"])],
        },
      ],
    });
    expect(text).toContain("Story 4-3 cannot merge cleanly");
    expect(text).toContain("keep_story");
    expect(text).toContain("Both change the total.");
    expect(text).toContain("src/cart.ts [both_modified]");
    expect(text).toContain("| total = a");
    expect(text).toContain("| total = b");
    expect(text.length).toBeLessThanOrEqual(2000);
  });

  it("never shows the lines of a sensitive file", () => {
    const text = conflictSummary({
      ...base,
      files: [
        { path: ".env", class: "both_modified", hunks: [hunk(["KEY=secret1"], ["KEY=secret2"])] },
      ],
    });
    expect(text).toContain(".env [both_modified]: content hidden");
    expect(text).not.toContain("secret1");
  });

  it("holds in 2000 characters without cutting a block, and counts what it leaves", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      path: `src/f${index}.ts`,
      class: "both_modified" as const,
      hunks: [hunk([`main ${index} ${"x".repeat(150)}`], [`story ${index} ${"y".repeat(150)}`])],
    }));
    const text = conflictSummary({ ...base, files: many });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/\(\d+ more block\(s\) in \d+ file\(s\) not shown/);
    // Every block shown is whole: a story line follows each main line.
    expect((text.match(/main branch:/g) ?? []).length).toBe((text.match(/, story:/g) ?? []).length);
  });

  it("says when a file has no readable block", () => {
    expect(
      conflictSummary({ ...base, files: [{ path: "img.png", class: "structural", hunks: [] }] }),
    ).toContain("img.png [structural]: no readable block");
  });
});
