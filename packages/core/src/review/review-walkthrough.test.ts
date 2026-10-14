import { describe, expect, it } from "vitest";
import type { ReuseReport } from "../reuse/reuse.js";
import type { StackEntry } from "./review-lenses.js";
import { parseDiff } from "./review-rules.js";
import {
  MAX_ACTIONS,
  type UxFlow,
  uxFlows,
  WALK_CHARS,
  WALK_MIN_CHARS,
  WALK_STOPS,
  type WalkCriterion,
  type WalkInputs,
  WEIGHTS,
  walkCriteria,
  walkSlot,
  walkthrough,
  walkthroughText,
} from "./review-walkthrough.js";

/** A diff that adds `lines` lines at line 1 of each path (a new file when `created`). */
function diffOf(
  ...entries: Array<{ path: string; lines?: number; created?: boolean; at?: number }>
): string {
  return entries
    .map(({ path, lines = 3, created = false, at = 1 }) =>
      [
        `diff --git a/${path} b/${path}`,
        ...(created ? ["new file mode 100644"] : []),
        created ? "--- /dev/null" : `--- a/${path}`,
        `+++ b/${path}`,
        created ? `@@ -0,0 +1,${lines} @@` : `@@ -${at},0 +${at},${lines} @@`,
        ...Array.from({ length: lines }, (_, index) => `+line ${index}`),
        "",
      ].join("\n"),
    )
    .join("");
}

const entry = (over: Partial<StackEntry> & Pick<StackEntry, "severity">): StackEntry => ({
  title: "A finding",
  decision: null,
  ...over,
});

const criterion = (over: Partial<WalkCriterion> & Pick<WalkCriterion, "n">): WalkCriterion => ({
  text: "She sees her name.",
  status: "no_test",
  origin: null,
  tests: [],
  ...over,
});

function inputs(over: Partial<WalkInputs> & { diff: string }): WalkInputs {
  const { diff, ...rest } = over;
  return { files: parseDiff(diff), findings: [], criteria: [], ...rest };
}

