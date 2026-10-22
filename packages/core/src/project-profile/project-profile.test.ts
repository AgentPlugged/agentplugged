import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command.js";
import type { DocsBase } from "../docs/docs-base.js";
import { createCommandRegistry } from "../index.js";
import type { SourceFile } from "../reuse/duplicates.js";
import {
  analyzeReuse,
  type CodeSource,
  duplicateFindings,
  isReuseReport,
  reuseLines,
} from "../reuse/reuse.js";
import { parseDiff } from "../review/review-rules.js";
import { MemoryFiles, shippedMethod } from "../testing/memory-files.js";
import {
  bricksOf,
  buildBricks,
  findBricks,
  matchingSources,
  searchWords,
  sourceClashes,
} from "./bricks.js";
import { PROFILE_PATH, parseKept, renderProfile, withSource } from "./profile-file.js";
import { BRICKS_CACHE_PATH, profileBrief } from "./project-command.js";
import { scanProject } from "./scan.js";

/** A workspace that lists its root and `.github/workflows` like the real one. */
class RootFiles extends MemoryFiles {
  async listEntries(dir: string): Promise<string[]> {
    const prefix = dir === "" ? "" : `${dir}/`;
    const names = new Set<string>();
    for (const path of [...this.files.keys(), ...this.dirs]) {
      if (!path.startsWith(prefix) || path === dir) continue;
      names.add(path.slice(prefix.length).split("/")[0] as string);
    }
    return [...names].sort();
  }
}

const NODE_FILES = {
  "package.json": JSON.stringify({
    name: "shop",
    packageManager: "pnpm@9.1.0",
    engines: { node: ">=22" },
    scripts: { test: "vitest run", build: "tsc", lint: "biome check .", dev: "vite" },
    devDependencies: { vitest: "^1", react: "^18" },
  }),
  "pnpm-lock.yaml": "lock",
  "tsconfig.json": "{}",
  "biome.json": "{}",
  ".nvmrc": "22.1.0\n",
  "src/index.ts": "export {}",
  "tests/a.test.ts": "x",
  ".github/workflows/ci.yml": "on: push",
};

describe("the project scan", () => {
  it("reads a Node project: stack, commands with their source, conventions, advice with its reason", async () => {
    const scan = await scanProject(new RootFiles(NODE_FILES));
    expect(scan.stack[0]).toContain("TypeScript on Node.js >=22, pnpm");
    expect(scan.stack[1]).toContain("React");
    expect(scan.commands).toContainEqual({
      name: "test",
      command: "pnpm test",
      source: "package.json scripts.test",
    });
    expect(scan.commands.map((c) => c.name)).toEqual(["test", "build", "lint", "run"]);
    expect(scan.conventions).toContain("Runtime version pinned: 22.1.0 (.nvmrc).");
    expect(scan.conventions.some((c) => c.includes("GitHub Actions (ci.yml)"))).toBe(true);
    expect(scan.layout).toContain("Folders: src.");
    expect(scan.layout).toContain("Tests live in: tests.");
    expect(scan.advice.every((a) => a.why.length > 10)).toBe(true);
    expect(scan.advice.some((a) => a.advice.startsWith("Install with pnpm only"))).toBe(true);
  });

  it("is not tied to a language: Python with uv, a Makefile, Rust and Go roots", async () => {
    const python = await scanProject(
      new RootFiles({
        "pyproject.toml": "[tool.pytest.ini_options]\n[tool.ruff]\n",
        "uv.lock": "",
        Makefile: "test:\n\tuv run pytest\nbuild:\n\techo\n",
      }),
    );
    expect(python.commands).toContainEqual(
      expect.objectContaining({ name: "test", command: "uv run pytest" }),
    );
    expect(python.commands).toContainEqual(
      expect.objectContaining({ name: "build", command: "make build" }),
    );
    expect(python.advice[0]?.why).toContain("uv.lock");
    const rust = await scanProject(new RootFiles({ "Cargo.toml": "[package]" }));
    expect(rust.commands[0]?.command).toBe("cargo test");
    const go = await scanProject(new RootFiles({ "go.mod": "module x" }));
    expect(go.commands.map((c) => c.command)).toContain("go test ./...");
  });

  it("says nothing it cannot read: an empty root has no stack, a stack without a test command warns", async () => {
    const empty = await scanProject(new RootFiles({}));
    expect(empty.stack).toEqual([]);
    expect(empty.advice).toEqual([]);
    const bare = await scanProject(
      new RootFiles({ "package.json": JSON.stringify({ name: "x" }), "package-lock.json": "" }),
    );
    expect(bare.advice.some((a) => a.advice.startsWith("No test command"))).toBe(true);
    const broken = await scanProject(new RootFiles({ "package.json": "{nope" }));
    expect(broken.stack[0]).toContain("not valid JSON");
  });

  it("flags two lockfiles", async () => {
    const scan = await scanProject(
      new RootFiles({
        "package.json": JSON.stringify({ scripts: { test: "x" } }),
        "yarn.lock": "",
        "package-lock.json": "",
      }),
    );
    expect(scan.advice[0]?.advice).toContain("Pick one package manager");
  });
});

