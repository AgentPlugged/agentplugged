import { describe, expect, it } from "vitest";
import { storySheetView } from "../stories/story-start.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import type { DocumentFile } from "./docs-base.js";
import { readSections } from "./read-command.js";
import {
  outlineOf,
  READING_MAX_LINES,
  READING_PLAN,
  readCommand,
  readingSelectors,
  readSelectors,
  stepReading,
} from "./read-sections.js";
import { sourceDocuments } from "./story-sheet.js";

const PRD = `---
id: prd
kind: prd
owner: maya
---
# Product requirements

## Glossary

- **Bill**: the amount before the tip.

## Journeys

- PU-1 : A diner splits a bill.

## Functional requirements

- EF-1 : A user can get the tip and the total for a bill.
  - A bill of 100.00 at 10 percent gives a tip of 10.00.
- EF-2 : A user can split the total between people.
- EF-3 : (retired) Old requirement.

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
- **Rule:** every amount is an integer number of cents.

### AD-2 — The calculation is a pure module

- **Binds:** EF-1

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

## Elements to build

| Id | Kind | Description | Where |
| --- | --- | --- | --- |
| UX-1 | component | tip form with three fields | Calculator |
`;

const STORY = `---
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

- Given a bill, when it runs, then the tip shows.

## Out of scope

- Splitting between people (\`EF-2\`): story 1-2.
`;

const FILES: DocumentFile[] = [
  { path: ".agentplugged/docs/prd.md", text: PRD },
  { path: ".agentplugged/docs/architecture.md", text: ARCHITECTURE },
  { path: ".agentplugged/docs/ux.md", text: UX },
  { path: ".agentplugged/stories/1-1.md", text: STORY },
];

const BIG = { total: 300, passage: 60 };

