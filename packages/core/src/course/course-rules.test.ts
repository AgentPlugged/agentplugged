import { MAX_COURSE_STACK } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CourseItem,
  type CourseRecord,
  checkCourse,
  computeImpact,
  courseHolds,
  courseNote,
  courseView,
  handoffs,
  type ImpactInputs,
  leftLines,
  signatureOf,
  validateDecisions,
} from "./course-rules.js";

/**
 * The rules of the correction of course, without an engine: the impact is read from
 * the documents, the state and the tests it is given, sorted and bounded; the engine's check finds
 * what is still incoherent; the gestures fit the stack.
 */

const header = (id: string, kind: string, owner: string, extra = "") =>
  `---\nid: ${id}\nkind: ${kind}\nowner: ${owner}\n${extra}---\n`;

const PRD = {
  path: ".agentplugged/docs/prd.md",
  text: `${header("prd", "prd", "maya")}# PRD\n\n## Audience\n\n- EF-1: Visitors sign in.\n- EF-2: Visitors export.\n- ENF-1: Fast, measured by \`pnpm bench\`.\n`,
};
const ARCHITECTURE = {
  path: ".agentplugged/docs/architecture.md",
  text: `${header("architecture", "architecture", "alex")}# Architecture\n\n### AD-1 — One writer per piece of data\n\nSign-in (EF-1) goes through the gateway.\n`,
};
const story = (id: string, requirements: string[], criteria = 2) => ({
  path: `.agentplugged/stories/${id}-x.md`,
  text: `${header(id, "story", "hugo", `requirements: [${requirements.join(", ")}]\n`)}# Story ${id}\n\n## Acceptance criteria\n\n${Array.from({ length: criteria }, (_, index) => `- Criterion ${index + 1}.`).join("\n")}\n`,
});

const inputs = (
  files: ImpactInputs["files"],
  state: Record<string, unknown> = {},
  tests: ImpactInputs["tests"] = null,
): ImpactInputs => ({ files, state, tests });

const refs = (impact: ReturnType<typeof computeImpact>) =>
  "stack" in impact ? impact.stack.map((entry) => `${entry.kind}:${entry.ref}`) : impact;

