import { METHOD_DIR } from "../init/layout.js";

/**
 * The tests that cite a requirement. The convention holds in any language: a test
 * cites a requirement by writing its id in its name, in a comment or in its file's name, `EF-18`,
 * or `EF_18` where a name takes no dash (`test_EF_18_signs_in`, `void test_ef_18(void)`,
 * `sub test_EF_18`, `func TestEF_18`). The case is ignored; the id is bounded (no letter nor digit
 * before it, a glued `test` prefix aside, no digit after it). Only test files count, known by
 * their path (`isTestPath`). The lines are read through a port (Git), in the current working copy:
 * a story's tests show from its worktree, and from the main checkout once merged. Tests written
 * inside source files (Rust's `#[cfg(test)]` modules) are not seen.
 */

/** A line of a file that may cite a requirement: its path from the workspace, number and text. */
export interface CandidateLine {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** What the port read: candidate lines, or why there are none to read. */
export type TestReferenceRead =
  | {
      readonly found: true;
      readonly lines: readonly CandidateLine[];
      /**
       * The paths of the candidate files whose name may cite a requirement (`tests/EF-18_login.py`),
       * whatever their content.
       */
      readonly files: readonly string[];
      /** More lines matched than the port reads (`MAX_CANDIDATE_LINES`). */
      readonly truncated: boolean;
    }
  | {
      readonly found: false;
      /** No repository (or no Git) here: no test is read, never a failure. */
      readonly reason: "unavailable";
      readonly detail?: string;
    };

/**
 * Port through which `trace` and `get_trace` read the lines that may cite a requirement: the files
 * of the workspace (tracked, and untracked but not ignored), under the workspace's folder, whose
 * path holds `test`, `spec` or `e2e`, or ends with `.t` (any case), and whose line holds `EF` or
 * `ENF` followed by `-` or `_` and a digit, any case; and such files whose name holds one. `core`
 * keeps the test files and the real ids.
 */
export interface TestReferenceSource {
  /**
   * `workspace`: the working copy of a story (as `story.started` recorded it, relative to the
   * repository) when its tests are read there, beside the project's; it must belong to the same
   * repository, else the tests are `unavailable`.
   */
  read(workspace?: string): Promise<TestReferenceRead>;
}

/** Most candidate lines a read keeps. */
export const MAX_CANDIDATE_LINES = 20_000;

/** One citation of a requirement by a test: the requirement, the file and the line. */
export interface TestReference {
  readonly requirement: string;
  readonly path: string;
  /** The line, from 1; 0 when the file's name cites it. */
  readonly line: number;
}

/**
 * Documents and data never count as tests, whatever their folder or name (`specs/login.md`,
 * `tests/fixtures/users.json`, `.github/workflows/test.yml`).
 */
const NOT_A_TEST =
  /\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|org|html?|pdf|json|ya?ml|toml|csv|lock|snap)$/i;

/** Folders whose files are tests: a word of their name (`tests`, `Foo.Tests`, `e2e`, `specs`). */
const TEST_DIR_WORD = /(?:^|[._-])(?:__tests__|tests?|specs?|e2e)(?:[._-]|$)/i;

/** `foo.test.ts`, `foo_test.go`, `test_foo.py`, `foo-spec.js`, `login.e2e.ts`, `login.cy.ts`… */
const TEST_WORD = /(?:^|[._-])(?:tests?|specs?|e2e|cy)(?:[._-]|$)/i;

/** `FooTest.java`, `FooTests.cs`, `FooSpec.scala`, `TestFoo.java` (case as written). */
const TEST_CAMEL = /(?:[a-z0-9](?:Tests?|Specs?)\.[^.]+$)|(?:^Test[A-Z0-9_])/;

/**
 * True for a test file: a file under a folder named for tests (`test`, `tests`, `__tests__`,
 * `spec`, `specs`, `e2e`, or with such a word, `Foo.Tests`), or whose name marks a test
 * (`*.test.*`, `*.spec.*`, `*_test.*`, `*-spec.*`, `test_*`, `*.e2e.*`, `*.cy.*`, `*Test.*`,
 * `*Tests.*`, `*Spec.*`, `Test*`), or a Perl test (`*.t`). The method's own folder, documents and
 * data (`.md`, `.txt`, `.rst`, `.html`, `.json`, `.yml`…) never count.
 */
export function isTestPath(path: string): boolean {
  const parts = path
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "");
  const name = parts.pop();
  if (name === undefined) return false;
  if (parts.some((part) => part.toLowerCase() === METHOD_DIR) || NOT_A_TEST.test(name)) {
    return false;
  }
  if (parts.some((part) => TEST_DIR_WORD.test(part))) return true;
  if (name.toLowerCase().endsWith(".t")) return true;
  return TEST_WORD.test(name) || TEST_CAMEL.test(name);
}

/**
 * A requirement cited in a line: bounded (a glued `test` prefix allowed: `TestEF_18`), `-` or
 * `_`, any case. `EF_1_2` cites `EF-1` only: write `EF_1_EF_2` for both.
 */
const REFERENCE = /(?<![A-Za-z0-9])(?:test)?(EF|ENF)[-_]([1-9][0-9]*)(?![0-9])/gi;

/** The requirements a line cites (`EF-18`), each once, in the order of the line. */
export function requirementsInLine(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(REFERENCE)) {
    const id = `${(match[1] ?? "").toUpperCase()}-${match[2] ?? ""}`;
    if (!found.includes(id)) found.push(id);
  }
  return found;
}

/**
 * The citations of requirements by tests, from the candidate lines and the candidate files' names
 * (line 0): test files only, each requirement once per line, sorted by path then line.
 */
export function testReferences(
  lines: readonly CandidateLine[],
  files: readonly string[] = [],
): TestReference[] {
  const references: TestReference[] = [];
  for (const path of new Set(files)) {
    if (!isTestPath(path)) continue;
    const name = path.replaceAll("\\", "/").split("/").pop() ?? "";
    for (const requirement of requirementsInLine(name)) {
      references.push({ requirement, path, line: 0 });
    }
  }
  for (const candidate of lines) {
    if (!isTestPath(candidate.path)) continue;
    for (const requirement of requirementsInLine(candidate.text)) {
      references.push({ requirement, path: candidate.path, line: candidate.line });
    }
  }
  return references.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
}