describe("reading by section", () => {
  it("gives the passage of an identifier and of a section, never more", () => {
    const reading = readSelectors(FILES, ["EF-1", "ux.md#calculator"], BIG);
    expect(reading.passages.map((found) => found.id)).toEqual(["EF-1", "ux.md#calculator"]);
    expect(reading.passages[0]?.text).toContain("tip of 10.00");
    expect(reading.passages[0]?.text).not.toContain("EF-2");
    expect(reading.passages[0]?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(reading.not_found).toEqual([]);
  });

  it("expands the groups in document order and leaves retired requirements out", () => {
    const requirements = readSelectors(FILES, ["@requirements"], BIG);
    expect(requirements.passages.map((found) => found.id)).toEqual(["EF-1", "EF-2", "ENF-1"]);
    expect(readSelectors(FILES, ["@constraints"], BIG).passages.map((p) => p.id)).toEqual([
      "ENF-1",
    ]);
    expect(readSelectors(FILES, ["@journeys"], BIG).passages.map((p) => p.id)).toEqual(["PU-1"]);
    expect(readSelectors(FILES, ["@decisions"], BIG).passages.map((p) => p.id)).toEqual([
      "AD-1",
      "AD-2",
    ]);
    expect(readSelectors(FILES, ["@screens"], BIG).passages.map((p) => p.id)).toEqual(["UX-1"]);
    expect(readSelectors(FILES, ["@stack"], BIG).passages.map((p) => p.id)).toEqual([
      "architecture.md#stack",
    ]);
  });

  it("gives what a story cites, without the stack and without its out of scope", () => {
    const reading = readSelectors(FILES, ["@cited:1-1"], BIG);
    expect(reading.passages.map((found) => found.id)).toEqual(["EF-1", "ENF-1", "AD-1", "UX-1"]);
  });

  it("gives the outline of a document named alone, not its text", () => {
    const reading = readSelectors(FILES, ["prd.md"], BIG);
    expect(reading.passages).toEqual([]);
    const outline = reading.outlines[0];
    expect(outline?.source).toBe("prd.md");
    expect(outline?.sections.map((entry) => entry.selector)).toContain("prd.md#glossary");
    expect(outlineOf(sourceDocuments(FILES), "nope.md")).toBeUndefined();
  });

  it("says what no document holds, and never invents it", () => {
    const reading = readSelectors(FILES, ["EF-99", "prd.md#nothing", "gone.md"], BIG);
    expect(reading.passages).toEqual([]);
    expect(reading.not_found).toEqual(["EF-99", "prd.md#nothing", "gone.md"]);
  });

  it("cuts a passage and names what does not fit", () => {
    const cut = readSelectors(FILES, ["EF-1"], { total: 300, passage: 1 });
    expect(cut.passages[0]?.more).toBe(1);
    const tight = readSelectors(FILES, ["@requirements"], { total: 2, passage: 10 });
    expect(tight.passages.map((found) => found.id)).toEqual(["EF-1"]);
    expect(tight.omitted).toEqual(["EF-2", "ENF-1"]);
  });
});

describe("the reading a step gives", () => {
  it("is the plan of the agent, within the lines allowed", () => {
    const reading = stepReading(FILES, "izzy", null);
    expect(reading?.passages.map((found) => found.id)).toEqual([
      "EF-1",
      "EF-2",
      "ENF-1",
      "PU-1",
      "AD-1",
      "AD-2",
      "UX-1",
    ]);
    const lines = reading?.passages.reduce((sum, found) => sum + found.text.split("\n").length, 0);
    expect(lines).toBeLessThanOrEqual(READING_MAX_LINES);
    expect(reading?.command).toContain("docs read");
  });

  it("gives a reviewer the passages of its story, and nothing without a story", () => {
    expect(readingSelectors("quentin", "1-1")).toEqual(["@cited:1-1"]);
    expect(readingSelectors("quentin", null)).toEqual([]);
    expect(stepReading(FILES, "quentin", null)).toBeUndefined();
    expect(stepReading(FILES, "quentin", "1-1")?.passages.map((found) => found.id)).toEqual([
      "EF-1",
      "ENF-1",
      "AD-1",
      "UX-1",
    ]);
  });

  it("gives nothing to an agent without a plan (a developer reads its sheet)", () => {
    expect(stepReading(FILES, "sam", "1-1")).toBeUndefined();
    expect(Object.keys(READING_PLAN)).not.toContain("sam");
  });

  it("names the passages left to ask for in its command", () => {
    const many = [
      ...FILES.slice(0, 1).map((file) => ({
        ...file,
        text: file.text.replace(
          "## Non-functional requirements",
          `${Array.from({ length: 90 }, (_, i) => `- EF-${i + 10} : Requirement ${i}.`).join("\n")}\n\n## Non-functional requirements`,
        ),
      })),
      ...FILES.slice(1),
    ];
    const reading = stepReading(many, "alex", null);
    expect(reading?.omitted.length).toBeGreaterThan(0);
    expect(reading?.command).toBe(readCommand([...(reading?.omitted ?? [])]));
  });
});

describe("the commands that give passages", () => {
  const memory = () =>
    new MemoryFiles(Object.fromEntries(FILES.map((file) => [file.path, file.text])));
  const context = () => ({
    files: memory(),
    tools: { detect: async () => [] } as never,
    method: shippedMethod(),
    actor: "human" as const,
    engineVersion: "1.0.0",
  });

  it("docs read gives the passages asked for and refuses what is not a selector", async () => {
    const read = await readSections(context(), ["EF-2", "@decisions", "prd.md"]);
    expect("passages" in read && read.passages.map((found) => found.id)).toEqual([
      "EF-2",
      "AD-1",
      "AD-2",
    ]);
    expect("outlines" in read && read.outlines).toHaveLength(1);
    const refused = await readSections(context(), ["../secret.md"]);
    expect(refused).toBeInstanceOf(Error);
    expect(await readSections(context(), [])).toBeInstanceOf(Error);
    expect(await readSections(context(), ["@nope"])).toBeInstanceOf(Error);
    const unknown = await readSections(context(), ["@cited:9-9"]);
    expect("not_found" in unknown && unknown.not_found).toEqual(["@cited:9-9"]);
  });

  it("start_story gives a story of the former format the passages it cites", async () => {
    const view = await storySheetView(memory(), "1-1");
    expect(view?.format).toBe("legacy");
    expect(view?.cited?.map((found) => found.id)).toEqual([
      "EF-1",
      "ENF-1",
      "AD-1",
      "UX-1",
      "architecture.md#stack",
    ]);
  });
});
