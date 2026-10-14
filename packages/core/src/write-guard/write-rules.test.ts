import { describe, expect, it } from "vitest";
import { secretKind } from "../doctor/support-report.js";
import { decisionGuards, decisionViolation } from "./write-decisions.js";
import { writeGuardLine } from "./write-line.js";
import { settle } from "./write-path.js";
import { inScope, isSafePath, pathsNamedIn, widenedEntries } from "./write-scope.js";

/**
 * The pure rules of the guard before a write: the secrets, the files a story names,
 * and the architecture decisions that state a checkable line. No journal, no file.
 */

/** A key of a known shape, built here so that this file holds no secret. */
const githubToken = () => `ghp_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3nR6"}`;

describe("the secrets the guard refuses", () => {
  it("names the kind of a key that names itself, never a part of its value", () => {
    expect(secretKind(`const token = "${githubToken()}";`)).toBe("GitHub token");
    expect(secretKind(`AKIA${"ABCDEFGHIJKLMNOP"}`)).toBe("AWS access key");
    const body = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
    expect(
      secretKind(`-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`),
    ).toBe("private key");
    expect(secretKind(`-----BEGIN PGP PRIVATE KEY BLOCK-----\r\n${body}`)).toBe("private key");
    expect(secretKind(`sk_live_${"a1B2c3D4e5F6g7H8"}`)).toBe("Stripe key");
    expect(secretKind(`ASIA${"ABCDEFGHIJKLMNOP"}`)).toBe("AWS access key");
    expect(secretKind(`hf_${"aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL3n"}`)).toBe("Hugging Face token");
    expect(secretKind(`SG.${"aB3dE6gH9jK2mN5p"}.${"Q8sT1vW4yZ7cF0hL"}`)).toBe("SendGrid key");
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJhZGEifQ", "dBjftJeZ4CVPmB92K27uhbUJU1p1r"];
    expect(secretKind(jwt.join("."))).toBe("JWT");
  });

  it("lets through a header quoted in a document, and a token that says it is an example", () => {
    expect(
      secretKind("-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"),
    ).toBeUndefined();
    expect(secretKind("AKIAIOSFODNN7EXAMPLE")).toBeUndefined();
    expect(secretKind("OPENAI_API_KEY=sk-your-api-key-goes-here")).toBeUndefined();
    expect(secretKind(`ghp_${"x".repeat(36)}`)).toBeUndefined();
    expect(secretKind(`ghp_${"a1".repeat(18)}`)).toBeUndefined();
    // A real one beside a placeholder is still found.
    expect(secretKind(`AKIAIOSFODNN7EXAMPLE ${githubToken()}`)).toBe("GitHub token");
  });

  it("reads a text of millions of characters in the time of a hook, whatever it repeats", () => {
    const hostile = [
      "eyJ-".repeat(1_000_000),
      "sk-".repeat(1_300_000),
      "github_pat_".repeat(400_000),
      "AIza".repeat(1_000_000),
      "xox-".repeat(1_000_000),
      "-----BEGIN PRIVATE KEY-----".repeat(140_000),
      "ya29.".repeat(800_000),
    ];
    for (const text of hostile) {
      const started = Date.now();
      secretKind(text);
      expect(Date.now() - started, text.slice(0, 12)).toBeLessThan(1500);
    }
  });

  it("lets through what is not a key: a hash, a long identifier, prose, a variable name", () => {
    expect(secretKind("a".repeat(64))).toBeUndefined();
    expect(secretKind("const veryLongIdentifierNameThatKeepsGoingAndGoingOn = 1;")).toBeUndefined();
    expect(secretKind("Basic setup of the Bearer authentication")).toBeUndefined();
    expect(secretKind("const token = process.env.GITHUB_TOKEN;")).toBeUndefined();
    expect(secretKind("password: string")).toBeUndefined();
    expect(secretKind("the ghp_ prefix names a GitHub token")).toBeUndefined();
  });
});

