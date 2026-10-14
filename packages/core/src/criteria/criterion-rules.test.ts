import { criteriaInLine, criterionId } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import {
  type CriterionRecord,
  citedCriteria,
  criterionHolds,
  criterionOrigin,
  criterionStatus,
  MAX_MISSING_LINES,
  MAX_TRACE_CRITERIA,
  missingLines,
  recordedTrace,
  traceLine,
} from "./criterion-rules.js";

/**
 * The rules of the acceptance criteria proved by tests written first:
 * where a criterion stands, the convention that links it to its tests in any language, the bounded
 * lines the story and the review show.
 */

const run = (origin: "engine" | "reported" = "engine", commit = "c") => ({
  origin,
  test: "tests",
  commit: commit.repeat(40),
  clean: true,
  at: "2026-10-12T10:00:00.000Z",
  event: "01E",
});

describe("where a criterion stands", () => {
  it("says no_test, not_run, red, never_red and green from what the journal holds", () => {
    expect(criterionStatus(undefined, false, false)).toBe("no_test");
    expect(criterionStatus(undefined, true, false)).toBe("not_run");
    expect(criterionStatus({ runs: 1, red: run() }, true, false)).toBe("red");
    // It passes, and nobody ever saw it fail: it proves nothing.
    expect(criterionStatus({ runs: 1, passed: run() }, true, false)).toBe("never_red");
    expect(criterionStatus({ runs: 2, red: run(), green: run("engine", "d") }, true, false)).toBe(
      "green",
    );
  });

  it("does not believe a green that ran on the commit of its red: nothing was written between", () => {
    const same = { runs: 2, red: run(), green: run() };
    expect(criterionStatus(same, true, false)).toBe("no_change");
    expect(criterionHolds("no_change")).toBe(false);
    // Work not committed yet is the norm while the code is written: the copy was not clean.
    const dirty = { ...run("engine", "c"), clean: false };
    expect(criterionStatus({ runs: 2, red: run(), green: dirty }, true, false)).toBe("green");
    expect(criterionStatus({ runs: 2, red: { ...dirty }, green: dirty }, true, false)).toBe(
      "green",
    );
    // A run that carries no commit proves nothing about the code's change either way.
    expect(
      criterionStatus({ runs: 2, red: { ...run(), commit: null }, green: run() }, true, false),
    ).toBe("green");
  });

  it("says no_test when no test cites the criterion any more, whatever was run", () => {
    const seen = { runs: 2, red: run(), green: run("engine", "d") };
    expect(criterionStatus(seen, false, false)).toBe("no_test");
    expect(criterionStatus({ runs: 1, red: run() }, false, false)).toBe("no_test");
    expect(criterionStatus({ runs: 1, passed: run() }, false, true)).toBe("no_test");
    // The tests could not be read (null): the runs are believed.
    expect(criterionStatus(seen, null, false)).toBe("green");
    expect(criterionStatus(undefined, null, false)).toBe("no_test");
  });

  it("lets the quick lane skip the red, and says so", () => {
    expect(criterionStatus({ runs: 1, passed: run() }, true, true)).toBe("covered");
    // A criterion that was seen failing is green all the same.
    expect(criterionStatus({ runs: 2, red: run(), green: run("engine", "d") }, true, true)).toBe(
      "green",
    );
    // A test never run is not covered, whatever the lane.
    expect(criterionStatus(undefined, true, true)).toBe("not_run");
  });

  it("holds only for green, covered and untestable", () => {
    const record: CriterionRecord = {
      runs: 0,
      untestable: { reason: "a sound", at: "t", event: "e" },
    };
    expect(criterionStatus(record, false, false)).toBe("untestable");
    for (const status of ["green", "covered", "untestable"] as const) {
      expect(criterionHolds(status)).toBe(true);
    }
    for (const status of ["no_test", "not_run", "never_red", "red"] as const) {
      expect(criterionHolds(status)).toBe(false);
    }
  });

  it("names who saw it: the engine, or the agent's word", () => {
    expect(criterionOrigin({ runs: 2, red: run("engine"), green: run("engine") })).toBe("engine");
    // One run the engine did not see makes the whole cycle the agent's word.
    expect(criterionOrigin({ runs: 2, red: run("reported"), green: run("engine") })).toBe(
      "reported",
    );
    expect(criterionOrigin({ runs: 2, red: run("engine"), green: run("reported") })).toBe(
      "reported",
    );
    expect(criterionOrigin({ runs: 1, red: run("reported") })).toBe("reported");
    expect(criterionOrigin(undefined)).toBeNull();
  });
});

describe("the lines the story and the review show are bounded", () => {
  it("writes one line, and marks what only an agent said", () => {
    expect(
      traceLine([
        { n: 1, status: "green", origin: "engine" },
        { n: 2, status: "green", origin: "reported" },
        { n: 3, status: "never_red", origin: "engine" },
        { n: 4, status: "no_test", origin: null },
        { n: 5, status: "untestable", origin: "reported" },
      ]),
    ).toBe("1:green 2:green(reported) 3:never_red 4:no_test 5:untestable");
  });

  it("counts what it does not show", () => {
    const many = Array.from({ length: 45 }, (_, index) => ({
      n: index + 1,
      status: "green" as const,
      origin: "engine" as const,
    }));
    const line = traceLine(many);
    expect(line.split(" ")).toHaveLength(MAX_TRACE_CRITERIA + 1);
    expect(line.endsWith("+15")).toBe(true);
    expect(line.length).toBeLessThan(400);
  });

  it("gives one short line per criterion that is missing something, at most twelve", () => {
    const lines = missingLines("17-3", [
      { n: 1, status: "green" },
      { n: 2, status: "no_test" },
      { n: 3, status: "never_red" },
      { n: 4, status: "red" },
      { n: 5, status: "not_run" },
      { n: 6, status: "untestable" },
    ]);
    expect(lines).toEqual([
      "2: no test cites it (name one AC-17-3-2)",
      "3: its test never failed before the code (it proves nothing)",
      "4: its test fails now",
      "5: its test was not run yet (story.criterion)",
    ]);
    const all = missingLines(
      "1-1",
      Array.from({ length: 30 }, (_, index) => ({ n: index + 1, status: "no_test" as const })),
    );
    expect(all).toHaveLength(MAX_MISSING_LINES + 1);
    expect(all.at(-1)).toBe("+18 more");
    expect(missingLines("1-1", [{ n: 1, status: "green" }])).toEqual([]);
  });

  it("shows only the criteria the engine saw in the state of the story", () => {
    expect(recordedTrace(undefined, false)).toBeUndefined();
    expect(
      recordedTrace(
        {
          "10": { runs: 1, red: run() },
          "2": { runs: 2, red: run(), green: run("reported", "d") },
        },
        false,
      ),
    ).toBe("2:green(reported) 10:red");
  });
});