describe("the order of reading", () => {
  it("reads the riskiest file first, then the rest by kind and path, tests after the code they prove", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf(
          { path: "src/zeta.ts" },
          { path: "src/alpha.ts" },
          { path: "src/auth/login.ts" },
          { path: "src/auth/login.test.ts" },
          { path: "README.md" },
        ),
        findings: [entry({ severity: "blocking", path: "src/zeta.ts", line: 2 })],
        criteria: [criterion({ n: 1, tests: ["src/auth/login.test.ts:4"] })],
      }),
    );
    expect(walk.stops.map((stop) => stop.path)).toEqual([
      "src/zeta.ts",
      "src/auth/login.ts",
      // The test that proves a criterion is read just after the code it proves.
      "src/auth/login.test.ts",
      "src/alpha.ts",
      "README.md",
    ]);
    const [first, second] = walk.stops;
    expect(first?.why).toEqual(["1 blocking finding open"]);
    expect(first?.score).toBe(WEIGHTS.blocking);
    // A sensitive path serving a criterion through its test: two reasons.
    expect(second?.why).toEqual(["sensitive path", "criterion 1"]);
  });

  it("gives the same walk whatever the order of the files (100 shuffles)", () => {
    const paths = ["a.ts", "b/c.ts", "b/d.test.ts", "package.json", "e/f.md", "src/auth/g.ts"];
    const base = walkthrough(
      inputs({
        diff: diffOf(...paths.map((path) => ({ path }))),
        findings: [entry({ severity: "should_fix", path: "b/c.ts", line: 2 })],
      }),
    );
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 100; round++) {
      const shuffled = [...paths].sort(() => random() - 0.5);
      const walk = walkthrough(
        inputs({
          diff: diffOf(...shuffled.map((path) => ({ path }))),
          findings: [entry({ severity: "should_fix", path: "b/c.ts", line: 2 })],
        }),
      );
      expect(walk).toEqual(base);
    }
  });

  it("weighs dependencies, migrations, the guard, duplicates and fixed findings", () => {
    const reuse = {
      duplicates: [
        {
          here: { path: "src/copy.ts", from: 10, to: 30 },
          there: { path: "src/original.ts", from: 5, to: 25 },
          tokens: 80,
          others: 0,
        },
      ],
      twins: [],
      partial: false,
      files: 3,
      ms: 1,
    } as unknown as ReuseReport;
    const walk = walkthrough(
      inputs({
        diff: diffOf(
          { path: "package.json" },
          { path: "db/migrations/001.sql", created: true },
          { path: "src/copy.ts", at: 10, lines: 21 },
          { path: "src/guarded.ts" },
          { path: "src/fixed.ts" },
        ),
        reuse,
        guarded: ["src/guarded.ts"],
        // Fixed before the creator saw it: it weighs nothing.
        findings: [entry({ severity: "blocking", path: "src/fixed.ts", line: 1, decision: "fix" })],
      }),
    );
    const byPath = new Map(walk.stops.map((stop) => [stop.path, stop]));
    expect(byPath.get("package.json")?.why[0]).toBe("dependencies");
    expect(byPath.get("db/migrations/001.sql")?.why[0]).toBe("migration");
    expect(byPath.get("src/copy.ts")?.why).toEqual(["repeats src/original.ts:5"]);
    expect(byPath.get("src/guarded.ts")?.why).toEqual(["guard refused or widened"]);
    expect(byPath.get("src/fixed.ts")?.why).toEqual([]);
    expect(walk.stops.at(-1)?.path).toBe("src/fixed.ts");
  });

  it("names the lines to look at: the finding's line, the duplicate's range, else the added lines", () => {
    const reuse = {
      duplicates: [
        {
          here: { path: "b.ts", from: 10, to: 30 },
          there: { path: "o.ts", from: 1, to: 21 },
          tokens: 80,
          others: 0,
        },
      ],
      twins: [],
      partial: false,
      files: 1,
      ms: 1,
    } as unknown as ReuseReport;
    const walk = walkthrough(
      inputs({
        diff: diffOf(
          { path: "a.ts", lines: 4, at: 5 },
          { path: "b.ts", lines: 21, at: 10 },
          {
            path: "c.ts",
            lines: 2,
            at: 40,
          },
        ),
        findings: [
          entry({ severity: "should_fix", path: "a.ts", line: 6 }),
          entry({ severity: "minor", path: "a.ts", line: 40 }),
        ],
        reuse,
      }),
    );
    const ranges = (path: string) => walk.stops.find((stop) => stop.path === path)?.ranges;
    expect(ranges("a.ts")).toEqual([
      [6, 6],
      [40, 40],
    ]);
    expect(ranges("b.ts")).toEqual([[10, 30]]);
    expect(ranges("c.ts")).toEqual([[40, 41]]);
  });

  it("shows at most the stops it can and counts the rest, locks included", () => {
    const paths = Array.from({ length: 9 }, (_, index) => `src/file${index}.ts`);
    const walk = walkthrough(
      inputs({ diff: diffOf(...paths.map((path) => ({ path })), { path: "pnpm-lock.yaml" }) }),
    );
    expect(walk.stops).toHaveLength(WALK_STOPS);
    // Three files past the limit, and the lockfile that is never read by hand.
    expect(walk.more).toBe(9 - WALK_STOPS + 1);
    expect(walk.stops.map((stop) => stop.path)).not.toContain("pnpm-lock.yaml");
  });

  it("does not repeat a finding's words: the stack holds them", () => {
    const text = walkthroughText(
      walkthrough(
        inputs({
          diff: diffOf({ path: "src/a.ts" }),
          findings: [
            entry({
              severity: "blocking",
              title: "Crash on an empty profile",
              recommendation: "Show an empty state.",
              path: "src/a.ts",
              line: 2,
            }),
          ],
        }),
      ),
    );
    expect(text).toContain("src/a.ts:2 (1 blocking finding open)");
    expect(text).not.toContain("Crash on an empty profile");
    expect(text).not.toContain("empty state");
  });
});

