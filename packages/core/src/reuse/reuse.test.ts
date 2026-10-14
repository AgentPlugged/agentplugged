import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import { mergeLensReports } from "../review/review-lenses.js";
import type { DiffFile } from "../review/review-rules.js";
import { isCodePath, isReadableCode } from "./code-files.js";
import {
  DEFAULT_MIN_TOKENS,
  detectDuplicates,
  fingerprints,
  type SourceFile,
} from "./duplicates.js";
import {
  analyzeReuse,
  codeLines,
  duplicateFindings,
  isReuseReport,
  MAX_ENGINE_FINDINGS,
  reuseLines,
  SHOWN_DUPLICATES,
  SHOWN_TWINS,
} from "./reuse.js";
import { WordTable, wordsOf } from "./tokens.js";
import { findTwins, functionsOf, nameLikeness, nameWords } from "./twins.js";
import {
  DRIFT_DUPLICATES,
  DRIFT_NET_LINES,
  storyWeight,
  type WeighedStory,
  weighedStoriesOf,
  weightDrift,
} from "./weight.js";

/** Every line of a file counts as added. */
function allAdded(files: readonly SourceFile[], ...paths: string[]) {
  const added = new Map<string, Set<number>>();
  for (const path of paths) {
    const file = files.find((candidate) => candidate.path === path) as SourceFile;
    added.set(path, new Set(Array.from({ length: file.text.split("\n").length }, (_, i) => i + 1)));
  }
  return added;
}

const TS = `export function summarizeOrders(orders: Order[], currency: string): Summary {
  const totals = new Map<string, number>();
  for (const order of orders) {
    if (order.status === "cancelled") continue;
    const key = order.customer.id;
    const previous = totals.get(key) ?? 0;
    totals.set(key, previous + order.amount * order.rate);
  }
  const entries = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  return { currency, top: entries.slice(0, 5), count: entries.length };
}
`;

const TS_RENAMED = `export function tallyInvoices(invoices: Invoice[], unit: string): Report {
  const sums = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.status === "void") continue;
    const owner = invoice.client.id;
    const before = sums.get(owner) ?? 10;
    sums.set(owner, before + invoice.total * invoice.factor);
  }
  const pairs = [...sums.entries()].sort((x, y) => y[1] - x[1]);
  return { unit, top: pairs.slice(0, 3), count: pairs.length };
}
`;

const PYTHON = `def collect_invoices(rows, currency):
    totals = {}
    for row in rows:
        if row["status"] == "cancelled":
            continue
        key = row["customer"]["id"]
        previous = totals.get(key, 0)
        totals[key] = previous + row["amount"] * row["rate"]
    entries = sorted(totals.items(), key=lambda item: item[1], reverse=True)
    return {"currency": currency, "top": entries[:5], "count": len(entries)}
`;

const PYTHON_RENAMED = `def tally_orders(lines, unit):
    sums = {}
    for line in lines:
        if line["state"] == "void":
            continue
        owner = line["client"]["ref"]
        before = sums.get(owner, 1)
        sums[owner] = before + line["total"] * line["factor"]
    pairs = sorted(sums.items(), key=lambda pair: pair[1], reverse=True)
    return {"unit": unit, "top": pairs[:3], "count": len(pairs)}
`;

const GO = `func SummarizeOrders(orders []Order, currency string) Summary {
	totals := make(map[string]float64)
	for _, order := range orders {
		if order.Status == "cancelled" {
			continue
		}
		key := order.Customer.ID
		previous := totals[key]
		totals[key] = previous + order.Amount*order.Rate
	}
	entries := make([]Entry, 0, len(totals))
	for key, value := range totals {
		entries = append(entries, Entry{Key: key, Value: value})
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Value > entries[j].Value })
	return Summary{Currency: currency, Top: entries[:5], Count: len(entries)}
}
`;

const GO_RENAMED = GO.replaceAll("Order", "Invoice")
  .replaceAll("orders", "invoices")
  .replaceAll("order", "invoice")
  .replaceAll("totals", "sums")
  .replaceAll("entries", "pairs")
  .replaceAll("Summary", "Report")
  .replaceAll("cancelled", "void");

const JAVA = `public class Totals {
    public Summary summarize(List<Order> orders, String currency) {
        Map<String, Double> totals = new HashMap<>();
        for (Order order : orders) {
            if (order.getStatus().equals("cancelled")) {
                continue;
            }
            String key = order.getCustomer().getId();
            double previous = totals.getOrDefault(key, 0.0);
            totals.put(key, previous + order.getAmount() * order.getRate());
        }
        List<Map.Entry<String, Double>> entries = new ArrayList<>(totals.entrySet());
        entries.sort((a, b) -> Double.compare(b.getValue(), a.getValue()));
        return new Summary(currency, entries.subList(0, 5), entries.size());
    }
}
`;

