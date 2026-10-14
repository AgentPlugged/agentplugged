import { gitBlobId, utf8 } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  checkDocuments,
  checkDocumentsDetailed,
  comparablePath,
  knowledgePages,
  pathKey,
  staleKnowledgeSources,
  validatedVersions,
} from "../index.js";
import { answer, answered } from "../testing/checkpoint-state.js";

/** A page of the knowledge base behind a document the creator validated. */

const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);
const PRD = ".agentplugged/docs/prd.md";
const ARCHITECTURE = ".agentplugged/docs/architecture.md";
const PAGE = ".agentplugged/docs/reference/requirements.md";
const OWNERS = new Set(["zoe", "maya", "alex", "izzy"]);

function doc(id: string, owner: string, extra = "", body = ""): string {
  return `---\nid: ${id}\nkind: note\nowner: ${owner}\n${extra}---\n# ${id}\n${body}`;
}

const blobOf = (text: string) => gitBlobId(utf8(text));

/** Two versions of the PRD and one of the architecture, with their blobs. */
const PRD_A = doc("prd", "maya", "", "Version A.\n");
const PRD_B = doc("prd", "maya", "", "Version B.\n");
const ARCH = doc("architecture", "alex", "", "One unit.\n");
const A = blobOf(PRD_A);
const B = blobOf(PRD_B);
const C = blobOf(ARCH);

const page = (header: string, path = PAGE) => ({
  path,
  text: doc("kb-requirements", "zoe", header),
});
const prd = (text = PRD_B) => ({ path: PRD, text });
const architecture = { path: ARCHITECTURE, text: ARCH };

const hour = (n: number) => new Date(Date.UTC(2026, 9, 3, n)).toISOString();
/** The creator approves a `document` checkpoint citing `documents` at `n` o'clock. */
const approved = (id: string, n: number, documents: ReadonlyArray<readonly [string, string]>) =>
  answered(id, "approved", hour(n), documents);

const sources = (...entries: ReadonlyArray<readonly [string, string]>) =>
  `sources:\n${entries.map(([path, blob]) => `  - path: ${path}\n    blob: ${blob}\n`).join("")}`;

describe("knowledge base freshness: paths and tracking", () => {
  it("reads paths from .agentplugged/, absolute or relative, and compares them without case", () => {
    expect(comparablePath("app\\.agentplugged\\docs\\prd.md")).toBe(PRD);
    expect(comparablePath(`./${PRD}`)).toBe(PRD);
    expect(comparablePath(`C:\\work\\shop\\${PRD}`)).toBe(PRD);
    expect(comparablePath(`/home/ada/shop/${PRD}`)).toBe(PRD);
    expect(comparablePath("./docs/prd.md")).toBe("docs/prd.md");
    expect(pathKey(".agentplugged/docs/PRD.md")).toBe(PRD);
  });

  it("tracks the sources and the linked documents of a page, never another page", () => {
    const vision = { path: ".agentplugged/docs/vision.md", text: doc("kb-vision", "zoe") };
    const index = {
      path: ".agentplugged/docs/index.md",
      text: doc("kb-index", "zoe", "links:\n  - kb-vision\n  - kb-requirements\n"),
    };
    const pages = knowledgePages([
      prd(),
      architecture,
      vision,
      index,
      page(`links:\n  - prd\n  - EF-1\n${sources([ARCHITECTURE, A])}`),
    ]);
    expect(pages.map((entry) => entry.path)).toEqual([
      ".agentplugged/docs/index.md",
      PAGE,
      ".agentplugged/docs/vision.md",
    ]);
    expect(pages.find((entry) => entry.path.endsWith("index.md"))?.tracked).toEqual([]);
    const tracked = pages.find((entry) => entry.path === PAGE)?.tracked ?? [];
    expect(tracked.map(({ path, blob }) => ({ path, blob }))).toEqual([
      { path: ARCHITECTURE, blob: A },
      { path: PRD, blob: undefined },
    ]);
    // The versions this branch holds: the working copy, as written and with LF line endings.
    expect(tracked.find((entry) => entry.path === PRD)?.held).toContain(B);
    // A document of another owner is never a page.
    expect(
      knowledgePages([{ path: PRD, text: doc("prd", "maya", sources([ARCHITECTURE, A])) }]),
    ).toEqual([]);
  });

  it("reads a version written with CRLF line endings as its LF blob", () => {
    const crlf = { path: PRD, text: PRD_B.replaceAll("\n", "\r\n") };
    const pages = knowledgePages([crlf, page(`links: [prd]\n${sources([PRD, A])}`)]);
    const stale = staleKnowledgeSources(pages, [approved("G-1", 1, [[PRD, B]])], NOW);
    expect(stale.map((entry) => entry.reason)).toEqual(["stale"]);
  });

  it("never tracks the release notes, nor the stories and the epics", () => {
    const notes = {
      path: ".agentplugged/docs/release-notes/1-0-0.md",
      text: doc("kb-release-1-0-0", "zoe", "links: [prd]\n"),
    };
    const story = {
      path: ".agentplugged/stories/2-6-checkout.md",
      text: doc("story-note", "izzy"),
    };
    const pages = knowledgePages([prd(), notes, story, page("links: [story-note]\n")]);
    expect(pages.every((entry) => entry.tracked.length === 0)).toBe(true);
    // A new validation of the PRD leaves the release notes alone.
    expect(staleKnowledgeSources(pages, [approved("G-1", 1, [[PRD, B]])], NOW)).toEqual([]);
  });
});

