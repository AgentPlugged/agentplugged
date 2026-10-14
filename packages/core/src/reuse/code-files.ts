/**
 * Which files of a repository the duplicate detector reads: the source
 * code a person wrote and maintains. Tests (repetitive by nature), generated code, lockfiles,
 * minified bundles, binaries, documents and the folders every tool ignores are left out, whatever
 * the language.
 */

import { wordSet } from "./tokens.js";

const CODE_EXTENSION = wordSet(
  `js jsx mjs cjs ts tsx mts cts vue svelte astro py pyi rb go rs java kt kts scala groovy swift m mm
  c h cc cpp cxx hpp hh cs php dart lua pl pm r ex exs hs nim zig cr sh bash zsh ps1 sql`,
);

const IGNORED_FOLDER = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "third_party",
  "thirdparty",
  ".git",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".method",
  ".agentplugged",
  "coverage",
  "bin",
  "obj",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "site-packages",
  "generated",
  "__generated__",
  "migrations",
]);

const TEST_FILE =
  /(?:\.(?:test|spec|e2e|cy|stories)\.|_test\.|_spec\.|(?:^|\/)test_[^/]*\.py$|(?:^|\/)(?:tests?|__tests__|__mocks__|__snapshots__|spec|specs|e2e|fixtures?|testdata|testing)\/)/i;

/**
 * Helpers that only tests use: `__helpers__/`, `pair.test-support.ts`, a `*-testkit/` folder. They
 * repeat the code they stand in for by design, like the tests.
 */
const TEST_SUPPORT =
  /(?:\.test-(?:support|utils|helpers)\.|(?:^|\/)(?:__helpers__|(?:[\w.]+-)?testkit)\/)/i;

/** A folder starting with a dot (`.claude`, `.github`, `.husky`) holds tools and settings, not the product. */
const isHidden = (folder: string) => folder.length > 1 && folder.startsWith(".") && folder !== "..";

/** `OrderServiceTest.java`, `CartSpec.scala`: a capitalised suffix after a word (`Latest.java` is not one). */
const TEST_CLASS = /[a-z0-9](?:Test|Tests|Spec)\.(?:java|kt|cs|scala|swift|php)$/;

const GENERATED_FILE =
  /(?:\.min\.|\.bundle\.|\.generated\.|\.gen\.|\.g\.(?:cs|dart)$|\.designer\.cs$|\.pb\.go$|_pb2(?:_grpc)?\.py$|_pb\.(?:js|ts)$|\.d\.ts$|\.snap$)/i;

/** The largest file read (bytes): beyond, it is a bundle or a data dump, not code a person keeps. */
export const MAX_FILE_BYTES = 200_000;

/** True when the detector reads the file: source code, not a test, not generated, not ignored. */
export function isCodePath(path: string): boolean {
  const p = path.replaceAll("\\", "/");
  const parts = p.split("/");
  const name = parts.at(-1) ?? "";
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
  if (!CODE_EXTENSION.has(extension)) return false;
  const folders = parts.slice(0, -1);
  if (folders.some((folder) => IGNORED_FOLDER.has(folder.toLowerCase()) || isHidden(folder))) {
    return false;
  }
  return (
    !TEST_FILE.test(p) &&
    !TEST_SUPPORT.test(p) &&
    !TEST_CLASS.test(name) &&
    !GENERATED_FILE.test(name)
  );
}

/**
 * True when a file's text is not code to compare: a binary (a NUL), or minified (very long lines).
 */
export function isReadableCode(text: string): boolean {
  if (text.length === 0 || text.length > MAX_FILE_BYTES || text.includes("\u0000")) return false;
  const lines = text.split("\n").length;
  return text.length / lines <= 300;
}

const TEST_NAME =
  /(?:\.(?:tests?|specs?|e2e|cy)\.[a-z0-9]+$|[_-](?:test|spec)\.[a-z0-9]+$|(?:^|\/)test_[^/]*\.py$)/i;
/** `OrderServiceTest.java`, `CartSpec.scala`: a capitalised suffix after a word; `Spec` only where it is a test style. */
const TEST_CLASS_NAME =
  /[a-z0-9](?:Tests?\.(?:java|kt|cs|scala|swift|php|groovy)|Spec\.(?:scala|groovy|kt))$/;
const TEST_FOLDER = /(?:^|\/)(?:tests?|__tests__|spec|specs|e2e)\//i;
/** Folders that hold what others wrote or a tool made: no test of the product lives there. */
const NOT_THE_PRODUCT = new Set([
  "node_modules",
  "dist",
  "vendor",
  "third_party",
  "thirdparty",
  ".git",
  "coverage",
  "site-packages",
  "__pycache__",
  ".venv",
  "venv",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".agentplugged",
]);

/**
 * True when the path is a file of tests in a language (the guard before a write): named
 * as one (`a.test.ts`, `a_test.go`, `test_a.py`, `ATest.java`) or, when `folders` is set, inside a
 * folder of tests (`tests/`, `__tests__/`, `spec/`, `e2e/`). `path` is relative to the product:
 * the folders above it say nothing. Generated files, snapshots and what others wrote are no test files.
 */
export function isTestPath(path: string, folders: boolean): boolean {
  const p = path.replaceAll("\\", "/");
  const parts = p.split("/");
  const name = parts.at(-1) ?? "";
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "").toLowerCase() : "";
  if (!CODE_EXTENSION.has(extension) || GENERATED_FILE.test(name)) return false;
  if (parts.slice(0, -1).some((folder) => NOT_THE_PRODUCT.has(folder.toLowerCase()))) return false;
  return TEST_NAME.test(p) || TEST_CLASS_NAME.test(name) || (folders && TEST_FOLDER.test(p));
}