const JAVA_RENAMED = JAVA.replaceAll("Totals", "Sums")
  .replaceAll("Order", "Invoice")
  .replaceAll("orders", "invoices")
  .replaceAll("order", "invoice")
  .replaceAll("totals", "sums")
  .replaceAll("entries", "pairs")
  .replaceAll("Summary", "Report");

const FILLER = (name: string) => `export const ${name} = {
  label: "${name}",
  enabled: true,
};
`;

const LANGUAGES: readonly [string, string, string, string, string][] = [
  ["TypeScript", "src/orders.ts", "src/invoices.ts", TS, TS_RENAMED],
  ["Python", "app/orders.py", "app/invoices.py", PYTHON, PYTHON_RENAMED],
  ["Go", "orders/orders.go", "orders/invoices.go", GO, GO_RENAMED],
  ["Java", "src/Totals.java", "src/Sums.java", JAVA, JAVA_RENAMED],
];

describe("the detector finds a copy in any language", () => {
  for (const [language, existing, fresh, code, renamed] of LANGUAGES) {
    describe(language, () => {
      it("finds an exact copy and reports both places", () => {
        const files = [
          { path: existing, text: code },
          { path: fresh, text: `\n\n${code}` },
        ];
        const found = detectDuplicates(files, allAdded(files, fresh));
        expect(found.duplicates).toHaveLength(1);
        const [duplicate] = found.duplicates;
        expect(duplicate?.here.path).toBe(fresh);
        expect(duplicate?.there.path).toBe(existing);
        expect(duplicate?.tokens).toBeGreaterThanOrEqual(DEFAULT_MIN_TOKENS);
        expect(duplicate?.there.from).toBeLessThanOrEqual(2);
        expect(duplicate?.here.from).toBeGreaterThanOrEqual(3);
      });

      it("finds a copy whose names and values were changed", () => {
        const files = [
          { path: existing, text: code },
          { path: fresh, text: renamed },
        ];
        const found = detectDuplicates(files, allAdded(files, fresh));
        expect(found.duplicates).toHaveLength(1);
        expect(found.duplicates[0]?.here.path).toBe(fresh);
      });

      it("finds a copy with lines added in the middle and around", () => {
        const lines = code.split("\n");
        const middle = Math.floor(lines.length / 2);
        const changed = [
          "// a comment that is not code",
          ...lines.slice(0, middle),
          ...lines.slice(0, 0),
          ...lines.slice(middle),
        ].join("\n");
        const files = [
          { path: existing, text: code },
          { path: fresh, text: changed },
        ];
        const found = detectDuplicates(files, allAdded(files, fresh));
        expect(found.duplicates.length).toBeGreaterThanOrEqual(1);
        expect(found.duplicates[0]?.tokens).toBeGreaterThanOrEqual(DEFAULT_MIN_TOKENS);
      });

      it("finds nothing in a file that is only similar", () => {
        const other = `${FILLER("alpha")}${FILLER("beta")}`;
        const files = [
          { path: existing, text: code },
          { path: fresh, text: other },
        ];
        expect(detectDuplicates(files, allAdded(files, fresh)).duplicates).toEqual([]);
      });
    });
  }

  it("finds a copy of a block inside one file, in two places that do not overlap", () => {
    const text = `${TS}\nexport const between = 1;\n\n${TS_RENAMED}`;
    const files = [{ path: "src/one.ts", text }];
    const found = detectDuplicates(files, allAdded(files, "src/one.ts"));
    expect(found.duplicates).toHaveLength(1);
    expect(found.duplicates[0]?.here.path).toBe("src/one.ts");
    expect(found.duplicates[0]?.there.path).toBe("src/one.ts");
    expect(found.duplicates[0]?.there.from).not.toBe(found.duplicates[0]?.here.from);
  });

  it("does not report a copy that is only in the code the change did not add", () => {
    const files = [
      { path: "src/a.ts", text: TS },
      { path: "src/b.ts", text: TS },
      { path: "src/c.ts", text: FILLER("fresh") },
    ];
    const found = detectDuplicates(files, allAdded(files, "src/c.ts"));
    expect(found.duplicates).toEqual([]);
  });

  it("counts the other places of a block once, not one duplicate each", () => {
    const files = [
      { path: "src/a.ts", text: TS },
      { path: "src/b.ts", text: TS },
      { path: "src/c.ts", text: TS },
      { path: "src/d.ts", text: TS_RENAMED },
    ];
    const found = detectDuplicates(files, allAdded(files, "src/d.ts"));
    expect(found.duplicates).toHaveLength(1);
    expect(found.duplicates[0]?.others).toBe(2);
  });

  it("tells the same duplicates in the same order every time", () => {
    const files = LANGUAGES.flatMap(([, existing, fresh, code, renamed]) => [
      { path: existing, text: code },
      { path: fresh, text: renamed },
    ]);
    const added = allAdded(files, ...LANGUAGES.map(([, , fresh]) => fresh));
    const first = detectDuplicates(files, added);
    expect(first.duplicates).toHaveLength(4);
    expect(detectDuplicates([...files].reverse(), added).duplicates.map((d) => d.tokens)).toEqual(
      first.duplicates.map((d) => d.tokens),
    );
    expect(detectDuplicates(files, added)).toEqual(first);
  });

  it("lets the threshold be set: a short block is a duplicate only below its length", () => {
    const short = `function pick(a, b, c) {
  if (a > b && c !== null) {
    return c ? a - b : b * 2;
  }
  return [a, b];
}
`;
    const files = [
      { path: "x/a.js", text: short },
      { path: "x/b.js", text: short.replace("pick", "choose") },
    ];
    const added = allAdded(files, "x/b.js");
    expect(detectDuplicates(files, added).duplicates).toEqual([]);
    expect(detectDuplicates(files, added, { minTokens: 20 }).duplicates).toHaveLength(1);
  });
});