describe("knowledge base freshness: validated versions", () => {
  it("keeps the last version the creator approved, never an open, refused or waived one", () => {
    const first = approved("G-1", 1, [[PRD, A]]);
    const end = answered("G-2", "approved", hour(2), [[`app/${ARCHITECTURE}`, C]], {
      type: "phase_end",
      phase: "design",
    });
    const open = answered("G-3", "approved", hour(3), [[PRD, B]], {
      status: "open",
      resolution: null,
    });
    const refused = answered("G-4", "rejected", hour(4), [[PRD, B]]);
    const changes = answered("G-5", "changes_requested", hour(5), [[PRD, B]]);
    const waived = answered("G-6", "waived", hour(6), [[PRD, B]], {
      resolution: answer("waived", hour(6), { waiver_until: "2026-12-01T00:00:00.000Z" }),
    });
    const story = answered("G-7", "approved", hour(7), [[PRD, B]], { type: "story" });
    const versions = validatedVersions([waived, story, changes, refused, open, end, first], NOW);
    expect(Object.fromEntries(versions)).toEqual({
      [PRD]: { checkpoint: "G-1", blob: A },
      [ARCHITECTURE]: { checkpoint: "G-2", blob: C },
    });
    // The order of the answers, not of the list.
    const later = approved("G-8", 8, [[PRD.toUpperCase(), B]]);
    expect(validatedVersions([later, first], NOW).get(PRD)).toEqual({ checkpoint: "G-8", blob: B });
  });

  it("finds a page behind a validated document, recorded or not", () => {
    const current = [prd(), architecture, page(`links: [prd, architecture]\n${sources([PRD, A])}`)];
    const pages = knowledgePages(current);
    // Never validated: nothing to compare with.
    expect(staleKnowledgeSources(pages, [], NOW)).toEqual([]);
    const checkpoints = [
      approved("G-1", 1, [[PRD, A]]),
      approved("G-2", 2, [
        [PRD, B],
        [ARCHITECTURE, C],
      ]),
    ];
    expect(staleKnowledgeSources(pages, checkpoints, NOW)).toEqual([
      {
        page: PAGE,
        source: ARCHITECTURE,
        reason: "unrecorded",
        checkpoint: "G-2",
        blob: C,
        recorded: undefined,
      },
      { page: PAGE, source: PRD, reason: "stale", checkpoint: "G-2", blob: B, recorded: A },
    ]);
    // Recorded with `./`, another case and an absolute path: the same documents, up to date.
    const updated = knowledgePages([
      prd(),
      architecture,
      page(
        `links: [prd, architecture]\n${sources(
          [`./${PRD.toUpperCase()}`, B],
          [`/home/ada/shop/${ARCHITECTURE}`, C],
        )}`,
      ),
    ]);
    expect(
      updated.find((entry) => entry.path === PAGE)?.tracked.map((entry) => entry.blob),
    ).toEqual([C, B]);
    expect(staleKnowledgeSources(updated, checkpoints, NOW)).toEqual([]);
  });

  it("waits for this branch to hold the validated version", () => {
    // Validated on a feature branch at B; this branch (the main one) still holds A.
    const onMain = knowledgePages([prd(PRD_A), page(`links: [prd]\n${sources([PRD, A])}`)]);
    const checkpoints = [approved("G-1", 1, [[PRD, A]]), approved("G-2", 2, [[PRD, B]])];
    expect(staleKnowledgeSources(onMain, checkpoints, NOW)).toEqual([]);
    // Merged: the working copy is B, and the page is behind.
    const merged = knowledgePages([prd(PRD_B), page(`links: [prd]\n${sources([PRD, A])}`)]);
    expect(staleKnowledgeSources(merged, checkpoints, NOW)).toHaveLength(1);
    // The document gone from the working copy: nothing is held.
    const gone = knowledgePages([page(`${sources([PRD, A])}`)]);
    expect(staleKnowledgeSources(gone, checkpoints, NOW)).toEqual([]);
  });
});