/**
 * The convention that links a criterion to its tests: its id (`AC-17-3-2`, or `AC_17_3_2` where a
 * name takes no dash) in the test's name or in a comment, whatever the language.
 */
describe("a criterion's test is found by its id, in any language", () => {
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["TypeScript", "src/cart.test.ts", "it('AC-17-3-2 refuses an empty cart', () => {"],
    ["JavaScript", "test/cart.spec.js", 'describe("AC-17-3-2: empty cart", () => {'],
    ["Python", "tests/test_cart.py", "def test_AC_17_3_2_refuses_empty_cart():"],
    ["Python, lower case", "tests/test_cart.py", "def test_ac_17_3_2_refuses_empty_cart():"],
    ["Go", "cart/cart_test.go", "func TestAC_17_3_2_RefusesEmptyCart(t *testing.T) {"],
    ["Rust", "tests/cart.rs", "fn ac_17_3_2_refuses_empty_cart() {"],
    ["Java", "src/test/java/CartTest.java", "void AC_17_3_2_refusesEmptyCart() {"],
    ["Java, annotation", "src/test/java/CartTest.java", '@DisplayName("AC-17-3-2 empty cart")'],
    ["C#", "Cart.Tests/CartTests.cs", "public void AC_17_3_2_RefusesEmptyCart()"],
    ["Ruby", "spec/cart_spec.rb", 'it "AC-17-3-2 refuses an empty cart" do'],
    ["PHP", "tests/CartTest.php", "public function testAC_17_3_2_refusesEmptyCart()"],
    ["C", "test/test_cart.c", "void test_ac_17_3_2(void) {"],
    ["Perl", "t/cart.t", "sub test_AC_17_3_2 {"],
    ["Bats (shell)", "test/cart.bats", '@test "AC-17-3-2 refuses an empty cart" {'],
    ["a comment", "tests/cart_test.py", "# AC-17-3-2: an empty cart is refused"],
    ["a doc comment", "src/test/CartTest.kt", " * Criterion AC-17-3-2 of the story."],
  ];

  it.each(cases)("%s", (_language, path, text) => {
    const cited = citedCriteria("17-3", [{ path, line: 7, text }]);
    expect([...cited.keys()]).toEqual([2]);
    expect(cited.get(2)).toEqual([`${path}:7`]);
  });

  it("finds a test by its file's name too", () => {
    const cited = citedCriteria("17-3", [], ["tests/ac_17_3_2_test.go", "src/ac_17_3_3.go"]);
    expect([...cited.keys()]).toEqual([2]);
    expect(cited.get(2)).toEqual(["tests/ac_17_3_2_test.go"]);
  });

  it("does not mistake one criterion, one story or one requirement for another", () => {
    const text = "// AC-17-3-12 and AC-17-4-2 and AC-18-3-2 and EF-17 and prefixAC-17-3-2";
    expect(citedCriteria("17-3", [{ path: "a.test.ts", line: 1, text }]).size).toBe(1);
    expect([...citedCriteria("17-3", [{ path: "a.test.ts", line: 1, text }]).keys()]).toEqual([12]);
    // A criterion 1 is not the criterion 12.
    expect(citedCriteria("17-3", [{ path: "a.test.ts", line: 1, text: "AC-17-3-1x" }]).size).toBe(
      1,
    );
    expect(citedCriteria("17-3", [{ path: "a.test.ts", line: 1, text: "AC-17-3-12" }]).has(1)).toBe(
      false,
    );
    expect(criteriaInLine("AC_17_3_2 AC-17-3-2")).toEqual([{ story: "17-3", criterion: 2 }]);
    expect(criteriaInLine("AC-0-3-2 AC-17-3-0")).toEqual([]);
  });

  it("counts only test files, and never documents", () => {
    const lines = [
      { path: "src/cart.ts", line: 3, text: "// AC-17-3-2" },
      { path: "docs/specs/cart.md", line: 3, text: "AC-17-3-2" },
      { path: "tests/fixtures/cart.json", line: 3, text: '"AC-17-3-2"' },
    ];
    expect(citedCriteria("17-3", lines).size).toBe(0);
  });

  it("keeps at most three places per criterion", () => {
    const lines = Array.from({ length: 6 }, (_, index) => ({
      path: `tests/t${index}.test.ts`,
      line: 1,
      text: "// AC-17-3-1",
    }));
    expect(citedCriteria("17-3", lines).get(1)).toHaveLength(3);
  });

  it("writes the id the way the tests cite it", () => {
    expect(criterionId("17-3", 2)).toBe("AC-17-3-2");
  });
});