describe("the detector does not cry wolf", () => {
  it("never takes imports, headers and short declarations for a copy", () => {
    const imports = `import { a } from "./a.js";
import { b } from "./b.js";
import type { C, D, E } from "../c.js";
import {
  alpha,
  beta,
  gamma,
  delta,
} from "../greek.js";
export { x, y, z } from "./letters.js";
export * from "./all.js";
`;
    const python = `from os import path
from typing import (
    Any,
    Dict,
    List,
)
import sys
import json
`;
    const go = `package main

import (
	"fmt"
	"os"
	"strings"
	"sort"
)
`;
    const files = [
      { path: "src/one.ts", text: `${imports}export const one = 1;\n` },
      { path: "src/two.ts", text: `${imports}export const two = 2;\n` },
      { path: "py/one.py", text: `${python}\nONE = 1\n` },
      { path: "py/two.py", text: `${python}\nTWO = 2\n` },
      { path: "go/one.go", text: go },
      { path: "go/two.go", text: go },
    ];
    const found = detectDuplicates(files, allAdded(files, "src/two.ts", "py/two.py", "go/two.go"), {
      minTokens: 12,
    });
    expect(found.duplicates).toEqual([]);
  });

  it("never takes a table of values, a row of brackets or a declaration for a copy", () => {
    const table = (n: number) =>
      `export const rows = [\n${Array.from({ length: 30 }, (_, i) => `  ["k${i + n}", ${i + n}],`).join("\n")}\n];\n`;
    const brackets = `${"}\n".repeat(40)}`;
    const declaration = "export function parse(input: string, strict: boolean): Result;\n";
    for (const [left, right] of [
      [table(1), table(100)],
      [brackets, brackets],
      [declaration, declaration],
    ] as const) {
      const files = [
        { path: "src/a.ts", text: left },
        { path: "src/b.ts", text: right },
      ];
      expect(detectDuplicates(files, allAdded(files, "src/b.ts")).duplicates).toEqual([]);
    }
  });

  it("does not take two different functions of the same shape for a copy", () => {
    const left = `function a(items) {
  const out = [];
  for (const item of items) {
    out.push(item.id);
  }
  return out;
}
`;
    const right = `function b(items) {
  let total = 0;
  while (items.length > 0) {
    total += items.pop().size;
  }
  return total;
}
`;
    const files = [
      { path: "x/left.js", text: left },
      { path: "x/right.js", text: right },
    ];
    expect(detectDuplicates(files, allAdded(files, "x/right.js")).duplicates).toEqual([]);
  });

  it("ignores comments and blanks, and keeps the lines of the words", () => {
    const table = new WordTable();
    const text = "// one\nconst a = 1; /* two\nthree */ const b = 2;\n";
    const words = wordsOf("x.ts", text, table);
    expect(Array.from(words.lines)).toEqual([2, 2, 2, 2, 2, 3, 3, 3, 3, 3]);
    const python = wordsOf("x.py", "# note\nx = 1  # trailing\n", new WordTable());
    expect(python.ids).toHaveLength(3);
  });

  it("reads the files worth comparing only", () => {
    expect(isCodePath("src/app.ts")).toBe(true);
    expect(isCodePath("pkg/server.go")).toBe(true);
    expect(isCodePath("src/app.test.ts")).toBe(false);
    expect(isCodePath("tests/helpers.py")).toBe(false);
    expect(isCodePath("pkg/server_test.go")).toBe(false);
    expect(isCodePath("dist/app.js")).toBe(false);
    expect(isCodePath("node_modules/x/index.js")).toBe(false);
    expect(isCodePath("proto/api.pb.go")).toBe(false);
    expect(isCodePath("src/app.min.js")).toBe(false);
    expect(isCodePath("README.md")).toBe(false);
    expect(isCodePath("pnpm-lock.yaml")).toBe(false);
    expect(isCodePath("assets/logo.png")).toBe(false);
    // Tools and settings in a hidden folder, helpers that only tests use.
    expect(isCodePath(".claude/skills/x/scripts/run.py")).toBe(false);
    expect(isCodePath(".github/scripts/release.js")).toBe(false);
    expect(isCodePath("src/__helpers__/legacy-calls.ts")).toBe(false);
    expect(isCodePath("src/pair/pair.test-support.ts")).toBe(false);
    expect(isCodePath("tooling/api-testkit/memory-store.ts")).toBe(false);
    expect(isCodePath("src/contest-kit/app.ts")).toBe(true);
    expect(isCodePath("src/contestkit/app.ts")).toBe(true);
    expect(isCodePath("./src/app.ts")).toBe(true);
    expect(isCodePath("../shared/app.ts")).toBe(true);
    expect(isReadableCode("const a = 1;\n")).toBe(true);
    expect(isReadableCode("a\u0000b")).toBe(false);
    expect(isReadableCode(`${"x".repeat(5000)};`)).toBe(false);
    expect(isReadableCode("")).toBe(false);
  });

  it("keeps a fingerprint in every window of a run (the winnowing guarantee)", () => {
    const ids = Uint32Array.from({ length: 400 }, (_, i) => ((i * 7919) % 97) + 1);
    const gram = 10;
    const window = 41;
    const { positions } = fingerprints(ids, gram, window);
    const sorted = Array.from(positions).sort((a, b) => a - b);
    // Between two kept positions there are never `window` runs.
    for (let i = 1; i < sorted.length; i += 1) {
      expect((sorted[i] as number) - (sorted[i - 1] as number)).toBeLessThanOrEqual(window);
    }
    expect(sorted.length).toBeLessThan(ids.length / 4);
  });
});

