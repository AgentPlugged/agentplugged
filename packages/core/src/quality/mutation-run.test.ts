import { describe, expect, it } from "vitest";
import { type FakeCopy, FakeLab, failed, passed, type Tests } from "../testing/mutation-lab.js";
import {
  type ChangedFile,
  insideProject,
  type MutationPlan,
  mutationCounts,
  namedCriteria,
  runMutationCheck,
  survivorLines,
} from "./mutation-run.js";

/**
 * The mutation check, with a lab of memory: a break the tests catch is
 * killed, one they do not is a survivor; the number and the duration are bounded; the creator's
 * files are never written, and the copy is removed in every case, a failure included.
 */

const SOURCE = [
  "export function entry(age: number, tries: number): string {",
  "  if (age >= 18) {",
  "    return tries == 3 ? 'locked' : 'open';",
  "  }",
  "  return 'closed';",
  "}",
].join("\n");

const COMMAND = {
  line: "npx vitest run -t AC-1-3-",
  argv: ["npx", "vitest", "run", "-t", "AC-1-3-"],
};

function world(tests: Tests, options: { spent?: number } = {}) {
  let now = 1_000_000;
  const clock = {
    advance(ms: number) {
      now += ms;
    },
  };
  const creator = new Map([
    ["src/entry.ts", SOURCE],
    ["src/entry.test.ts", "it('AC-1-3-1 opens', () => {})"],
  ]);
  const lab = new FakeLab(creator, tests, clock, options.spent ?? 1000);
  const plan = (overrides: Partial<MutationPlan> = {}): MutationPlan => ({
    story: "1-3",
    ...COMMAND,
    cwd: ".",
    commandTimeoutMs: 120_000,
    files: [{ path: "src/entry.ts", added: new Set([2, 3, 5]) }],
    max: 20,
    seconds: 300,
    now: () => now,
    ...overrides,
  });
  return { lab, creator, plan, clock, snapshot: () => new Map(creator) };
}

/** Tests that pin `age >= 18` and the `locked` branch, and nothing else. */
const pinning: Tests = (files) => {
  const text = files.get("src/entry.ts") ?? "";
  return text.includes("age >= 18") && text.includes("'closed'") && text.includes("tries == 3")
    ? passed()
    : failed("AssertionError: AC-1-3-1 opens");
};

describe("a break the tests catch is killed, one they do not is reported", () => {
  it("runs the tests once before any break, then once per break, and puts the file back each time", async () => {
    const { lab, plan } = world(pinning);
    const report = await runMutationCheck(lab, plan());
    expect(report.status).toBe("done");
    const copy = lab.opened[0] as FakeCopy;
    expect(copy.requests).toHaveLength(1 + report.results.length);
    // After every break the original text is back.
    expect(copy.files.get("src/entry.ts")).toBe(SOURCE);
    const writes = copy.writes.map((write) => write.text === SOURCE);
    expect(writes.filter(Boolean)).toHaveLength(report.results.length);
    expect(report.proposed).toBeGreaterThanOrEqual(report.results.length);
  });

  it("marks `>=` killed and a constant no test pins as surviving, with file, line and break", async () => {
    // The tests pin the comparison, the `==` and the branches, but not the number 18.
    const tests: Tests = (files) => {
      const text = files.get("src/entry.ts") ?? "";
      return text.includes("age >= ") &&
        !text.includes("!(") &&
        text.includes("tries == 3") &&
        text.includes("'closed'")
        ? passed()
        : failed("AssertionError: AC-1-3-1 opens");
    };
    const { lab, plan } = world(tests);
    const report = await runMutationCheck(lab, plan());
    const byBreak = new Map(
      report.results.map((result) => [
        `${result.mutation.kind}:${result.mutation.from}`,
        result.outcome,
      ]),
    );
    expect(byBreak.get("comparison:>=")).toBe("killed");
    expect(byBreak.get("comparison:==")).toBe("killed");
    expect(byBreak.get("number:18")).toBe("survived");
    expect(mutationCounts(report)).toMatchObject({ survived: 1 });
    expect(survivorLines(report)).toEqual(["src/entry.ts:2 number `18` -> `19`"]);
  });

  it("kills everything when the tests pin the whole function", async () => {
    const strict: Tests = (files) => (files.get("src/entry.ts") === SOURCE ? passed() : failed());
    const { lab, plan } = world(strict);
    const report = await runMutationCheck(lab, plan());
    const counts = mutationCounts(report);
    expect(counts.survived).toBe(0);
    expect(counts.killed).toBe(counts.ran);
    expect(counts.ran).toBeGreaterThan(3);
  });

  it("reports every break as surviving when the tests pass whatever the code does", async () => {
    const { lab, plan } = world(() => passed());
    const report = await runMutationCheck(lab, plan());
    const counts = mutationCounts(report);
    expect(counts.killed).toBe(0);
    expect(counts.survived).toBe(counts.ran);
    expect(survivorLines(report)).toHaveLength(counts.ran);
  });

  it("counts a break that never ends as killed", async () => {
    let calls = 0;
    const { lab, plan } = world(() => {
      calls += 1;
      return calls === 1 ? passed() : { ...passed(), ended: "timeout", exit: null };
    });
    const report = await runMutationCheck(lab, plan({ max: 2 }));
    expect(report.results.map((result) => result.outcome)).toEqual(["timeout", "timeout"]);
    expect(mutationCounts(report)).toMatchObject({ killed: 2, survived: 0 });
  });

  it("names the criteria of the story that the failing output names", () => {
    expect(
      namedCriteria("1-3", "FAIL AC-1-3-2 pays\nAC_1_3_1 opens\nAC-9-9-1 other story"),
    ).toEqual([1, 2]);
    expect(namedCriteria("1-3", "nothing here")).toEqual([]);
  });

  it("keeps which criteria a failing run named", async () => {
    const { lab, plan } = world((files) =>
      files.get("src/entry.ts") === SOURCE
        ? passed()
        : failed("FAIL AC-1-3-2 charges the right amount"),
    );
    const report = await runMutationCheck(lab, plan({ max: 3 }));
    expect(report.results.every((result) => result.named.join() === "2")).toBe(true);
  });
});