describe("the impact of a change, computed from the trace", () => {
  const files = [PRD, ARCHITECTURE, story("1-1", ["EF-1"]), story("1-2", ["EF-2"])];

  it("sorts the most structuring first: decisions, requirements, documents, stories", () => {
    const impact = computeImpact(["EF-1", "AD-1"], inputs(files));
    expect(refs(impact)).toEqual([
      "decision:AD-1",
      "requirement:EF-1",
      "document:.agentplugged/docs/architecture.md",
      "story:1-1",
    ]);
    // The order does not depend on the order of the starts, nor on the order of the files.
    expect(refs(computeImpact(["AD-1", "EF-1"], inputs([...files].reverse())))).toEqual(
      refs(impact),
    );
  });

  it("follows an identifier into the documents that name it, not into those that do not", () => {
    const impact = computeImpact(["EF-1"], inputs(files));
    expect(refs(impact)).toContain("document:.agentplugged/docs/architecture.md");
    const only = computeImpact(["EF-2"], inputs(files));
    expect(refs(only)).toEqual(["requirement:EF-2", "story:1-2"]);
  });

  it("reads a story, a criterion and a passage as starts, and the identifiers a passage names", () => {
    const started = computeImpact(["1-2", "1-1#2", "prd#Audience"], inputs(files));
    expect(refs(started)).toEqual(["passage:prd#Audience", "story:1-2", "criterion:1-1#2"]);
    const named = computeImpact(["architecture#AD-1"], inputs(files));
    expect(refs(named)).toEqual(["decision:AD-1", "passage:architecture#AD-1"]);
  });

  it("names what it did not find, and computes nothing else", () => {
    expect(computeImpact(["EF-9", "9-9", "1-1#9", "prd#Nowhere", "hello"], inputs(files))).toEqual({
      unknown: ["EF-9", "9-9", "1-1#9", "prd#Nowhere", "hello"],
    });
  });

  it("counts criteria, test files and stale proofs from what it is given", () => {
    const state = {
      requirements: {
        at: "2026-10-01T00:00:00.000Z",
        items: {
          "ENF-1": {
            id: "ENF-1",
            digest: "d",
            since: "2026-10-01T00:00:00.000Z",
            stories: [],
            proved: { at: "2026-10-02T00:00:00.000Z", result: "pass" },
            gap: null,
          },
        },
      },
    };
    const tests = {
      lines: [
        { path: "src/a.test.ts", line: 1, text: "// ENF-1 is fast" },
        { path: "src/b.test.ts", line: 4, text: "it('AC-1-3-2 refuses')" },
      ],
      files: [],
    };
    const impact = computeImpact(
      ["ENF-1"],
      inputs([PRD, story("1-3", ["ENF-1"], 3)], state, tests),
    );
    if (!("stack" in impact)) throw new Error("expected a stack");
    expect(impact.proofs).toEqual(["ENF-1"]);
    expect(impact.stack[0]?.why).toContain("1 story, 1 test file, its proof goes stale");
    expect(impact.stack[1]?.why).toContain("3 criteria, 2 test files");
  });

  it("brings back an open hypothesis that names the identifier, and the page built on the document", () => {
    const page = {
      path: ".agentplugged/docs/reference/auth.md",
      text: `${header("kb-auth", "note", "zoe", `sources:\n  - path: .agentplugged/docs/prd.md\n    blob: ${"a".repeat(40)}\n`)}# Auth\n`,
    };
    const state = {
      hypotheses: {
        "H-7M2K9QX4TB-1": {
          id: "H-7M2K9QX4TB-1",
          claim: "Visitors will want a magic link.",
          refs: ["EF-1"],
          by: "quentin",
        },
        "H-7M2K9QX4TB-2": { id: "H-7M2K9QX4TB-2", claim: "Other.", refs: ["EF-2"], by: "quentin" },
      },
    };
    const impact = computeImpact(["EF-1"], inputs([PRD, page, story("1-1", ["EF-1"])], state));
    expect(refs(impact)).toEqual([
      "requirement:EF-1",
      "story:1-1",
      "hypothesis:H-7M2K9QX4TB-1",
      "page:.agentplugged/docs/reference/auth.md",
    ]);
  });

  it("holds the stack to its bound and counts the rest", () => {
    const many = Array.from({ length: MAX_COURSE_STACK + 20 }, (_, index) =>
      story(`2-${index + 1}`, ["EF-1"]),
    );
    const impact = computeImpact(["EF-1"], inputs([PRD, ...many]));
    if (!("stack" in impact)) throw new Error("expected a stack");
    expect(impact.stack).toHaveLength(MAX_COURSE_STACK);
    expect(impact.more).toBe(21);
    // The requirement, the most structuring, is never the one cut.
    expect(impact.stack[0]?.ref).toBe("EF-1");
  });

  it("never cuts a story under way from the stack, whatever else it holds", () => {
    const documents = Array.from({ length: MAX_COURSE_STACK + 5 }, (_, index) => ({
      path: `.agentplugged/docs/note-${index}.md`,
      text: `${header(`note-${index}`, "note", "maya")}Cites EF-1.
`,
    }));
    const state = {
      stories: {
        "2-1": { status: null, started: { agent: "hugo" } },
        "2-2": { status: null, started: { agent: "hugo" } },
      },
    };
    const impact = computeImpact(
      ["EF-1"],
      inputs([PRD, ...documents, story("2-1", ["EF-1"]), story("2-2", ["EF-1"])], state),
    );
    if (!("stack" in impact)) throw new Error("expected a stack");
    expect(impact.stack).toHaveLength(MAX_COURSE_STACK);
    expect(
      impact.stack.filter((entry) => entry.kind === "story").map((entry) => entry.ref),
    ).toEqual(["2-1", "2-2"]);
    expect(impact.stack.filter((entry) => entry.kind === "story")[0]?.developer).toBe("hugo");
    // 1 requirement + 85 documents + 2 stories = 88 elements, 80 kept.
    expect(impact.more).toBe(8);
  });

  it("names an identifier once, whatever the case it is typed in", () => {
    const impact = computeImpact(["EF-1", "ef-1"], inputs(files));
    expect(refs(impact)).toEqual([
      "requirement:EF-1",
      "document:.agentplugged/docs/architecture.md",
      "story:1-1",
    ]);
  });
});