describe("what the order does not get wrong (corrections of the review)", () => {
  it("knows a file the guard refused by the path the write named, and a widened folder", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf(
          { path: "apps/cli/src/a.ts" },
          { path: "packages/core/b.ts" },
          { path: "c.ts" },
        ),
        guarded: ["C:/work/wt/apps/cli/src/a.ts", "packages/"],
      }),
    );
    const why = (path: string) => walk.stops.find((stop) => stop.path === path)?.why;
    expect(why("apps/cli/src/a.ts")).toEqual(["guard refused or widened"]);
    expect(why("packages/core/b.ts")).toEqual(["guard refused or widened"]);
    expect(why("c.ts")).toEqual([]);
  });

  it("does not demote a test that carries an open finding", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf({ path: "src/auth/login.ts" }, { path: "src/a.test.ts" }),
        findings: [entry({ severity: "blocking", path: "src/a.test.ts", line: 3 })],
      }),
    );
    expect(walk.stops[0]).toMatchObject({ path: "src/a.test.ts", score: WEIGHTS.blocking });
  });

  it("keeps the lines that weigh most, shown in line order, and the heaviest reason first", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf({ path: "src/auth/session.ts", lines: 500 }),
        findings: [
          entry({ severity: "minor", path: "src/auth/session.ts", line: 1 }),
          entry({ severity: "minor", path: "src/auth/session.ts", line: 5 }),
          entry({ severity: "minor", path: "src/auth/session.ts", line: 9 }),
          entry({ severity: "blocking", path: "src/auth/session.ts", line: 400 }),
        ],
      }),
    );
    expect(walk.stops[0]?.ranges).toEqual([
      [1, 1],
      [5, 5],
      [400, 400],
    ]);
    expect(walk.stops[0]?.why).toEqual([
      "1 blocking finding open",
      "sensitive path",
      "3 minor findings open",
    ]);
  });

  it("links a test to the file beside it, not to every file of that name", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf({ path: "packages/a/src/index.ts" }, { path: "packages/b/src/index.ts" }),
        criteria: [criterion({ n: 1, tests: ["packages/a/src/index.test.ts:4"] })],
      }),
    );
    const why = (path: string) => walk.stops.find((stop) => stop.path === path)?.why;
    expect(why("packages/a/src/index.ts")).toEqual(["criterion 1"]);
    expect(why("packages/b/src/index.ts")).toEqual([]);
    // A test in the folder of tests of the same package still counts.
    const apart = walkthrough(
      inputs({
        diff: diffOf({ path: "packages/a/src/load.ts" }),
        criteria: [criterion({ n: 2, tests: ["packages/a/src/__tests__/load.test.ts:4"] })],
      }),
    );
    expect(apart.stops[0]?.why).toEqual(["criterion 2"]);
  });

  it("says plainly that the tests prove everything when they do", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf({ path: "src/a.ts" }),
        criteria: [
          criterion({ n: 1, status: "green", origin: "engine", tests: ["src/a.test.ts:1"] }),
          criterion({ n: 2, status: "covered", origin: "engine", tests: ["src/a.test.ts:9"] }),
        ],
      }),
    );
    // Room for the lines of the proven criteria: they are listed.
    expect(walkthroughText(walk)).toContain("To try by hand: AC1 (tests cover it");
    // Short of room, one sentence replaces them: no empty "To try by hand".
    const text = walkthroughText(walk, 170);
    expect(text).toContain("Tests already prove 1,2 of 2: do not redo.");
    expect(text).not.toContain("To try by hand");
  });
});

describe("how to see each criterion by hand", () => {
  const flows: UxFlow[] = [
    {
      name: "Open a profile",
      covers: ["EF-1"],
      steps: ["Sign in", "Open the profile page", "Read the name", "Log out"],
    },
  ];

  it("says what the tests already prove and gives steps to the others", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf({ path: "src/a.ts" }),
        criteria: [
          criterion({ n: 1, status: "green", origin: "engine", tests: ["src/a.test.ts:12"] }),
          criterion({ n: 2, status: "green", origin: "reported", tests: ["src/a.test.ts:30"] }),
          criterion({
            n: 3,
            status: "no_test",
            text: "Run `corepack pnpm test` and see 12 tests pass.",
          }),
          criterion({ n: 4, status: "untestable", text: "The page looks calm.", reason: "taste" }),
          criterion({ n: 5, status: "covered", origin: "engine", tests: ["x.test.ts"] }),
        ],
      }),
    );
    expect(walk.steps.map((step) => [step.n, step.proven])).toEqual([
      [1, true],
      [2, false],
      [3, false],
      [4, false],
      [5, true],
    ]);
    expect(walk.steps[0]?.covered).toBe("src/a.test.ts:12");
    // The command written in the criterion is the step to run; the criterion's words are the expectation.
    expect(walk.steps[2]?.steps).toEqual([
      "run `corepack pnpm test`",
      "expect: Run corepack pnpm test and see 12 tests pass",
    ]);
    // Without a command nor a journey: a plain step; the reason it has no test is kept.
    expect(walk.steps[3]?.steps.at(0)).toBe("open it where the change shows and try it");
    expect(walk.steps[3]?.steps.at(-1)).toContain("(no test: taste)");
    for (const step of walk.steps) expect(step.steps.length).toBeLessThanOrEqual(MAX_ACTIONS + 1);
  });

  it("takes the steps from the journey of the user experience that covers the story", () => {
    const walk = walkthrough(
      inputs({
        diff: diffOf({ path: "src/a.ts" }),
        criteria: [
          criterion({ n: 1, text: "She sees her name (EF-1)." }),
          criterion({ n: 2, text: "Nothing about it." }),
          criterion({ n: 3, text: "She is greeted (EF-9)." }),
        ],
        flows,
        requirements: ["EF-1"],
      }),
    );
    expect(walk.steps[0]?.steps[0]).toBe(
      'follow the journey "Open a profile": Sign in > Open the profile page > Read the name',
    );
    // A criterion with no id of its own follows the story's requirements; one citing another id, none.
    expect(walk.steps[1]?.steps[0]).toContain("Open a profile");
    expect(walk.steps[2]?.steps[0]).toBe("open it where the change shows and try it");
  });

  it("reads the journeys of the specification and ignores the rest", () => {
    const text = [
      "# UX",
      "## Key flows",
      "### Open a profile",
      "Covers: PU-1, EF-1.",
      "1. She sees the list — taps her name — the profile opens",
      "2. She reads it",
      "- Moment of value: now",
      "### Orphan",
      "1. no covers line",
      "## Component behaviour",
      "### Not a flow",
      "Covers: EF-2.",
      "1. nope",
    ].join("\n");
    expect(uxFlows(text)).toEqual([
      {
        name: "Open a profile",
        covers: ["PU-1", "EF-1"],
        steps: ["She sees the list — taps her name — the profile opens", "She reads it"],
      },
    ]);
    expect(uxFlows("# no flows here")).toEqual([]);
  });

  it("builds the criteria from the trace the engine computed", () => {
    expect(walkCriteria(["one", "two"], undefined)).toEqual([]);
    expect(
      walkCriteria(["one", "two"], {
        story: "1-1",
        criteria: [
          { n: 1, status: "green", origin: "engine", tests: ["a.test.ts:1"] },
          { n: 2, status: "untestable", origin: "reported", tests: [], reason: "taste" },
        ],
        line: "",
        missing: [],
        untestable: [],
        quick: false,
      }),
    ).toEqual([
      { n: 1, text: "one", status: "green", origin: "engine", tests: ["a.test.ts:1"] },
      { n: 2, text: "two", status: "untestable", origin: "reported", tests: [], reason: "taste" },
    ]);
  });
});