describe("review findings of the reader", () => {
  it("lists real folders only, normalises an owner and keeps the file short", async () => {
    const files = new RootFiles({
      ...NODE_FILES,
      Makefile: "test:\n",
      "src/lib/money.ts": TS_MONEY,
    });
    const scan = await scanProject(files);
    expect(scan.layout[0]).toBe("Folders: src.");
    const context = contextOf(files, { tree: [{ path: "src/lib/money.ts", text: TS_MONEY }] });
    const dotted = await run(context, ["own", "money", "./src//lib/money.ts"], "bricks");
    expect(dotted.ok && dotted.value).toMatchObject({
      bricks: { declared: { owner: "src/lib/money.ts" } },
    });
    const folder = await run(context, ["own", "cash", "src/lib"], "bricks");
    expect(folder.ok && folder.value).toMatchObject({
      bricks: { declared: { owner: "src/lib/" } },
    });
    const big = renderProfile(
      {
        stack: Array.from({ length: 30 }, (_, i) => `s${i}`),
        commands: Array.from({ length: 30 }, (_, i) => ({
          name: "test" as const,
          command: `c${i}`,
          source: "x",
        })),
        conventions: Array.from({ length: 30 }, (_, i) => `c${i}`),
        layout: ["a", "b", "c", "d"],
        advice: Array.from({ length: 30 }, (_, i) => ({ advice: `a${i}`, why: "because" })),
      },
      { sources: [], acceptance: "", notes: "" },
    );
    expect(big.split("\n").length).toBeLessThanOrEqual(60);
  });

  it("reads the notes and the table whatever their order", () => {
    const text =
      "# P\n\n## Notes\nfirst\n\n## Single sources\n| Concept | Owner | Rule |\n| --- | --- | --- |\n| money | src/m.ts | r |\n";
    expect(parseKept(text)).toEqual({
      sources: [{ concept: "money", owner: "src/m.ts", rule: "r" }],
      acceptance: "",
      notes: "first",
    });
  });
});

describe("the profile file", () => {
  it("keeps the single sources and the notes through a refresh, and stays short", async () => {
    const scan = await scanProject(new RootFiles(NODE_FILES));
    const first = renderProfile(scan, {
      sources: [{ concept: "money", owner: "src/money.ts", rule: "cents only" }],
      acceptance: "",
      notes: "Ask before touching billing.",
    });
    expect(first.split("\n").length).toBeLessThan(60);
    const kept = parseKept(first);
    expect(kept.sources).toEqual([{ concept: "money", owner: "src/money.ts", rule: "cents only" }]);
    expect(kept.notes).toBe("Ask before touching billing.");
    expect(renderProfile(scan, kept)).toBe(first);
    expect(parseKept(renderProfile(scan, { sources: [], acceptance: "", notes: "" })).notes).toBe(
      "",
    );
    const replaced = withSource(kept, { concept: "Money", owner: "src/cents/", rule: "" });
    expect(replaced.sources).toEqual([{ concept: "Money", owner: "src/cents/", rule: "" }]);
  });
});

const TS_MONEY = `export function formatMoney(cents: number, currency: string): string {
  return String(cents) + currency;
}
export class PriceList {
  total(): number { return 0; }
}
export type Cents = number;
const helper = () => 1;
`;