describe("the detector is fast and bounded", () => {
  /** A repository of `count` files of code that all differ (a seeded generator). */
  function repository(count: number): SourceFile[] {
    let seed = 42;
    const next = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed;
    };
    const verbs = ["load", "save", "parse", "merge", "split", "scan", "build", "walk"];
    return Array.from({ length: count }, (_, f) => {
      const body = Array.from({ length: 24 }, (_, line) => {
        const a = next() % 1000;
        const b = next() % 1000;
        const verb = verbs[next() % verbs.length];
        const shape = next() % 6;
        return shape === 0
          ? `  const v${line}x${f} = ${verb}${a}(input.${verb}, ${b}) + state.n${line};`
          : shape === 1
            ? `  if (state.f${a}${line} > ${b}) { out.push(${verb}(${a})); }`
            : shape === 2
              ? `  for (let i${line} = ${a}; i${line} < ${b}; i${line} += ${line + 1}) { acc${f} ^= i${line}; }`
              : shape === 3
                ? `  state.${verb}${line}[${a}] = (state.${verb}${line}[${b}] ?? ${a}) * ${verb}${f}();`
                : shape === 4
                  ? `  try { await ${verb}${a}.${verb}(${b}); } catch (e${line}) { log(e${line}, ${a}); }`
                  : `  return ${verb}${f}(${a}) && state.k${line} || ${b};`;
      });
      return {
        path: `src/m${f % 20}/file${f}.ts`,
        text: `export async function work${f}(input: Input, state: State) {\n${body.join("\n")}\n}\n`,
      };
    });
  }

  it("reads a repository of 600 files and finds the one copy in a few seconds", () => {
    const files = repository(600);
    const copy = { path: "src/new/copy.ts", text: (files[123] as SourceFile).text };
    const all = [...files, copy];
    const started = Date.now();
    const found = detectDuplicates(all, allAdded(all, copy.path));
    const elapsed = Date.now() - started;
    expect(found.partial).toBe(false);
    expect(found.files).toBe(601);
    expect(found.duplicates).toHaveLength(1);
    expect(found.duplicates[0]?.there.path).toBe((files[123] as SourceFile).path);
    expect(elapsed).toBeLessThan(10_000);
  });

  it("stops at its time limit and says it is partial", () => {
    const files = repository(50);
    let now = 0;
    // The clock moves by a second at every reading: the limit is passed after a few files.
    const clock = () => {
      now += 1_000;
      return now;
    };
    const found = detectDuplicates(files, allAdded(files, files[0]?.path as string), {
      maxMs: 3_000,
      clock,
    });
    expect(found.partial).toBe(true);
    expect(found.files).toBeLessThan(50);
  });
});

function diffFile(path: string, added: readonly number[]): DiffFile {
  return {
    path,
    old_path: null,
    added: added.length,
    removed: 0,
    lines: new Map(added.map((line) => [line, null] as const)),
  };
}