describe("the tests must pass before any break", () => {
  it("stops when they are red, and breaks nothing", async () => {
    const { lab, plan } = world(() => failed("1 failed"));
    const report = await runMutationCheck(lab, plan());
    expect(report).toMatchObject({ status: "baseline_red", results: [] });
    expect(report.reason).toContain("fail before any break");
    const copy = lab.opened[0] as FakeCopy;
    expect(copy.writes).toEqual([]);
    expect(copy.closed).toBe(true);
  });

  it("says when the command never started", async () => {
    const { lab, plan } = world(() => ({
      ...passed(),
      ended: "error",
      exit: null,
      detail: "spawn npx ENOENT",
    }));
    const report = await runMutationCheck(lab, plan());
    expect(report.status).toBe("baseline_red");
    expect(report.reason).toContain("cannot_start");
  });
});

describe("number and duration are bounded", () => {
  it("runs at most the number asked, spread over the files", async () => {
    const creator = new Map([
      ["src/a.ts", "export const a = (x: number) => (x > 1 ? 2 : 3);\nexport const b = true;\n"],
      ["src/b.ts", "export const c = (y: number) => (y < 4 ? 5 : 6);\nexport const d = false;\n"],
    ]);
    const { lab, plan } = world(() => passed());
    for (const [path, text] of creator) lab.creator.set(path, text);
    const files: ChangedFile[] = [
      { path: "src/a.ts", added: new Set([1, 2]) },
      { path: "src/b.ts", added: new Set([1, 2]) },
    ];
    const report = await runMutationCheck(lab, plan({ files, max: 3 }));
    expect(report.results).toHaveLength(3);
    expect(report.proposed).toBeGreaterThan(3);
    expect(new Set(report.results.map((result) => result.mutation.path))).toEqual(
      new Set(["src/a.ts", "src/b.ts"]),
    );
  });

  it("stops when the time is up, saying how many were left", async () => {
    // Each run takes 40 s of a 100 s budget: the baseline and one break fit, the rest does not.
    const { lab, plan } = world(() => passed(), { spent: 40_000 });
    const report = await runMutationCheck(lab, plan({ seconds: 100, max: 6 }));
    expect(report.status).toBe("stopped");
    expect(report.reason).toBe("time");
    const outcomes = report.results.map((result) => result.outcome);
    expect(outcomes.filter((outcome) => outcome === "not_run").length).toBeGreaterThan(0);
    expect(mutationCounts(report).ran).toBeLessThan(6);
    expect((lab.opened[0] as FakeCopy).closed).toBe(true);
  });

  it("gives every break at least ten seconds and at most the command's own limit", async () => {
    const { lab, plan } = world(() => passed());
    await runMutationCheck(lab, plan({ commandTimeoutMs: 600_000, seconds: 1000, max: 2 }));
    const [baseline, first] = (lab.opened[0] as FakeCopy).requests;
    expect(baseline?.timeoutMs).toBe(600_000);
    // 4 times the 1.2 s of the baseline is short of ten seconds.
    expect(first?.timeoutMs).toBe(10_000);
    const small = world(() => passed());
    await runMutationCheck(small.lab, small.plan({ commandTimeoutMs: 5_000, max: 1 }));
    expect((small.lab.opened[0] as FakeCopy).requests[1]?.timeoutMs).toBe(5_000);
  });

  it("cuts a break that runs into the end of the budget and runs no more", async () => {
    let calls = 0;
    const { lab, plan } = world(
      () => {
        calls += 1;
        return calls < 3 ? passed() : { ...passed(), ended: "timeout", exit: null };
      },
      { spent: 4_000 },
    );
    const report = await runMutationCheck(lab, plan({ seconds: 12, max: 8 }));
    expect(report.status).toBe("stopped");
    expect(report.results.at(-1)?.outcome).toBe("not_run");
    expect(report.results.every((result) => result.outcome !== "timeout")).toBe(true);
  });
});

