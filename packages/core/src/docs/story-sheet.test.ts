import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import { checkDocumentsDetailed } from "./check-docs.js";
import type { DocumentFile } from "./docs-base.js";
import { parseDocumentFile } from "./parse-document.js";
import { writeSheets } from "./sheet-command.js";
import {
  anchorOf,
  fingerprintOf,
  passageAt,
  SHEET_MAX_LINES,
  sheetStateOf,
  sheetStates,
  sourceDocuments,
  writeSheet,
} from "./story-sheet.js";

const PRD = `---
id: prd
kind: prd
owner: maya
---
# Product requirements

## Glossary

- **Bill**: the amount before the tip.

## Functional requirements

- EF-1 : A user can get the tip and the total for a bill.
  - A bill of 100.00 at 10 percent gives a tip of 10.00.
  - A bill that is zero is refused with a reason.
- EF-2 : A user can split the total between people.

## Non-functional requirements

- ENF-1 : Amounts are exact to the cent.
`;

const ARCHITECTURE = `---
id: architecture
kind: architecture
owner: alex
links:
  - prd
---
# Architecture

## Decisions

### AD-1 — Money is integer cents

- **Binds:** EF-1, EF-2
- **Prevents:** rounding drift.
- **Rule:** every amount is an integer number of cents.

\`\`\`text
# not a heading: inside a fence
\`\`\`

### AD-2 — The calculation is a pure module

- **Binds:** EF-1
- **Prevents:** logic that needs a browser.
- **Rule:** \`src/tip.js\` imports nothing.

## Conventions

| Concern | Convention |
| --- | --- |
| Naming | camelCase functions |

## Stack

| Technology | Version |
| --- | --- |
| JavaScript | Node 20 |
`;

const UX = `---
id: ux
kind: ux
owner: stella
links:
  - prd
---
# UX specification

## Screen sketches

### Calculator

1. Bill: a decimal field.
2. Result: the tip and the total.

## Elements to build

| Id | Kind | Description | Where |
| --- | --- | --- | --- |
| UX-1 | component | tip form with three fields | Calculator |
`;

const EPIC = `---
id: epic-1
kind: epic
owner: izzy
title: "Tips"
links: [prd]
out_of_scope: [EF-2]
---
# Epic 1

## User value

A group gets the tip.
`;

function story(extra = "", criteria = 1): string {
  const lines = Array.from(
    { length: criteria },
    (_, i) => `- Given a bill ${i}, when it runs, then the tip shows.`,
  );
  return `---
id: 1-1
kind: story
owner: sam
links: [prd, architecture, ux]
title: "The calculation"
epic: epic-1
reviewer: quentin
requirements: [EF-1, ENF-1]
budget_usd: 5
branch: feat/1-1-the-calculation
depends_on: []
---
# 1-1 — The calculation

## Context

- Implements \`EF-1\` and \`ENF-1\`; follows \`AD-1\`; builds \`UX-1\`.

## Intent

Give the product its calculation.

## Acceptance criteria

${lines.join("\n")}

## Screen

- \`ux-mockups/calculator.html\`, sketch \`ux.md#calculator\`, builds \`UX-1\`.
${extra}
## Out of scope

- Splitting between people (\`EF-2\`): story 1-2.
`;
}

const STORY_PATH = ".agentplugged/stories/1-1.md";

function files(storyText: string, prd = PRD, architecture = ARCHITECTURE): DocumentFile[] {
  return [
    { path: ".agentplugged/docs/prd.md", text: prd },
    { path: ".agentplugged/docs/architecture.md", text: architecture },
    { path: ".agentplugged/docs/ux.md", text: UX },
    { path: ".agentplugged/epics/epic-1.md", text: EPIC },
    { path: STORY_PATH, text: storyText },
  ];
}

function written(storyText = story(), prd = PRD, architecture = ARCHITECTURE) {
  const all = files(storyText, prd, architecture);
  return writeSheet(parseDocumentFile(STORY_PATH, storyText), storyText, sourceDocuments(all));
}