describe("the report the review gets", () => {
  const lines = (text: string) => Array.from({ length: text.split("\n").length }, (_, i) => i + 1);

  it("finds the duplicates and the twins of what the diff added", () => {
    const tree = [
      { path: "src/orders.ts", text: TS },
      {
        path: "src/invoices.ts",
        text: TS_RENAMED.replace(
          "tallyInvoices(invoices: Invoice[], unit: string)",
          "summarizeOrdersNow(orders: Invoice[], currency: string)",
        ),
      },
    ];
    const report = analyzeReuse([diffFile("src/invoices.ts", lines(TS_RENAMED))], tree);
    expect(report.duplicates).toHaveLength(1);
    expect(report.twins.map((twin) => twin.twin.name)).toEqual(["summarizeOrders"]);
    expect(report.partial).toBe(false);
  });

  it("reads only the added lines, tests and documents never", () => {
    const tree = [
      { path: "src/orders.ts", text: TS },
      { path: "src/orders.test.ts", text: TS },
      { path: "docs/notes.md", text: TS },
    ];
    const none = analyzeReuse(
      [diffFile("src/orders.test.ts", lines(TS)), diffFile("docs/notes.md", lines(TS))],
      tree,
    );
    expect(none.duplicates).toEqual([]);
    expect(codeLines([diffFile("src/a.ts", [1, 2]), diffFile("src/a.test.ts", [1])])).toEqual({
      added: 2,
      removed: 0,
    });
  });

  it("gives the reader few lines, bounded, and the structure finding to the review", () => {
    const place = (n: number) => ({
      path: `src/some/long/folder/name/file${n}.ts`,
      from: n,
      to: n + 9,
    });
    const many = {
      duplicates: Array.from({ length: 40 }, (_, n) => ({
        here: place(n),
        there: place(n + 100),
        tokens: 80,
        others: 2,
      })),
      twins: Array.from({ length: 10 }, (_, n) => ({
        name: `formatThing${n}`,
        path: `src/a/b/c/d/e/f/file${n}.ts`,
        line: n + 1,
        twin: { name: `formatThings${n}`, path: `src/g/h/i/j/k/file${n}.ts`, line: 3 },
        why: "close_name" as const,
      })),
      partial: true,
      files: 10,
      ms: 5,
    };
    const rendered = reuseLines(many);
    expect(rendered.length).toBeLessThanOrEqual(SHOWN_DUPLICATES + SHOWN_TWINS + 3);
    expect(rendered.join("\n").length).toBeLessThan(1_500);
    expect(rendered[0]).toMatch(/^duplicate src\/.*:0-9 = src\/.*:100-109 \(80 words \+2\)$/);
    expect(rendered.some((line) => line.startsWith("twin? formatThing0"))).toBe(true);
    expect(rendered.at(-1)).toBe("partial: time ran out, an empty list proves nothing");
    expect(reuseLines(undefined)).toEqual([]);
    expect(reuseLines({ ...many, duplicates: [], twins: [], partial: false })).toEqual([]);

    const findings = duplicateFindings(many);
    expect(findings).toHaveLength(MAX_ENGINE_FINDINGS);
    expect(findings[0]).toMatchObject({
      severity: "should_fix",
      lens: "structure",
      path: "src/some/long/folder/name/file0.ts",
      line: 0,
    });
    expect(findings[0]?.title).toMatch(/^Duplicated code: /);
    expect(duplicateFindings(undefined)).toEqual([]);
  });
});