describe("the files a story names", () => {
  it("reads the paths of a story's text: code spans, bare files, folders; never a URL or a word", () => {
    const entries = pathsNamedIn(
      [
        "Hooks in `packages/core/src/chat/` and `decision-hook.ts`, see economy.test.ts.",
        "The folder packages/core/src/review/ holds the rules; docs at https://example.com/a/b.html.",
        "Use and/or, input/output, the word hooks, and {project-root}/apps/cli/src/main.ts.",
        "A command: `corepack pnpm test` and `src/a.ts, src/b.ts`.",
      ].join("\n"),
    );
    const patterns = entries.map((entry) => entry.pattern);
    expect(patterns).toContain("packages/core/src/chat/");
    expect(patterns).toContain("decision-hook.ts");
    expect(patterns).toContain("economy.test.ts");
    expect(patterns).toContain("packages/core/src/review/");
    expect(patterns).toContain("apps/cli/src/main.ts");
    expect(patterns).toContain("src/a.ts");
    expect(patterns).toContain("src/b.ts");
    expect(patterns.some((pattern) => pattern.includes("example.com"))).toBe(false);
    expect(patterns).not.toContain("hooks");
    expect(patterns).not.toContain("and/or");
    expect(entries.find((entry) => entry.pattern === "packages/core/src/chat/")?.folder).toBe(true);
  });

  it("reads a placeholder segment as one name, and keeps the other cautions", () => {
    const patterns = (text: string) => pathsNamedIn(text).map((entry) => entry.pattern);
    expect(patterns("`apps/service/src/modules/<module>/`")).toEqual([
      "apps/service/src/modules/*/",
    ]);
    expect(patterns("`src/{name}/index.ts`")).toEqual(["src/*/index.ts"]);
    expect(patterns("`app/[id]/page.tsx`")).toEqual(["app/*/page.tsx"]);
    expect(patterns("`api/:version/routes.ts`")).toEqual(["api/*/routes.ts"]);
    // A placeholder inside a name, an absolute path, a URL or a parent folder are still no path.
    expect(patterns("`src/<a>b/x.ts`")).toEqual([]);
    expect(patterns("`/<module>/x.ts`")).toEqual([]);
    expect(patterns("`https://host/<module>/x.ts`")).toEqual([]);
    expect(patterns("`../<module>/x.ts`")).toEqual([]);
    expect(patterns("`<module>`")).toEqual([]);
    expect(patterns("`<module>/`")).toEqual([]);
    expect(patterns("`:id/x.ts`")).toEqual([]);
    expect(patterns("`<a>/<b>/`")).toEqual([]);
    const scope = pathsNamedIn("`apps/service/src/modules/<module>/`");
    expect(inScope("apps/service/src/modules/documentation/documentation.module.ts", scope)).toBe(
      true,
    );
    // One folder per placeholder, not a tree: the glob keeps the folder prefix, nothing above it.
    expect(inScope("apps/service/src/app.ts", scope)).toBe(false);
    expect(inScope("apps/service/src/socle/erreurs.ts", scope)).toBe(false);
    const file = pathsNamedIn("`src/<module>/index.ts`");
    expect(inScope("src/billing/index.ts", file)).toBe(true);
    expect(inScope("src/billing/deep/index.ts", file)).toBe(false);
  });

  it("places a path: a named file, inside a named folder, next to a named file, or a safe exception", () => {
    const scope = pathsNamedIn("`packages/core/src/chat/` `apps/cli/src/main.ts` economy.test.ts");
    expect(inScope("packages/core/src/chat/new-hook.ts", scope)).toBe(true);
    expect(inScope("apps/cli/src/main.ts", scope)).toBe(true);
    // A new neighbour of a named file belongs to the same change.
    expect(inScope("apps/cli/src/helper.ts", scope)).toBe(true);
    expect(inScope("apps/cli/src/deeper/helper.ts", scope)).toBe(false);
    expect(inScope("apps/cli/src/economy.test.ts", scope)).toBe(true);
    // A product that sits in a subfolder of its working copy.
    expect(inScope("shop/packages/core/src/chat/x.ts", scope)).toBe(true);
    expect(inScope("packages/protocol/src/index.ts", scope)).toBe(false);
    expect(inScope("packages/core/src/chatty.ts", scope)).toBe(false);
  });

  it("never refuses the safe exceptions: tests, documents, the method's folders, lock files", () => {
    const scope = pathsNamedIn("`packages/core/src/chat/`");
    for (const path of [
      "packages/other/src/thing.test.ts",
      "packages/other/__tests__/a.ts",
      "docs/guide.md",
      "README.md",
      ".agentplugged/stories/1-3.md",
      "pnpm-lock.yaml",
      "packages/other/dist/index.js",
    ]) {
      expect(isSafePath(path), path).toBe(true);
      expect(inScope(path, scope), path).toBe(true);
    }
    expect(isSafePath("packages/other/src/thing.ts")).toBe(false);
  });

  it("knows nothing when the story names no file: nothing can be refused", () => {
    expect(inScope("src/anything.ts", [])).toBeUndefined();
  });

  it("takes what the creator added, a bare name being a folder", () => {
    expect(widenedEntries(["packages/protocol/", "scripts", "tools/a.ts"])).toEqual([
      { pattern: "packages/protocol/", folder: true },
      { pattern: "scripts/", folder: true },
      { pattern: "tools/a.ts", folder: false },
    ]);
    const scope = [...pathsNamedIn("`src/a/`"), ...widenedEntries(["packages/protocol/"])];
    expect(inScope("packages/protocol/src/index.ts", scope)).toBe(true);
  });

  it("compares paths without regard to case, as Windows and macOS do", () => {
    const scope = pathsNamedIn("`src/ui/` and `Docs/Spec.ts`");
    expect(inScope("SRC/UI/Page.ts", scope)).toBe(true);
    expect(inScope("docs/spec.ts", scope)).toBe(true);
    expect(isSafePath("Packages/X/TESTS/a.ts")).toBe(true);
  });

  it("matches a glob in a time that does not grow with its jokers, and nothing with too many", () => {
    const path = Array.from({ length: 60 }, (_, index) => `d${index}`).join("/");
    const started = Date.now();
    const nested = [
      { pattern: "**/**/**/**/**/**/**/x.ts", folder: false },
      { pattern: "a/*/*/*/*/*/*/*/*/x.ts", folder: false },
      { pattern: "**/*/**/*/**/*/**/*/x.ts", folder: false },
    ];
    expect(inScope(`${path}/y.ts`, nested)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    // Folded jokers still match what a single one matches.
    expect(inScope("a/b/c/x.ts", [{ pattern: "**/**/x.ts", folder: false }])).toBe(true);
  });

  it("settles a path: dots, double slashes, backslashes; undefined when it climbs out", () => {
    expect(settle("a/./b//c")).toBe("a/b/c");
    expect(settle("a\\b\\..\\c")).toBe("a/c");
    expect(settle("../a")).toBeUndefined();
  });
});

const ARCHITECTURE = [
  "---",
  "id: architecture",
  "kind: architecture",
  "owner: creator",
  "---",
  "# Architecture",
  "",
  "### AD-1 — No left-pad",
  "",
  "- **Binds:** the dependencies.",
  "- **Prevents:** a trivial package.",
  "- **Rule:** we write it ourselves.",
  "- **Guard:** no dependency left-pad",
  "",
  "### AD-2 — The UI never reaches the database",
  "",
  "- **Rule:** the UI goes through the API.",
  "- **Guard:** never import pg from src/ui/**",
  "- **Garde :** jamais importer `src/db/` depuis `src/web/`",
  "",
  "### AD-3 — One writer per piece of data",
  "",
  "- **Rule:** prose only, nothing a machine can check.",
  "",
  "### AD-4 — (retired) Old rule",
  "",
  "- **Guard:** no dependency lodash",
  "",
].join("\n");

describe("the architecture decisions the guard can check", () => {
  it("reads the checkable lines of the active decisions, in English and in French, and counts the others", () => {
    const { guards, unverifiable } = decisionGuards("architecture.md", ARCHITECTURE);
    expect(guards).toEqual([
      { id: "AD-1", kind: "dependency", name: "left-pad" },
      { id: "AD-2", kind: "import", module: "pg", from: "src/ui/**" },
      { id: "AD-2", kind: "import", module: "src/db/", from: "src/web/" },
    ]);
    // AD-3 states nothing checkable; AD-4 is retired and counts for nothing.
    expect(unverifiable).toBe(1);
  });

  it("refuses a manifest that declares a forbidden dependency, whole word only", () => {
    const { guards } = decisionGuards("architecture.md", ARCHITECTURE);
    const manifest = '{ "dependencies": { "left-pad": "^1.3.0" } }';
    expect(decisionViolation(guards, "package.json", manifest)).toEqual({
      decision: "AD-1",
      detail: "dependency left-pad",
    });
    expect(decisionViolation(guards, "apps/web/package.json", manifest)?.decision).toBe("AD-1");
    // A part of another name, or another file, is not the dependency.
    expect(
      decisionViolation(guards, "package.json", '{ "dependencies": { "left-padding": "1" } }'),
    ).toBeUndefined();
    expect(decisionViolation(guards, "src/notes.ts", manifest)).toBeUndefined();
  });

  it("refuses an import of a forbidden module from the folder that must not reach it", () => {
    const { guards } = decisionGuards("architecture.md", ARCHITECTURE);
    const module = (line: string) => decisionViolation(guards, "src/ui/page.ts", line);
    expect(module('import { Pool } from "pg";')?.decision).toBe("AD-2");
    expect(module("const pool = require('pg/lib');")?.decision).toBe("AD-2");
    expect(module('import x from "../db/pg-helper";')).toBeUndefined();
    // The same import elsewhere is allowed; so is the name in a string that is no import.
    expect(
      decisionViolation(guards, "src/db/pool.ts", 'import { Pool } from "pg";'),
    ).toBeUndefined();
    expect(module('const driver = "pg";')).toBeUndefined();
    // A folder of the project is a module too.
    expect(
      decisionViolation(guards, "src/web/index.ts", 'import { q } from "../db/query";')?.decision,
    ).toBe("AD-2");
    expect(decisionViolation(guards, "src/ui/page.py", "from pg import connect")?.decision).toBe(
      "AD-2",
    );
  });
});

describe("the decisions' checks on hostile text", () => {
  const { guards } = decisionGuards("architecture.md", ARCHITECTURE);

  it("read a text of blank lines, or of one huge line, in the time of a hook", () => {
    for (const text of [
      "\n".repeat(400_000),
      `${"import ".repeat(400_000)}`,
      " \t".repeat(1_000_000),
    ]) {
      const started = Date.now();
      expect(decisionViolation(guards, "src/ui/page.py", text)).toBeUndefined();
      expect(Date.now() - started, text.slice(0, 8)).toBeLessThan(1500);
    }
  });

  it("compare the folder of a decision without regard to case", () => {
    expect(
      decisionViolation(guards, "SRC/UI/page.ts", 'import { Pool } from "pg";')?.decision,
    ).toBe("AD-2");
  });
});

describe("the review's line", () => {
  it("says nothing when the guard did nothing, and the counts when it did", () => {
    expect(writeGuardLine(undefined)).toBeUndefined();
    expect(
      writeGuardLine({ refused: { secret: 0, scope: 0, decision: 0, test: 0 }, doubted: 0 }),
    ).toBe(undefined);
    expect(
      writeGuardLine({ refused: { secret: 1, scope: 2, decision: 0, test: 0 }, doubted: 3 }),
    ).toBe(
      "Write guard: 3 writes refused before being written (1 secret, 2 scope); 3 let through in doubt (traced in the journal).",
    );
    expect(
      writeGuardLine({ refused: { secret: 0, scope: 0, decision: 0, test: 0 }, doubted: 1 }),
    ).toBe("Write guard: no write refused; 1 let through in doubt (traced in the journal).");
  });
});
