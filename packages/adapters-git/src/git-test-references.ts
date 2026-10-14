import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type CandidateLine,
  MAX_CANDIDATE_LINES,
  type TestReferenceRead,
  type TestReferenceSource,
} from "@agentplugged/core";
import type { GitFolderOptions, GitRunner } from "./git-docs-base.js";
import { runGit } from "./git-process.js";

/** Longest the search may take before the tests are reported unavailable. */
const TIMEOUT_MS = 60_000;

/** Longest text kept of a line: a requirement id sits well within it. */
const MAX_LINE_LENGTH = 2_000;

/**
 * The broad pattern of a requirement id (POSIX extended, any case): `EF` or `ENF` (a glued `test`
 * prefix allowed), then `-` or `_`, then a digit other than 0, not right after a letter or a
 * digit; or, for the acceptance criteria of a story, `AC`, then three numbers (the
 * story's epic and number, the criterion) joined by `-` or `_`. `core` checks each match.
 */
const PATTERN =
  "(^|[^[:alnum:]])(test)?((ef|enf)[-_][1-9]|ac[-_][1-9][0-9]*[-_][1-9][0-9]*[-_][1-9])";

/** The same, for a file's name. */
const NAME_PATTERN =
  /(?:^|[^A-Za-z0-9])(?:test)?(?:(?:ef|enf)[-_][1-9]|ac[-_][1-9]\d*[-_][1-9]\d*[-_][1-9])/i;

/** The paths that may hold a test: `test`, `spec` or `e2e` in the path, or `*.t`, any case. */
const PATHSPECS = [
  ":(icase)*test*",
  ":(icase)*spec*",
  ":(icase)*e2e*",
  ":(icase)*.cy.*",
  ":(icase)*.t",
];

/** Settings of the user's Git that would change the output's shape: neutralised. */
const NEUTRAL_CONFIG = [
  "-c",
  "core.quotePath=off",
  "-c",
  "grep.fullName=false",
  "-c",
  "grep.column=false",
  "-c",
  "grep.lineNumber=true",
  "-c",
  "grep.fallbackToNoIndex=false",
];

export type GitTestReferencesOptions = GitFolderOptions;

function unavailable(detail: string): TestReferenceRead {
  return { found: false, reason: "unavailable", detail };
}

/**
 * Reads what may cite a requirement in the test files, over the working tree of the
 * folder `cwd` and below (tracked files, and untracked files Git does not ignore): the lines,
 * with one `git grep` (binary files skipped), and the files whose name may cite one, with one
 * `git ls-files`. Paths are relative to `cwd`. Outside a repository, without Git, or on any Git
 * failure, the tests are `unavailable`: never an error.
 */
export class GitTestReferences implements TestReferenceSource {
  readonly #cwd: string;
  readonly #run: GitRunner;

  constructor(options: GitTestReferencesOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
  }

  /** The Git folder `git` reads in a folder, as a real path, or undefined. */
  async #common(folder: string): Promise<string | undefined> {
    const run = await this.#run(
      folder,
      ["rev-parse", "--git-common-dir"],
      undefined,
      {},
      TIMEOUT_MS,
    );
    const found = run.status === 0 ? run.stdout.toString("utf8").trim() : "";
    return found === "" ? undefined : realpath(resolve(folder, found)).catch(() => undefined);
  }

  /**
   * The folder to read: the project's, or the same folder of a story's working copy,
   * given relative to the repository's top. It must belong to the same repository.
   */
  async #base(workspace: string | undefined): Promise<string | undefined> {
    if (workspace === undefined || workspace === ".") return this.#cwd;
    const git = async (args: string[]) => {
      const run = await this.#run(this.#cwd, args, undefined, {}, TIMEOUT_MS);
      return run.status === 0 ? run.stdout.toString("utf8").trim() : undefined;
    };
    const top = await git(["rev-parse", "--show-toplevel"]);
    const prefix = (await git(["rev-parse", "--show-prefix"])) ?? "";
    if (top === undefined || top === "") return undefined;
    const worktree = resolve(top, workspace);
    const [mine, theirs] = await Promise.all([this.#common(this.#cwd), this.#common(worktree)]);
    return mine !== undefined && mine === theirs ? resolve(worktree, prefix) : undefined;
  }

  async read(workspace?: string): Promise<TestReferenceRead> {
    const base = await this.#base(workspace).catch(() => undefined);
    if (base === undefined) return unavailable("not a working copy of this repository");
    const grepArgs = [
      ...NEUTRAL_CONFIG,
      "grep",
      "--untracked",
      "--no-color",
      "-n",
      "-z",
      "-I",
      "-i",
      "-E",
      "-e",
      PATTERN,
      "--",
      ...PATHSPECS,
    ];
    const listArgs = [
      ...NEUTRAL_CONFIG,
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ...PATHSPECS,
    ];
    try {
      const run = await this.#run(base, grepArgs, undefined, { LC_ALL: "C" }, TIMEOUT_MS);
      // 1: no line matched.
      if (run.status !== 0 && run.status !== 1) {
        return unavailable(run.stderr.split("\n")[0] ?? "");
      }
      const listed = await this.#run(base, listArgs, undefined, { LC_ALL: "C" }, TIMEOUT_MS);
      if (listed.status !== 0) return unavailable(listed.stderr.split("\n")[0] ?? "");
      const files = [
        ...new Set(
          listed.stdout
            .toString("utf8")
            .split("\0")
            .filter((path) => path !== "" && NAME_PATTERN.test(path.split("/").pop() ?? "")),
        ),
      ];
      const read =
        run.status === 1 ? parseGrepOutput("") : parseGrepOutput(run.stdout.toString("utf8"));
      return read.found ? { ...read, files } : read;
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : String(error));
    }
  }
}

/**
 * The lines of `git grep -n -z`: `<path>\0<line>\0<text>\n`, at most `MAX_CANDIDATE_LINES`
 * (then `truncated`), each text cut at `MAX_LINE_LENGTH` without its last, cut word (an id cut in
 * two would cite another requirement). `files` is empty: the caller adds the names it lists.
 */
export function parseGrepOutput(output: string): TestReferenceRead {
  const lines: CandidateLine[] = [];
  let truncated = false;
  for (const record of output.split("\n")) {
    if (record === "") continue;
    const first = record.indexOf("\0");
    const second = first === -1 ? -1 : record.indexOf("\0", first + 1);
    if (second === -1) continue;
    const line = Number(record.slice(first + 1, second));
    if (!Number.isInteger(line) || line < 1) continue;
    if (lines.length >= MAX_CANDIDATE_LINES) {
      truncated = true;
      break;
    }
    const text = record.slice(second + 1).replace(/\r$/, "");
    lines.push({
      path: record.slice(0, first).replaceAll("\\", "/"),
      line,
      text:
        text.length > MAX_LINE_LENGTH
          ? text.slice(0, MAX_LINE_LENGTH).replace(/[A-Za-z0-9_-]+$/, "")
          : text,
    });
  }
  return { found: true, lines, files: [], truncated };
}