describe("the probable twins", () => {
  it("reads the functions of several languages", () => {
    const names = (path: string, text: string) => functionsOf(path, text).map((fn) => fn.name);
    expect(names("a.ts", "export async function loadUser(id: string, opts = {}) {}")).toEqual([
      "loadUser",
    ]);
    expect(names("a.ts", "export const parseDate = (value: string, locale: string) => {")).toEqual([
      "parseDate",
    ]);
    expect(names("a.py", "    async def fetch_all(self, session, limit=10):")).toEqual([
      "fetch_all",
    ]);
    expect(
      names("a.go", "func (s *Store) ReadAll(ctx context.Context, id string) error {"),
    ).toEqual(["ReadAll"]);
    expect(names("a.rs", "pub async fn read_all<T>(path: &Path) -> T {")).toEqual(["read_all"]);
    expect(
      names("A.java", "    public static String joinNames(List<String> names, char sep) {"),
    ).toEqual(["joinNames"]);
    expect(names("a.kt", "    private fun joinNames(names: List<String>): String {")).toEqual([
      "joinNames",
    ]);
    expect(names("a.ts", "  if (ready) {\n  while (x) {\n  foo(bar);")).toEqual([]);
    expect(functionsOf("a.ts", "function f(a, b: number, ...rest) {}")[0]?.params).toEqual([
      "a",
      "b",
      "rest",
    ]);
  });

  it("sees the same name written another way, and a close name with close parameters", () => {
    expect(nameWords("getUserByID")).toEqual(["get", "user", "by", "id"]);
    expect(nameWords("get_user_by_id")).toEqual(["get", "user", "by", "id"]);
    expect(nameLikeness("getUserById", "get_user_by_id")).toBe(1);
    expect(nameLikeness("formatDate", "parseNumber")).toBeLessThan(0.5);
    const tree = [
      {
        path: "src/dates.ts",
        text: "export function formatDateRange(start: Date, end: Date): string {\n  return '';\n}\n",
      },
      {
        path: "src/new.ts",
        text: "export function format_date_range(start: Date, end: Date): string {\n  return '';\n}\nexport function formatDatesRange(start: Date, end: Date): string {\n  return '';\n}\n",
      },
    ];
    const twins = findTwins(tree, new Map([["src/new.ts", new Set([1, 4])]]));
    expect(twins.map((twin) => [twin.name, twin.twin.path, twin.why])).toEqual([
      ["format_date_range", "src/dates.ts", "same_name"],
      ["formatDatesRange", "src/dates.ts", "close_name"],
    ]);
  });

  it("takes two methods of one name in two files for an interface, not for a twin", () => {
    const port = `export class A {
  loadAccounts(id: string): number {
    return 1;
  }
}
`;
    const java = (name: string) => `class ${name} {
  public int loadAccounts(String id) {
  }
}
`;
    const tree = [
      { path: "src/a.ts", text: port },
      { path: "src/b.ts", text: port },
      { path: "src/c.ts", text: "export function loadAccounts(id: string) {}" + "\n" },
      { path: "src/D.java", text: java("D") },
      { path: "src/E.java", text: java("E") },
    ];
    expect(functionsOf("src/a.ts", port).map((fn) => fn.nested)).toEqual([true]);
    const methods = findTwins(tree.slice(0, 2), new Map([["src/b.ts", new Set([2])]]));
    expect(methods).toEqual([]);
    // One side that other files could import is still a hint.
    const mixed = findTwins(tree.slice(1, 3), new Map([["src/b.ts", new Set([2])]]));
    expect(mixed.map((twin) => twin.twin.path)).toEqual(["src/c.ts"]);
    // Methods of two Python classes in two files are two sides of one interface too.
    const py = `class A:
    def load_accounts(self, id):
        return 1
`;
    const pyTwins = findTwins(
      [
        { path: "src/a.py", text: py },
        { path: "src/b.py", text: py },
        {
          path: "src/c.py",
          text: `def load_accounts(id):
    return 1
`,
        },
      ],
      new Map([["src/b.py", new Set([2])]]),
    );
    expect(pyTwins.map((twin) => twin.twin.path)).toEqual(["src/c.py"]);
    // In a language where every function is in a class, indentation says nothing.
    const inJava = findTwins(tree.slice(3), new Map([["src/E.java", new Set([2])]]));
    expect(inJava.map((twin) => twin.twin.path)).toEqual(["src/D.java"]);
  });

  it("leaves out the generic and short names, other names and the function itself", () => {
    const tree = [
      {
        path: "src/a.ts",
        text: "export function run(a: number) {}\nexport function loadAccounts(id: string) {}\n",
      },
      {
        path: "src/b.ts",
        text: "export function run(a: number) {}\nexport function loadAccounts(id: string) {}\nexport function totallyOther(x: number) {}\n",
      },
    ];
    const twins = findTwins(tree, new Map([["src/b.ts", new Set([1, 2, 3])]]));
    expect(twins.map((twin) => twin.name)).toEqual(["loadAccounts"]);
    const alone = findTwins(
      [{ path: "src/a.ts", text: "export function loadAccounts(id: string) {}\n" }],
      new Map([["src/a.ts", new Set([1])]]),
    );
    expect(alone).toEqual([]);
  });
});

describe("the weight of the code drifts", () => {
  const story = (
    seq: number,
    added: number,
    removed: number,
    duplicates: number,
  ): WeighedStory => ({
    story: `1-${seq}`,
    seq,
    weight: { added, removed, duplicates },
  });

  it("says nothing before three stories, nor when the code stays light", () => {
    expect(weightDrift([story(1, 5_000, 0, 9), story(2, 5_000, 0, 9)])).toBeUndefined();
    expect(
      weightDrift([story(1, 300, 100, 1), story(2, 200, 150, 0), story(3, 400, 100, 2)]),
    ).toBeUndefined();
  });

  it("says in one line, proposing a cleanup story, when duplicates pile up", () => {
    const line = weightDrift([
      story(1, 100, 50, 2),
      story(2, 100, 50, 2),
      story(3, 100, 50, DRIFT_DUPLICATES - 4),
    ]);
    expect(line).toMatch(
      /^Code weight: the last 3 merged stories added 300 lines of code \(150 removed\) and 5 duplicate\(s\); a cleanup story is proposed/,
    );
    expect(line).not.toContain("\n");
    expect(
      weightDrift([story(1, 100, 50, 2), story(2, 100, 50, 2), story(3, 100, 50, 0)]),
    ).toBeUndefined();
  });

  it("says it when the code only grows, but not when it is also cleaned", () => {
    const grows = [story(1, 1_000, 10, 0), story(2, 1_000, 10, 0), story(3, 500, 0, 0)];
    expect(weightDrift(grows)).toContain("added 2500 lines of code (20 removed)");
    expect(
      weightDrift([story(1, 1_000, 400, 0), story(2, 1_000, 400, 0), story(3, 500, 300, 0)]),
    ).toBeUndefined();
    expect(DRIFT_NET_LINES).toBe(2_000);
  });

  it("looks at the last five stories only", () => {
    const old = [story(1, 9_000, 0, 20), story(2, 9_000, 0, 20)];
    const calm = [3, 4, 5, 6, 7].map((n) => story(n, 50, 40, 0));
    expect(weightDrift([...old, ...calm])).toBeUndefined();
  });
});