describe("the creator's copy is never touched", () => {
  it("writes only to the throwaway copy: the creator's files are the same afterwards", async () => {
    const { lab, plan, snapshot } = world(pinning);
    const before = snapshot();
    const report = await runMutationCheck(lab, plan());
    expect(report.results.length).toBeGreaterThan(0);
    expect(lab.creator).toEqual(before);
    expect(lab.opened).toHaveLength(1);
    expect((lab.opened[0] as FakeCopy).writes.length).toBeGreaterThan(0);
  });

  it("leaves the creator's files as they were when the tests blow up", async () => {
    const { lab, plan, snapshot } = world(() => {
      throw new Error("the runner crashed");
    });
    const before = snapshot();
    const report = await runMutationCheck(lab, plan());
    expect(report.status).toBe("baseline_red");
    expect(lab.creator).toEqual(before);
    expect((lab.opened[0] as FakeCopy).closed).toBe(true);
  });

  it("refuses a path that leaves the project: it is never read nor written", async () => {
    const { lab, plan } = world(pinning);
    lab.creator.set("../outside.ts", "if (a == b) { return true; }");
    const files: ChangedFile[] = [
      { path: "../outside.ts", added: new Set([1]) },
      { path: "/etc/passwd.ts", added: new Set([1]) },
      { path: "C:\\x\\y.ts", added: new Set([1]) },
      { path: "src/../../z.ts", added: new Set([1]) },
    ];
    const report = await runMutationCheck(lab, plan({ files }));
    expect(report.status).toBe("nothing_to_mutate");
    expect(lab.openings).toBe(0);
    expect(["src/a.ts", "a/b", "a"].map(insideProject)).toEqual([true, true, true]);
    expect(["", "../a", "/a", "a/../b", "a\\b", "a//b", "C:/a"].map(insideProject)).toEqual(
      Array(7).fill(false),
    );
  });

  it("does not even make a copy when the change holds no code (a test, a document)", async () => {
    const { lab, plan } = world(pinning);
    const files: ChangedFile[] = [
      { path: "src/entry.test.ts", added: new Set([1]) },
      { path: "README.md", added: new Set([1]) },
      { path: "src/entry.ts", added: new Set() },
    ];
    const report = await runMutationCheck(lab, plan({ files }));
    expect(report).toMatchObject({ status: "nothing_to_mutate", proposed: 0, results: [] });
    expect(lab.openings).toBe(0);
  });
});

describe("the copy is removed in every case", () => {
  it("after a normal run", async () => {
    const { lab, plan } = world(pinning);
    await runMutationCheck(lab, plan());
    expect((lab.opened[0] as FakeCopy).closed).toBe(true);
  });

  it("when the tests throw in the middle of the check", async () => {
    let calls = 0;
    const { lab, plan } = world(() => {
      calls += 1;
      if (calls === 3) throw new Error("the process vanished");
      return passed();
    });
    const report = await runMutationCheck(lab, plan());
    const copy = lab.opened[0] as FakeCopy;
    expect(copy.closed).toBe(true);
    expect(copy.files.get("src/entry.ts")).toBe(SOURCE);
    expect(report.results.some((result) => result.outcome === "error")).toBe(true);
  });

  it("when writing a break fails: the check ends as a report, the copy goes", async () => {
    const { lab, plan } = world(pinning);
    lab.failWrites = (_path, _text, count) => count === 1;
    const report = await runMutationCheck(lab, plan());
    expect(report.status).toBe("refused");
    expect(report.reason).toContain("disk full");
    expect((lab.opened[0] as FakeCopy).closed).toBe(true);
  });

  it("when a file cannot be put back: nothing more is broken", async () => {
    const { lab, plan } = world(pinning);
    // The first write is a break, the second would put the file back and fails.
    lab.failWrites = (_path, _text, count) => count === 2;
    const report = await runMutationCheck(lab, plan());
    expect(report.status).toBe("stopped");
    expect(report.reason).toBe("restore_failed");
    expect((lab.opened[0] as FakeCopy).writes).toHaveLength(2);
    expect((lab.opened[0] as FakeCopy).closed).toBe(true);
    expect(report.results.slice(1).every((result) => result.outcome === "not_run")).toBe(true);
  });

  it("says where the copy was left when it could not be removed", async () => {
    const { lab, plan } = world(pinning);
    lab.leftover = "/tmp/agentplugged-mutation-x";
    const report = await runMutationCheck(lab, plan({ max: 1 }));
    expect(report.leftover).toBe("/tmp/agentplugged-mutation-x");
  });

  it("turns a copy that could not be made into a reason", async () => {
    const { lab, plan } = world(pinning);
    lab.refuse = "copy_too_big";
    expect(await runMutationCheck(lab, plan())).toMatchObject({
      status: "refused",
      reason: "copy_too_big",
    });
    lab.refuse = undefined;
    lab.throws = true;
    expect(await runMutationCheck(lab, plan())).toMatchObject({
      status: "refused",
      reason: "no room left",
    });
  });
});