/** A course of the state with the given stack. */
function course(
  items: Array<Partial<CourseItem> & Pick<CourseItem, "kind" | "ref">>,
): CourseRecord {
  return {
    id: "C-7M2K9QX4TB",
    at: "2026-10-12T10:00:00.000Z",
    by: "maya",
    summary: "A change.",
    quote: "words",
    starts: ["EF-1"],
    stack: items.map((item, index) => ({
      why: "why",
      gesture: null,
      reason: null,
      decided_at: null,
      ...item,
      n: index + 1,
    })),
    more: 0,
    proofs: [],
    status: "open",
    closed_at: null,
  };
}

describe("the gestures", () => {
  const open = course([
    { kind: "requirement", ref: "EF-1", owner: "maya" },
    { kind: "story", ref: "1-1", status: "in_progress", developer: "hugo", owner: "hugo" },
    { kind: "page", ref: "p.md", owner: "zoe" },
  ]);

  it("refuses what does not fit the stack, listing every problem", () => {
    expect(
      validateDecisions(open, {
        quote: "ok",
        items: [
          { n: 1, gesture: "keep" },
          { n: 2, gesture: "retire" },
          { n: 7, gesture: "update" },
          { n: 3, gesture: "update" },
          { n: 3, gesture: "keep", reason: "r" },
        ],
      }),
    ).toEqual([
      "1: keep needs a reason",
      "2: only a requirement or a decision is retired",
      "7: not in the stack",
      "3: twice",
    ]);
    expect(validateDecisions(undefined, { quote: "ok", items: [] })).toEqual(["course: unknown"]);
    expect(validateDecisions({ ...open, status: "closed" }, { quote: "ok" })).toEqual([
      "course: closed",
    ]);
  });

  it("hands each update to the author, and nothing for a keep", () => {
    expect(
      handoffs(open, [
        { n: 1, gesture: "retire" },
        { n: 2, gesture: "update" },
        { n: 3, gesture: "keep", reason: "r" },
      ]),
    ).toEqual([
      { owner: "maya", refs: ["retire EF-1"] },
      { owner: "hugo", refs: ["1-1"] },
    ]);
  });

  it("holds a story's merge while its element or one of its criteria waits, then lets go", () => {
    const state = (item: CourseRecord) => ({ courses: { [item.id]: item } });
    const waiting = course([
      { kind: "story", ref: "1-1" },
      { kind: "criterion", ref: "1-1#2" },
      { kind: "story", ref: "1-2", gesture: "keep", reason: "r" },
    ]);
    expect(courseHolds(state(waiting), "1-1")).toBe(2);
    expect(courseHolds(state(waiting), "1-2")).toBe(0);
    expect(courseHolds(state(waiting), "1-3")).toBe(0);
    expect(courseHolds(state({ ...waiting, status: "closed" }), "1-1")).toBe(0);
    expect(courseHolds({}, "1-1")).toBe(0);
  });

  it("tells state and next what is left, in a few lines", () => {
    const state = {
      courses: {
        [open.id]: {
          ...open,
          stack: open.stack.map((item, index) =>
            index === 0 ? { ...item, gesture: "update" as const } : item,
          ),
        },
      },
    };
    expect(courseView(state)).toMatchObject({ left: 2, total: 3, blocked: ["1-1 (hugo)"] });
    expect(courseNote(state)).toEqual({ id: open.id, left: 2, blocked: ["1-1 (hugo)"] });
    expect(courseView({})).toBeUndefined();
    const lines = leftLines(open, 2);
    expect(lines.lines).toEqual(["1. requirement · EF-1 — why", "2. story · 1-1 — why"]);
    expect(lines.more).toBe(1);
  });
});