describe("the weight the journal keeps", () => {
  const diff = [
    "diff --git a/src/new.ts b/src/new.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.ts",
    `@@ -0,0 +1,${TS.split("\n").length - 1} @@`,
    ...TS.split("\n")
      .slice(0, -1)
      .map((line) => `+${line}`),
    "diff --git a/src/old.ts b/src/old.ts",
    "--- a/src/old.ts",
    "+++ b/src/old.ts",
    "@@ -1,2 +1 @@",
    "-const a = 1;",
    "-const b = 2;",
    "+const a = 3;",
    "diff --git a/src/old.test.ts b/src/old.test.ts",
    "--- a/src/old.test.ts",
    "+++ b/src/old.test.ts",
    "@@ -1 +1,2 @@",
    " x",
    "+y",
    "",
  ].join("\n");
  const context = (files: readonly SourceFile[] | undefined) =>
    ({ codeSource: { read: async () => files } }) as unknown as CommandContext;

  it("counts the lines of code added and removed, tests aside, and the duplicates added", async () => {
    const tree = [
      { path: "src/new.ts", text: TS },
      { path: "src/other.ts", text: TS_RENAMED },
    ];
    expect(await storyWeight(context(tree), diff, "a".repeat(40))).toEqual({
      added: 12,
      removed: 2,
      duplicates: 1,
    });
    // The repository cannot be read: the lines are counted, no duplicate is (unknown is not zero).
    expect(await storyWeight(context(undefined), diff, "a".repeat(40))).toEqual({
      added: 12,
      removed: 2,
    });
    expect(await storyWeight(context(tree), undefined, "a".repeat(40))).toBeUndefined();
  });

  it("reads the weights of the merged stories from the projection, in the order of the merges", () => {
    const merged = (seq: number, weight?: object) => ({
      merged: { seq, files: [], ...(weight ? { weight } : {}) },
    });
    const weighed = weighedStoriesOf({
      stories: {
        "1-2": merged(2, { added: 5, removed: 1, duplicates: 1 }),
        "1-1": merged(1, { added: 3, removed: 0 }),
        "1-3": merged(3),
        "1-4": { status: "in_progress" },
      },
    });
    expect(weighed.map((entry) => [entry.story, entry.weight])).toEqual([
      ["1-1", { added: 3, removed: 0, duplicates: 0 }],
      ["1-2", { added: 5, removed: 1, duplicates: 1 }],
    ]);
    expect(weighedStoriesOf({})).toEqual([]);
  });

  it("joins the engine's findings to the lenses' without a reviewer being able to drop them", () => {
    const engine = duplicateFindings({
      duplicates: [
        {
          here: { path: "src/b.ts", from: 3, to: 20 },
          there: { path: "src/a.ts", from: 1, to: 18 },
          tokens: 90,
          others: 0,
        },
      ],
      twins: [],
      partial: false,
      files: 2,
      ms: 1,
    });
    const reports = [{ lens: "structure" as const, summary: "ok", covered: ["x"], findings: [] }];
    const merged = mergeLensReports(reports, undefined, engine);
    expect(merged.findings).toHaveLength(1);
    expect(merged.findings[0]).toMatchObject({ severity: "should_fix", lens: "structure" });
    expect(mergeLensReports(reports).findings).toEqual([]);
  });
});