describe("knowledge base freshness in docs check", () => {
  it("warns, never failing, only when it is given the checkpoints", () => {
    const current = [prd(), page(`links: [prd]\n${sources([PRD, A])}`)];
    const checkpoints = [approved("G-2", 2, [[PRD, B]])];
    const checked = checkDocumentsDetailed({
      current,
      owners: OWNERS,
      validations: { checkpoints, now: NOW },
    });
    expect(checked.problems).toEqual([]);
    expect(checked.warnings).toEqual([
      {
        reason: "kb_stale",
        message_key: "docs.check.warning.kb_stale",
        details: { path: PAGE, source: PRD, checkpoint: "G-2", blob: B, recorded: A },
      },
    ]);
    const unrecorded = checkDocumentsDetailed({
      current: [prd(), page("links: [prd]\n")],
      owners: OWNERS,
      validations: { checkpoints, now: NOW },
    });
    expect(unrecorded.warnings.map((entry) => entry.reason)).toEqual(["kb_source_unrecorded"]);
    expect(checkDocumentsDetailed({ current, owners: OWNERS }).warnings).toEqual([]);
  });

  /** The problems of `docs check` for a page with this header, by field and reason. */
  const refusals = (header: string, path = PAGE) =>
    checkDocuments({ current: [prd(), architecture, page(header, path)], owners: OWNERS }).map(
      (problem) => {
        expect(problem).toMatchObject({
          code: ErrorCode.DOC_HEADER_INVALID,
          details: { path, line: 5 },
        });
        return [problem.details.field, problem.details.reason_key];
      },
    );

  it("refuses each invalid entry of sources, and keeps the valid ones", () => {
    expect(refusals("sources: x\n")).toEqual([["sources", "reason.docSource"]]);
    const header = `sources:\n  - x\n  - path: ${PRD}\n    blob: ${"A".repeat(40)}\n  - path: ${ARCHITECTURE}\n    blob: ${C}\n  - path: ${PRD}\n    blob: ${A}\n    note: x\n`;
    expect(refusals(header)).toEqual([
      ["sources.0", "reason.docSource"],
      ["sources.1", "reason.docSource"],
      ["sources.3", "reason.docSource"],
    ]);
    const tracked = knowledgePages([architecture, page(header)])[0]?.tracked ?? [];
    expect(tracked.map(({ path, blob }) => ({ path, blob }))).toEqual([
      { path: ARCHITECTURE, blob: C },
    ]);
  });

  it("refuses a source outside .agentplugged/docs/, a page of the base or on release notes", () => {
    const outside = sources(
      [".agentplugged/stories/2-6-checkout.md", A],
      ["src/main.ts", A],
      [".agentplugged/docs/../stories/x.md", A],
      [".agentplugged/docs/vision.md", A],
      [".agentplugged/docs/release-notes/1-0-0.md", A],
      [PAGE, A],
    );
    const vision = { path: ".agentplugged/docs/vision.md", text: doc("kb-vision", "zoe") };
    const problems = checkDocuments({ current: [vision, page(outside)], owners: OWNERS });
    expect(problems.map((problem) => [problem.details.field, problem.details.reason_key])).toEqual([
      ["sources.0", "reason.docSourceOutside"],
      ["sources.1", "reason.docSourceOutside"],
      ["sources.2", "reason.docSourceOutside"],
      ["sources.3", "reason.docSourcePage"],
      ["sources.4", "reason.docSourcePage"],
      ["sources.5", "reason.docSourcePage"],
    ]);
    const notes = ".agentplugged/docs/release-notes/1-0-0.md";
    expect(refusals(sources([PRD, A]), notes)).toEqual([["sources", "reason.docSourceRelease"]]);
  });

  it("reads an empty sources as none, and leaves another owner's key alone", () => {
    for (const header of ["sources:\n", "sources: []\n", "sources: null\n"]) {
      expect(refusals(header), header).toEqual([]);
    }
    const other = { path: PRD, text: doc("prd", "maya", "sources: x\n") };
    expect(checkDocuments({ current: [other], owners: OWNERS })).toEqual([]);
  });
});