describe("the check that everything is coherent again", () => {
  const retire = (ref: string, gesture: "retire" | "update" = "retire") =>
    course([{ kind: "requirement", ref, gesture, sig: signatureOf("Visitors sign in.") }]);

  it("wants a retired identifier to stay, marked retired, and no story to cite it", () => {
    const marked = `${header("prd", "prd", "maya")}# PRD\n\n- EF-1: (retired) Visitors sign in.\n`;
    const unmarked = `${header("prd", "prd", "maya")}# PRD\n\n- EF-1: Visitors sign in.\n`;
    const removed = `${header("prd", "prd", "maya")}# PRD\n\n- EF-2: Other.\n`;
    const prd = (text: string) => ({ path: PRD.path, text });
    expect(checkCourse(retire("EF-1"), [prd(marked)], {}).problems).toEqual([]);
    expect(checkCourse(retire("EF-1"), [prd(unmarked)], {}).problems).toEqual([
      "EF-1: not marked retired yet",
    ]);
    expect(checkCourse(retire("EF-1"), [prd(removed)], {}).problems).toEqual([
      "EF-1: removed, mark it retired (it stays, never reused)",
    ]);
    expect(checkCourse(retire("EF-1"), [prd(marked), story("1-1", ["EF-1"])], {}).problems).toEqual(
      ["story 1-1: cites EF-1, which is retired"],
    );
    // A story that cites another requirement, which the documents define, is fine; one that
    // cites an identifier no document defines is told, even if it was never retired.
    const withOther = prd(`${marked}- EF-2: Other.
`);
    expect(checkCourse(retire("EF-1"), [withOther, story("1-1", ["EF-2"])], {}).problems).toEqual(
      [],
    );
    expect(checkCourse(retire("EF-1"), [withOther, story("1-1", ["EF-9"])], {}).problems).toEqual([
      "story 1-1: cites EF-9, which no document defines",
    ]);
  });

  it("counts what is left to decide, and lists at most twelve problems", () => {
    const waiting = course([
      { kind: "story", ref: "1-1" },
      { kind: "page", ref: "p" },
    ]);
    expect(checkCourse(waiting, [PRD], {}).left).toBe(2);
    const stories = Array.from({ length: 15 }, (_, index) => story(`3-${index + 1}`, ["EF-1"]));
    const retired = {
      path: PRD.path,
      text: PRD.text.replace("- EF-1: Visitors", "- EF-1: (retired) Visitors"),
    };
    const check = checkCourse(waiting, [retired, ...stories], {});
    expect(check.problems).toHaveLength(12);
    expect(check.more).toBe(3);
  });

  it("wants what is marked update to have changed, and a removed requirement to be told whatever the gesture", () => {
    const unchanged = checkCourse(retire("EF-1", "update"), [PRD], {}).problems;
    expect(unchanged).toEqual([
      "EF-1: marked update, its text is unchanged (keep it, or change it)",
    ]);
    const kept = course([
      { kind: "requirement", ref: "EF-1", gesture: "keep", reason: "r", sig: signatureOf("x") },
      { kind: "document", ref: ".agentplugged/docs/ux.md", gesture: "update", sig: "0".repeat(12) },
      { kind: "page", ref: ".agentplugged/docs/gone.md", gesture: "update", sig: "0".repeat(12) },
    ]);
    const prdWithoutEf1 = {
      path: PRD.path,
      text: PRD.text.replace("- EF-1: Visitors sign in.\n", ""),
    };
    const ux = {
      path: ".agentplugged/docs/ux.md",
      text: `${header("ux", "ux", "stella")}# UX\n`,
    };
    // The old mark of the UX document is not its current one: it changed. The page is gone.
    expect(checkCourse(kept, [prdWithoutEf1, ux], {}).problems).toEqual([
      "EF-1: removed, mark it retired (it stays, never reused)",
      ".agentplugged/docs/gone.md: not found any more",
    ]);
    // A document whose text is the one marked is told.
    const same = course([
      { kind: "document", ref: ux.path, gesture: "update", sig: signatureOf(ux.text) },
    ]);
    expect(checkCourse(same, [ux], {}).problems).toEqual([
      `${ux.path}: marked update, nothing changed yet (keep it, or change it)`,
    ]);
  });

  it("does not ask for a changed text where the register holds no proof of it", () => {
    const changed = {
      path: PRD.path,
      text: PRD.text.replace("Visitors sign in.", "Visitors sign in with a link."),
    };
    expect(checkCourse(retire("EF-1", "update"), [changed], {}).problems).toEqual([]);
  });
});