describe("what the review of the 17.21 story found, and the engine now holds", () => {
  it("reads the files the change touched first, so that a time limit never leaves them out", () => {
    const filler = Array.from({ length: 30 }, (_, i) => ({
      path: `a/file${i}.ts`,
      text: `export const v${i} = ${i};
`.repeat(40),
    }));
    const files = [...filler, { path: "z/new.ts", text: TS }, { path: "z/old.ts", text: TS }];
    let now = 0;
    const clock = () => {
      now += 1;
      return now;
    };
    const found = detectDuplicates(files, allAdded(files, "z/new.ts"), { maxMs: 40, clock });
    // The two files that matter are read before the 30 others the clock cuts off.
    expect(found.duplicates).toHaveLength(1);
  });

  it("stops inside a file of periodic code, which makes thousands of candidates", () => {
    const periodic = Array.from(
      { length: 6_000 },
      (_, i) => `  total += table[${i % 7}] * ${i % 5};`,
    ).join("\n");
    const text = `function build(table) {
  let total = 0;
${periodic}
  return total;
}
`;
    const files = [
      { path: "a/one.js", text },
      { path: "a/two.js", text },
    ];
    let now = 0;
    // 5 ms per reading: a few thousand readings pass the limit well before the file is done.
    const clock = () => {
      now += 5;
      return now;
    };
    const found = detectDuplicates(files, allAdded(files, "a/two.js"), { maxMs: 2_000, clock });
    expect(found.partial).toBe(true);
  });

  it("places a duplicate on the first line the change added, and tells a cut-short search", () => {
    const text = `// header
${TS}`;
    const files = [
      { path: "a/old.ts", text: TS },
      { path: "a/new.ts", text },
    ];
    const added = new Map([["a/new.ts", new Set(Array.from({ length: 11 }, (_, i) => i + 3))]]);
    const found = detectDuplicates(files, added);
    expect(found.duplicates[0]?.here.from).toBe(3);
    const partial = reuseLines({ duplicates: [], twins: [], partial: true, files: 3, ms: 9 });
    expect(partial).toEqual(["partial: time ran out, an empty list proves nothing"]);
  });

  it("reads back a cache as data: a malformed or forged shape is refused", () => {
    const place = { path: "a.ts", from: 1, to: 9 };
    const good = {
      duplicates: [{ here: place, there: place, tokens: 60, others: 0 }],
      twins: [],
      partial: false,
    };
    expect(isReuseReport(good)).toBe(true);
    for (const bad of [
      null,
      "x",
      { ...good, duplicates: [{}] },
      { ...good, duplicates: [{ ...good.duplicates[0], tokens: "60" }] },
      { ...good, twins: [{ name: 1 }] },
      { duplicates: [], twins: [] },
    ]) {
      expect(isReuseReport(bad)).toBe(false);
    }
  });

  it("keeps a weight without duplicates when the engine could not look, and a zero when it looked", async () => {
    const diff = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1 +1,2 @@",
      " a",
      "+b",
      "",
    ].join("\n");
    expect(await storyWeight({} as CommandContext, diff, "a".repeat(40))).toEqual({
      added: 1,
      removed: 0,
    });
    const looked = {
      codeSource: { read: async () => [{ path: "src/x.ts", text: "a\nb\n" }] },
    } as unknown as CommandContext;
    expect(await storyWeight(looked, diff, "a".repeat(40))).toEqual({
      added: 1,
      removed: 0,
      duplicates: 0,
    });
    const removal = [
      "diff --git a/src/x.ts b/src/x.ts",
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,2 +1 @@",
      " a",
      "-b",
      "",
    ].join("\n");
    expect(await storyWeight({} as CommandContext, removal, "a".repeat(40))).toEqual({
      added: 0,
      removed: 1,
      duplicates: 0,
    });
  });

  it("names a parameter, not its type, in any language", () => {
    const params = (path: string, line: string) => functionsOf(path, line)[0]?.params;
    expect(params("A.java", "    public String join(List<String> names, char sep) {")).toEqual([
      "names",
      "sep",
    ]);
    expect(params("a.go", "func Join(ctx context.Context, names []string) error {")).toEqual([
      "ctx",
      "names",
    ]);
    expect(params("a.rs", "pub fn join(mut names: Vec<String>, sep: char) -> String {")).toEqual([
      "names",
      "sep",
    ]);
    expect(params("a.ts", "export function join(names?: string[], sep = ',') {}")).toEqual([
      "names",
      "sep",
    ]);
  });

  it("takes OrderServiceTest.java for a test and Latest.java for code, and reads PHP and Lua comments", () => {
    expect(isCodePath("src/OrderServiceTest.java")).toBe(false);
    expect(isCodePath("src/Latest.java")).toBe(true);
    expect(isCodePath("src/Contest.cs")).toBe(true);
    expect(isCodePath("src/query.jl")).toBe(false);
    const table = new WordTable();
    expect(wordsOf("a.php", "# note\n// other\n$a = 1;\n", table).ids).toHaveLength(
      wordsOf("b.php", "$a = 1;\n", table).ids.length,
    );
    expect(wordsOf("a.lua", "--[[ one\ntwo ]] x = 1\n", table).ids).toHaveLength(
      wordsOf("b.lua", "x = 1\n", table).ids.length,
    );
    const length = `$${"{"}#x}`; // the shell's length of a variable: a `#` that is not a comment
    expect(wordsOf("a.sh", `echo ${length} # note\n`, table).ids).toHaveLength(
      wordsOf("b.sh", `echo ${length}\n`, table).ids.length,
    );
  });
});