describe("one screen, then the decision", () => {
  const big = inputs({
    diff: diffOf(
      ...Array.from({ length: 12 }, (_, index) => ({
        path: `packages/core/src/some/deep/folder/module-${index}.ts`,
        lines: 30,
      })),
    ),
    findings: Array.from({ length: 12 }, (_, index) =>
      entry({
        severity: index === 0 ? "blocking" : "should_fix",
        path: `packages/core/src/some/deep/folder/module-${index}.ts`,
        line: 3 + index,
        criterion: (index % 4) + 1,
      }),
    ),
    criteria: Array.from({ length: 12 }, (_, index) =>
      criterion({
        n: index + 1,
        status: index % 3 === 0 ? "green" : "no_test",
        origin: "engine",
        tests: index % 3 === 0 ? [`packages/core/src/some/deep/folder/m-${index}.test.ts:10`] : [],
        text: `When she does thing number ${index + 1} with \`corepack pnpm run thing-${index + 1}\`, the screen shows the result and it stays readable.`,
      }),
    ),
  });

  it("fits in one screen, whatever the size of the change", () => {
    const text = walkthroughText(walkthrough(big));
    expect(text.length).toBeLessThanOrEqual(WALK_CHARS);
    expect(text.length).toBeGreaterThan(WALK_MIN_CHARS);
    expect(text.startsWith("Read first, riskiest first: 1) packages/core/")).toBe(true);
    expect(text).toContain("To try by hand:");
  });

  it("fits any room it is given, keeps the riskiest file, and never cuts the room", () => {
    const walk = walkthrough(big);
    for (let room = WALK_MIN_CHARS; room <= 1200; room += 7) {
      const text = walkthroughText(walk, room);
      expect(text.length, `room ${room}`).toBeLessThanOrEqual(Math.min(room, WALK_CHARS));
      expect(text, `room ${room}`).toContain("module-0.ts");
    }
    expect(walkthroughText(walk, WALK_MIN_CHARS - 1)).toBe("");
  });

  it("says first what the tests prove when the room is short, and counts what it leaves", () => {
    const walk = walkthrough(big);
    const text = walkthroughText(walk, 520);
    expect(text).toMatch(/Tests already prove 1,4,7,10 of 12: do not redo\.$/);
    expect(text).toMatch(/\+\d+ criteri(?:a|on), see the story/);
    expect(text).toMatch(/\+\d+ more files?, lower risk/);
  });

  it("gives nothing when there is nothing to walk", () => {
    expect(walkthroughText(walkthrough({ files: [], findings: [], criteria: [] }))).toBe("");
    // Only a lockfile: nothing to read by hand, no steps.
    expect(walkthroughText(walkthrough(inputs({ diff: diffOf({ path: "pnpm-lock.yaml" }) })))).toBe(
      "",
    );
  });

  it("takes only the room a summary leaves, and leaves the closing sentence whole", () => {
    const walk = walkthrough(big);
    const bare = "x".repeat(1900);
    expect(walkSlot(walk, bare)).toBe("");
    const roomy = "x".repeat(900);
    expect(walkSlot(walk, roomy).length).toBeLessThanOrEqual(2000 - roomy.length - 1);
    expect(walkSlot(walk, roomy).length).toBeGreaterThan(0);
  });
});
