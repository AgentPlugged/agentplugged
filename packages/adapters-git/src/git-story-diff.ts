import type { FreeDiff, FreeDiffRequest, StoryDiff } from "@agentplugged/core";
import type { GitFolderOptions, GitRunner } from "./git-docs-base.js";
import { COMMIT_ID, runGit } from "./git-process.js";

/** Longest the diff may take. */
const TIMEOUT_MS = 60_000;

/** A ref a free review names: a branch, a tag, a commit, `HEAD~3`; never an option, never a range. */
const FREE_REF = /^[A-Za-z0-9_][\w./@{}^~+-]{0,199}$/;
/** Untracked files a free review of the work not committed reads, at most. */
const MAX_UNTRACKED = 200;
/** What a free review of the work not committed leaves out: the method's own folder. */
const METHOD_EXCLUDED = ":(exclude).agentplugged";
/** The longest messages kept for the assertions pass, in characters. */
const MAX_MESSAGES = 20_000;

export type GitStoryDiffOptions = GitFolderOptions;

/**
 * The diff of a story's branch: `git diff <base>...<head>`, the changes of `head`
 * since its merge base with `base`, in the repository's paths (`--no-relative`), without colours,
 * external diff tools nor text conversions, every file as text (an attribute never hides a
 * change), whatever the user's Git settings say, renames detected. Undefined when Git cannot read
 * it. Also the messages of those commits and the diff of a change that belongs to no
 * story (the work not committed, a range, a branch against the main branch).
 */
export class GitStoryDiff implements StoryDiff {
  readonly #cwd: string;
  readonly #run: GitRunner;

  constructor(options: GitStoryDiffOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
  }