describe("the registry of bricks", () => {
  it("lists what other files could import, in several languages, never the nested ones", () => {
    const ts = bricksOf("src/money.ts", TS_MONEY);
    expect(ts.map((b) => `${b.kind}:${b.name}`)).toEqual([
      "fn:formatMoney",
      "fn:helper",
      "type:PriceList",
      "type:Cents",
    ]);
    expect(ts[0]?.sig).toBe("formatMoney(cents, currency)");
    const py = bricksOf(
      "app/dates.py",
      "def parse_date(text):\n    pass\n\nclass Clock:\n    def now(self):\n        pass\n",
    );
    expect(py.map((b) => b.name)).toEqual(["parse_date", "Clock"]);
    const go = bricksOf(
      "pkg/m.go",
      "func FormatMoney(c int) string {\n}\ntype Money struct {\n}\n",
    );
    expect(go.map((b) => b.name)).toEqual(["FormatMoney", "Money"]);
  });

  it("reads a parameter list that runs over several lines, and ignores a re-export", () => {
    const text = [
      "export function detectAll(",
      "  files: readonly File[],",
      "  added: ReadonlyMap<string, ReadonlySet<number>>,",
      "  options: Options = {},",
      "): Result {",
      "  return x;",
      "}",
      "export const buildIt = async (",
      "  input: string,",
      ") => input;",
      "export {",
      "  type Hidden,",
      "  type Other",
      "};",
    ].join("\n");
    const found = bricksOf("src/a.ts", text);
    expect(found.map((b) => b.sig)).toEqual(["detectAll(files, added, options)", "buildIt(input)"]);
  });

  it("answers « does it exist? » by names, then paths, and says when nothing does", () => {
    const bricks = buildBricks([
      { path: "src/money.ts", text: TS_MONEY },
      {
        path: "src/dates.ts",
        text: "export function parseDate(text: string): Date {\n  return new Date(text);\n}\n",
      },
      { path: "src/money.test.ts", text: "export function formatMoney() {}\n" },
    ]);
    expect(bricks.map((b) => b.path)).not.toContain("src/money.test.ts");
    expect(findBricks(bricks, ["format", "money"])[0]?.brick.name).toBe("formatMoney");
    expect(findBricks(bricks, ["parsing", "dates"])[0]?.brick.name).toBe("parseDate");
    expect(findBricks(bricks, ["invoice", "pdf"])).toEqual([]);
    expect(findBricks(bricks, [])).toEqual([]);
    expect(searchWords(["the", "pricesList", "of"])).toEqual(searchWords(["price", "list"]));
    expect(searchWords(["parsing"])).toEqual(searchWords(["parse"]));
    expect(searchWords(["formatting", "prices"])).toEqual(searchWords(["format", "price"]));
  });

  it("matches a declared single source by its concept and flags a second home", () => {
    const sources = [{ concept: "format money", owner: "src/money.ts", rule: "" }];
    expect(matchingSources(sources, ["how", "to", "format", "money"])).toHaveLength(1);
    expect(matchingSources(sources, ["format"])).toHaveLength(0);
    const files: SourceFile[] = [
      { path: "src/money.ts", text: TS_MONEY },
      {
        path: "src/cart.ts",
        text: "export function formatMoneyShort(c: number) {\n  return c;\n}\nexport function other() {}\n",
      },
    ];
    const added = new Map([
      ["src/cart.ts", new Set([1, 4])],
      ["src/money.ts", new Set([1])],
    ]);
    const clashes = sourceClashes(files, added, sources);
    expect(clashes).toEqual([
      {
        name: "formatMoneyShort",
        path: "src/cart.ts",
        line: 1,
        concept: "format money",
        owner: "src/money.ts",
      },
    ]);
    const folder = [{ concept: "format money", owner: "src/", rule: "" }];
    expect(sourceClashes(files, added, folder)).toEqual([]);
  });
});

const DIFF = `diff --git a/src/cart.ts b/src/cart.ts
--- a/src/cart.ts
+++ b/src/cart.ts
@@ -0,0 +1,3 @@
+export function formatMoneyShort(c: number) {
+  return c;
+}
`;