const owners = new Set(["maya", "alex", "stella", "izzy", "sam", "quentin"]);

describe("the story sheet", () => {
  it("quotes every cited passage with its identifier, its document and a fingerprint", () => {
    const sheet = written();
    expect(sheet.unresolved).toEqual([]);
    const headings = sheet.text.split("\n").filter((line) => line.startsWith("### `"));
    expect(headings.map((line) => line.split(" · ").slice(0, 2).join(" · "))).toEqual([
      "### `EF-1` · prd.md",
      "### `ENF-1` · prd.md",
      "### `AD-1` · architecture.md",
      "### `UX-1` · ux.md",
      "### `ux.md#calculator` · ux.md",
      "### `architecture.md#stack` · architecture.md",
      "### `architecture.md#conventions` · architecture.md",
    ]);
    // The passage of a requirement takes the lines indented below it.
    expect(sheet.text).toContain("  - A bill that is zero is refused with a reason.");
    // A decision runs to the next heading of its level, fences included.
    expect(sheet.text).toContain("# not a heading: inside a fence");
    expect(sheet.text).not.toContain("The calculation is a pure module");
    // An element of the UX comes with its table's header.
    expect(sheet.text).toContain("| Id | Kind | Description | Where |");
    // The out of scope cites nothing: `EF-2` is another story's.
    expect(sheet.text).not.toContain("`EF-2` ·");
    expect(sheet.excerpts).toBe(7);
  });

  it("writes the same sheet twice, and keeps the story's own sections", () => {
    const once = written();
    const twice = written(once.text);
    expect(twice.text).toBe(once.text);
    expect(once.text).toContain("## Out of scope\n\n- Splitting between people");
  });

  it("passes docs check: the quoted definitions define nothing twice", () => {
    const sheet = written();
    const checked = checkDocumentsDetailed({ current: files(sheet.text), owners });
    expect(checked.problems).toEqual([]);
    expect(checked.warnings.map((warning) => warning.reason)).toEqual([]);
  });

  it("is up to date right after it is written", () => {
    const sheet = written();
    const state = sheetStates(files(sheet.text)).find((entry) => entry.story === "1-1");
    expect(state).toMatchObject({ format: "sheet", path: STORY_PATH, stale: [] });
    expect(state?.lines).toBe(sheet.lines);
  });

  it("says which cited passage changed, disappeared or is missing, with its text now", () => {
    const sheet = written();
    const prd = PRD.replace("gives a tip of 10.00", "gives a tip of 10.01");
    const architecture = ARCHITECTURE.replace(
      "### AD-1 — Money is integer cents",
      "### AD-1 — (retired) Money is integer cents",
    );
    const storyText = sheet.text.replace(
      "Give the product its calculation.",
      "Give the product its calculation (`PU-9` aside), and the split of `EF-2`.",
    );
    const all = files(storyText, prd, architecture);
    const state = sheetStateOf(
      parseDocumentFile(STORY_PATH, storyText),
      storyText,
      sourceDocuments(all),
    );
    expect(state.stale.map((excerpt) => [excerpt.id, excerpt.reason])).toEqual([
      ["EF-1", "changed"],
      ["AD-1", "gone"],
      ["EF-2", "missing"],
    ]);
    expect(state.stale[0]?.current?.text).toContain("gives a tip of 10.01");
    const warnings = checkDocumentsDetailed({ current: all, owners }).warnings;
    const stale = warnings.find((warning) => warning.reason === "sheet_stale");
    expect(stale?.details).toMatchObject({
      story: "1-1",
      excerpts: "EF-1 (changed), AD-1 (gone), EF-2 (missing)",
      command: "npx agentplugged docs sheet 1-1",
    });
  });

  it("refuses a sheet over the ceiling: the story is to be cut", () => {
    const sheet = written(story("", SHEET_MAX_LINES));
    expect(sheet.lines).toBeGreaterThan(SHEET_MAX_LINES);
    const problems = checkDocumentsDetailed({ current: files(sheet.text), owners }).problems;
    expect(problems.map((problem) => problem.code)).toEqual([ErrorCode.STORY_SHEET_TOO_LONG]);
    expect(problems[0]?.details).toMatchObject({ story: "1-1", max: SHEET_MAX_LINES });
  });

  it("keeps a story of the former format working: one warning proposes the conversion", () => {
    const long = story("", SHEET_MAX_LINES);
    const checked = checkDocumentsDetailed({ current: files(long), owners });
    // No excerpts: never refused for its length, the conversion only proposed.
    expect(checked.problems).toEqual([]);
    expect(checked.warnings).toEqual([
      expect.objectContaining({
        reason: "sheet_legacy",
        details: { stories: "1-1", count: 1, command: "npx agentplugged docs sheet" },
      }),
    ]);
    expect(sheetStates(files(long))[0]).toMatchObject({ format: "legacy", stale: [] });
    // A merged story is never told again.
    const merged = checkDocumentsDetailed({
      current: files(long),
      owners,
      validations: { checkpoints: [], now: 0, merges: [{ story: "1-1", seq: 1, files: [] }] },
    });
    expect(merged.warnings).toEqual([]);
  });

  it("names a citation no document holds, and invents nothing", () => {
    const storyText = story().replace("follows `AD-1`", "follows `AD-1` and `AD-7`");
    const sheet = written(storyText);
    expect(sheet.unresolved).toEqual(["AD-7"]);
    expect(sheet.text).toContain("Not found in the documents: `AD-7`.");
    expect(sheet.text).not.toContain("### `AD-7`");
  });

  it("reads anchors and fingerprints plainly", () => {
    expect(anchorOf("Écrans clés")).toBe("ecrans-cles");
    expect(anchorOf("Key `screens`")).toBe("key-screens");
    expect(fingerprintOf("a  \nb\n\n")).toBe(fingerprintOf("a\nb"));
    expect(fingerprintOf("a")).toMatch(/^[0-9a-f]{12}$/);
    expect(passageAt(["- EF-1 : one", "  - more", "", "- EF-2 : two"], 0)).toBe(
      "- EF-1 : one\n  - more",
    );
    // A text that goes on at the next line without indentation stays in the passage.
    expect(passageAt(["EF-1 : one", "goes on here.", "- EF-2 : two"], 0)).toBe(
      "EF-1 : one\ngoes on here.",
    );
    expect(passageAt(["- EF-1 : one", "", "Another paragraph."], 0)).toBe("- EF-1 : one");
  });

  it("keeps a too long sheet out of the sprint's validity: the start refuses it", async () => {
    const sheet = written(story("", SHEET_MAX_LINES));
    const memory = new MemoryFiles(
      Object.fromEntries(files(sheet.text).map((file) => [file.path, file.text])),
    );
    const stories = await readSprintStories(memory);
    expect(stories.get("1-1")?.faults).not.toContain(ErrorCode.STORY_SHEET_TOO_LONG);
  });

  it("keeps the line ends of a story written with CRLF, and sees no change in them", async () => {
    const sheet = written();
    const crlf = sheet.text.replace(/\n/g, "\r\n");
    const memory = new MemoryFiles(
      Object.fromEntries(
        files(crlf).map((file) => [file.path, file.path === STORY_PATH ? crlf : file.text]),
      ),
    );
    const result = await writeSheets(
      {
        files: memory,
        tools: { detect: async () => [] } as never,
        method: shippedMethod(),
        actor: "human",
        engineVersion: "1.0.0",
      },
      // Named by its file, as an agent may type it.
      [STORY_PATH],
    );
    expect(result).toMatchObject({ sheets: [{ story: "1-1", written: false }] });
  });
});