  /** From the merge base with the main branch's tip, when Git knows that branch here. */
  async #from(base: string, head: string, ref?: string): Promise<string> {
    // Both the remote-tracking branch (`origin/main`) and the local one (`main`) are tried and the
    // more recent merge base wins: a main branch brought up to date here (or merged into the
    // story's branch) must not make its own work the story's.
    let from = base;
    if (ref !== undefined && /^[\w./-]+$/.test(ref) && !ref.startsWith("-")) {
      const refs = [ref, ...(ref.startsWith("origin/") ? [ref.slice("origin/".length)] : [])];
      const found: string[] = [];
      for (const candidate of refs) {
        const meeting = await this.#run(
          this.#cwd,
          ["merge-base", "--end-of-options", candidate, head],
          undefined,
          { LC_ALL: "C" },
          TIMEOUT_MS,
        ).catch(() => undefined);
        const commit = meeting?.status === 0 ? meeting.stdout.toString("utf8").trim() : "";
        if (COMMIT_ID.test(commit) && !found.includes(commit)) found.push(commit);
      }
      let best = found[0];
      for (const commit of found.slice(1)) {
        // The later one is the one the other is an ancestor of.
        const ancestor = await this.#run(
          this.#cwd,
          ["merge-base", "--is-ancestor", best as string, commit],
          undefined,
          { LC_ALL: "C" },
          TIMEOUT_MS,
        ).catch(() => undefined);
        if (ancestor?.status === 0) best = commit;
      }
      if (best !== undefined) from = best;
    }
    return from;
  }

  /** `git diff <spec>`, set so that no setting of the user changes what is read. */
  async #diff(spec: readonly string[], okStatus = 0): Promise<string | undefined> {
    const run = await this.#run(
      this.#cwd,
      [
        "-c",
        "core.quotePath=off",
        "-c",
        "diff.noprefix=false",
        "-c",
        "diff.mnemonicPrefix=false",
        "-c",
        "diff.relative=false",
        // A submodule is a file like another: neither hidden nor summarised.
        "-c",
        "diff.ignoreSubmodules=none",
        "-c",
        "diff.submodule=short",
        "-c",
        "diff.srcPrefix=a/",
        "-c",
        "diff.dstPrefix=b/",
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--no-relative",
        "--ignore-submodules=none",
        // Every file as text: an attribute (`-diff`, `binary`) never hides a change.
        "--text",
        "-M",
        ...spec,
      ],
      undefined,
      { LC_ALL: "C" },
      TIMEOUT_MS,
    ).catch(() => undefined);
    // `--no-index` ends with 1 when the files differ.
    if (run === undefined || run.status !== okStatus) return undefined;
    return run.stdout.toString("utf8");
  }

  async diff(base: string, head: string, ref?: string): Promise<string | undefined> {
    if (!COMMIT_ID.test(base) || !COMMIT_ID.test(head)) return undefined;
    const from = await this.#from(base, head, ref);
    return await this.#diff([`${from}...${head}`, "--"]);
  }

  async messages(base: string, head: string, ref?: string): Promise<string | undefined> {
    if (!COMMIT_ID.test(base) || !COMMIT_ID.test(head)) return undefined;
    return await this.#log(`${await this.#from(base, head, ref)}..${head}`);
  }

  /** The messages of the commits of a range, newest first, cut short. */
  async #log(range: string): Promise<string | undefined> {
    const run = await this.#run(
      this.#cwd,
      ["log", "--no-color", "--format=%B%n---", "--max-count=100", range, "--"],
      undefined,
      { LC_ALL: "C" },
      TIMEOUT_MS,
    ).catch(() => undefined);
    if (run === undefined || run.status !== 0) return undefined;
    return run.stdout.toString("utf8").slice(0, MAX_MESSAGES);
  }

  /** The first of `main` or `master` that exists here (a local branch, else the remote's). */
  async #mainBranch(): Promise<string | undefined> {
    for (const name of ["main", "master"]) {
      for (const ref of [`refs/heads/${name}`, `refs/remotes/origin/${name}`]) {
        const run = await this.#run(
          this.#cwd,
          ["rev-parse", "-q", "--verify", `${ref}^{commit}`],
          undefined,
          { LC_ALL: "C" },
          TIMEOUT_MS,
        ).catch(() => undefined);
        if (run?.status === 0) return ref.replace(/^refs\/(?:heads|remotes)\//, "");
      }
    }
    return undefined;
  }

  async free(request: FreeDiffRequest): Promise<FreeDiff | undefined> {
    if (request.kind === "uncommitted") {
      // The method's own folder (memory, rooms, reviews of others) is not the change to review.
      const tracked = await this.#diff(["HEAD", "--", METHOD_EXCLUDED]);
      if (tracked === undefined) return undefined;
      // New files Git does not follow yet are part of the work, shown as additions.
      const listed = await this.#run(
        this.#cwd,
        ["ls-files", "--others", "--exclude-standard", "-z", "--", METHOD_EXCLUDED],
        undefined,
        { LC_ALL: "C" },
        TIMEOUT_MS,
      ).catch(() => undefined);
      const names =
        listed?.status === 0
          ? listed.stdout
              .toString("utf8")
              .split("\0")
              .filter((name) => name !== "" && !name.startsWith("-"))
              .slice(0, MAX_UNTRACKED)
          : [];
      let added = "";
      for (const name of names) {
        const part = await this.#diff(["--no-index", "--", "/dev/null", name], 1);
        if (part !== undefined) added += part;
      }
      return { diff: tracked + added, messages: "" };
    }
    if (request.kind === "range") {
      if (!FREE_REF.test(request.from) || !FREE_REF.test(request.to)) return undefined;
      const diff = await this.#diff([`${request.from}${request.dots}${request.to}`, "--"]);
      if (diff === undefined) return undefined;
      return { diff, messages: (await this.#log(`${request.from}..${request.to}`)) ?? "" };
    }
    if (!FREE_REF.test(request.name)) return undefined;
    const base = await this.#mainBranch();
    if (base === undefined) return undefined;
    const diff = await this.#diff([`${base}...${request.name}`, "--"]);
    if (diff === undefined) return undefined;
    return { diff, messages: (await this.#log(`${base}..${request.name}`)) ?? "" };
  }
}