describe("the control of second homes at review", () => {
  it("adds a finding the reviewer cannot drop, a line for the reader, and survives the cache", () => {
    const tree: SourceFile[] = [
      { path: "src/money.ts", text: TS_MONEY },
      {
        path: "src/cart.ts",
        text: "export function formatMoneyShort(c: number) {\n  return c;\n}\n",
      },
    ];
    const sources = [{ concept: "money", owner: "src/money.ts", rule: "" }];
    const report = analyzeReuse(parseDiff(DIFF), tree, {}, sources);
    expect(report.clashes).toHaveLength(1);
    const findings = duplicateFindings(report);
    expect(findings[0]?.severity).toBe("should_fix");
    expect(findings[0]?.title).toContain('Second home for "money"');
    expect(reuseLines(report).some((l) => l.startsWith("single source:"))).toBe(true);
    expect(isReuseReport(JSON.parse(JSON.stringify(report)))).toBe(true);
    expect(isReuseReport({ ...report, clashes: [{ name: 1 }] })).toBe(false);
    expect(analyzeReuse(parseDiff(DIFF), tree).clashes).toBeUndefined();
  });
});

function contextOf(
  files: MemoryFiles,
  options: { commit?: () => string; tree?: SourceFile[]; reads?: { count: number } } = {},
): CommandContext {
  const docsBase: DocsBase = {
    async read() {
      return { found: true, commit: options.commit?.() ?? "a".repeat(40), files: [] };
    },
    async readBlobs() {
      return new Map();
    },
    async blobsInHistory() {
      return new Set();
    },
  };
  const codeSource: CodeSource = {
    async read(_commit, accept) {
      if (options.reads !== undefined) options.reads.count += 1;
      return (options.tree ?? []).filter((file) => accept(file.path, file.text.length));
    },
  };
  return {
    files,
    tools: { detect: async () => [] } as never,
    method: shippedMethod(),
    actor: "human",
    engineVersion: "1.2.3",
    docsBase,
    codeSource,
  } as unknown as CommandContext;
}

const run = (context: CommandContext, words: string[], action: "profile" | "bricks") =>
  createCommandRegistry().run("docs", context, { action, words });

describe("docs profile", () => {
  it("shows, then writes, then reports current or stale", async () => {
    const files = new RootFiles(NODE_FILES);
    const context = contextOf(files);
    const absent = await run(context, [], "profile");
    expect(absent.ok && absent.value).toMatchObject({
      profile: { state: "absent", written: false },
    });
    expect(files.files.has(PROFILE_PATH)).toBe(false);
    const created = await run(context, ["refresh"], "profile");
    expect(created.ok && created.value).toMatchObject({
      profile: { state: "created", written: true },
    });
    expect(files.files.get(PROFILE_PATH)).toContain("`pnpm test` (package.json scripts.test)");
    expect(files.files.get(PROFILE_PATH)).not.toContain("\r");
    const current = await run(context, ["refresh"], "profile");
    expect(current.ok && current.value).toMatchObject({
      profile: { state: "current", written: false },
    });
    files.seed(
      "package.json",
      JSON.stringify({ scripts: { test: "jest" }, packageManager: "npm@10" }),
    );
    const stale = await run(context, [], "profile");
    expect(stale.ok && stale.value).toMatchObject({ profile: { state: "stale" } });
    const refreshed = await run(context, ["refresh"], "profile");
    expect(refreshed.ok && refreshed.value).toMatchObject({
      profile: { state: "refreshed", written: true },
    });
  });

  it("refuses an unknown word", async () => {
    const result = await run(contextOf(new RootFiles({})), ["delete"], "profile");
    expect(!result.ok && result.error.details.reason).toContain("profile [refresh]");
  });
});

describe("docs bricks", () => {
  const tree: SourceFile[] = [{ path: "src/money.ts", text: TS_MONEY }];

  it("finds a brick, reads the code once per commit and again when the commit moves", async () => {
    const files = new RootFiles(NODE_FILES);
    const reads = { count: 0 };
    let commit = "a".repeat(40);
    const context = contextOf(files, { tree, reads, commit: () => commit });
    const first = await run(context, ["format", "money"], "bricks");
    expect(first.ok && first.value).toMatchObject({
      bricks: {
        hits: [{ name: "formatMoney", path: "src/money.ts", line: 1 }],
        searched: { total: 4 },
      },
    });
    expect(files.files.has(BRICKS_CACHE_PATH)).toBe(true);
    await run(context, ["price", "list"], "bricks");
    expect(reads.count).toBe(1);
    commit = "b".repeat(40);
    await run(context, ["price"], "bricks");
    expect(reads.count).toBe(2);
    const none = await run(context, ["invoice", "pdf"], "bricks");
    expect(none.ok && none.value).toMatchObject({ bricks: { hits: [], sources: [] } });
  });

  it("declares a single source, returns it first, and refuses a path that is not the product's", async () => {
    const files = new RootFiles({ ...NODE_FILES, "src/money.ts": TS_MONEY });
    const context = contextOf(files, { tree });
    const declared = await run(
      context,
      ["own", "money", "src/money.ts", "cents", "only"],
      "bricks",
    );
    expect(declared.ok && declared.value).toMatchObject({
      bricks: { declared: { concept: "money", owner: "src/money.ts", rule: "cents only" } },
    });
    expect(parseKept(files.files.get(PROFILE_PATH) as string).sources).toHaveLength(1);
    const found = await run(context, ["money"], "bricks");
    expect(found.ok && found.value).toMatchObject({
      bricks: { sources: [{ concept: "money", owner: "src/money.ts" }] },
    });
    for (const bad of [
      ["own", "money", "../x"],
      ["own", "money", "src/none.ts"],
      ["own", "x"],
    ]) {
      const refused = await run(context, bad, "bricks");
      expect(refused.ok).toBe(false);
    }
    expect((await run(context, [], "bricks")).ok).toBe(false);
  });

  it("says the registry is unavailable without a repository rather than inventing an answer", async () => {
    const context = { ...contextOf(new RootFiles({})), codeSource: undefined } as CommandContext;
    const result = await run(context, ["anything"], "bricks");
    expect(result.ok && result.value).toMatchObject({ bricks: { unavailable: "no_code_source" } });
  });
});

describe("the acceptance place of the profile", () => {
  it("is written once, kept through a refresh, and refused when it is not a place", async () => {
    const files = new RootFiles({ ...NODE_FILES });
    const context = contextOf(files);
    const linesOf = async (words: string[]) => {
      const result = await run(context, words, "profile");
      return result.ok
        ? (result.value as { profile: { lines: string[] } }).profile.lines.join("\n")
        : "";
    };
    expect(await linesOf(["refresh"])).toContain("## Acceptance\n(not set)");
    const words = ["accept", "staging", "preview", "deploy", "of", "the", "branch"];
    expect(await linesOf(words)).toContain(
      "## Acceptance\n- Place: staging\n- How: preview deploy of the branch",
    );
    expect(await linesOf(["refresh"])).toContain("- Place: staging");
    const text = await files.readText(PROFILE_PATH);
    expect(parseKept(text).acceptance).toBe(
      "- Place: staging\n- How: preview deploy of the branch",
    );
    expect(parseKept(text).notes).toBe("");
    expect((await run(context, ["accept", "prod"], "profile")).ok).toBe(false);
  });
});

describe("the brief a developer gets at the start of a story", () => {
  it("is a few lines from the root files, the single sources and one command to ask", async () => {
    const files = new RootFiles({
      ...NODE_FILES,
      [PROFILE_PATH]: renderProfile(await scanProject(new RootFiles(NODE_FILES)), {
        sources: [{ concept: "money", owner: "src/money.ts", rule: "cents" }],
        acceptance: "",
        notes: "",
      }),
    });
    const brief = await profileBrief(contextOf(files));
    expect(brief?.commands).toContain("test: pnpm test");
    expect(brief?.single_sources).toEqual(["money -> src/money.ts (cents)"]);
    expect(brief?.ask).toBe("npx agentplugged docs bricks <words>");
    expect(JSON.stringify(brief).length).toBeLessThan(1200);
    expect(await profileBrief(contextOf(new RootFiles({})))).toBeUndefined();
  });
});
