import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { win32 } from "node:path";
import {
  type BranchPushOutcome,
  type ForgeCliState,
  type ForgeInspection,
  type ForgeMergeOutcome,
  type ForgeMergeRequest,
  type ForgePullRequest,
  type ForgePullRequestState,
  type ForgeRemote,
  type ForgeRepository,
  type ForgeReviewDraft,
  forgeCli,
  type MainInspection,
  type PullRequestDraft,
  type RemoteBranchState,
  type RepositoryCreation,
  type RepositoryRequest,
  repositoryWebUrl,
  type StoryForge,
} from "@agentplugged/core";
import type { GitRunner } from "./git-docs-base.js";
import { COMMIT_ID, gitEnv, lastLine, runGit } from "./git-process.js";

/** Longest one Git or forge command may take (a push included). */
const CALL_TIMEOUT_MS = 120_000;

/** What a forge's tool printed, and whether it could be started at all. */
export interface ToolRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the tool is not installed (it could not be started). */
  readonly missing?: boolean;
  /** True when the tool was stopped at its time limit. */
  readonly timedOut?: boolean;
}

/** Runs a forge's command-line tool (`gh`, `glab`): tests give a fake one, never the real tools. */
export type ToolRunner = (
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly input?: string },
) => Promise<ToolRun>;

/**
 * The environment of the forge's tools: never a prompt, an update check, colours nor a pager.
 * The token stays where the creator's login put it: the engine neither reads nor passes it on.
 */
export function toolEnv(): NodeJS.ProcessEnv {
  return {
    ...gitEnv(),
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_PAGER: "",
    NO_PROMPT: "1",
    GLAB_CHECK_UPDATE: "false",
    GLAB_NO_PROMPT: "1",
    PAGER: "",
    NO_COLOR: "1",
  };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The file a command names on Windows: searched in `PATH` with each extension of `PATHEXT`
 * (`.COM;.EXE;.BAT;.CMD` by default), as `cmd` would, so that `gh.exe` and a `glab.cmd` shim are
 * both found. Undefined when none exists. Elsewhere the command is returned as is.
 */
export function resolveCommand(
  command: string,
  env: Readonly<Record<string, string | undefined>>,
  platform: string = process.platform,
  exists: (path: string) => boolean = isFile,
): string | undefined {
  if (platform !== "win32") return command;
  const key = (name: string) =>
    Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  const pathKey = key("PATH");
  const extKey = key("PATHEXT");
  const extensions = ((extKey === undefined ? undefined : env[extKey]) ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension !== "");
  const candidates = (name: string) =>
    win32.extname(name) !== ""
      ? [name, ...extensions.map((e) => `${name}${e}`)]
      : extensions.map((e) => `${name}${e}`);
  if (win32.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return candidates(command).find(exists);
  }
  const folders = ((pathKey === undefined ? undefined : env[pathKey]) ?? "")
    // Windows paths and separators, whatever the platform the engine runs on (tests on Linux).
    .split(win32.delimiter)
    .map((folder) => folder.trim().replace(/^"(.*)"$/, "$1"))
    .filter((folder) => folder !== "");
  for (const folder of folders) {
    const found = candidates(win32.join(folder, command)).find(exists);
    if (found !== undefined) return found;
  }
  // Installers (winget, the MSI) put the forge tools in a folder they only add to `PATH` for
  // programs started afterwards: a tool installed today is not found by an editor opened before.
  const value = (name: string) => {
    const found = key(name.toUpperCase());
    return found === undefined ? undefined : env[found];
  };
  for (const [variable, ...folder] of INSTALL_FOLDERS[command.toLowerCase()] ?? []) {
    const base = value(variable ?? "");
    if (base === undefined || base.trim() === "") continue;
    const found = candidates(win32.join(base, ...folder, command)).find(exists);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Where the installers of each forge tool put it on Windows: `[environment variable, ...folders]`. */
const INSTALL_FOLDERS: Readonly<Record<string, ReadonlyArray<readonly [string, ...string[]]>>> = {
  gh: [
    ["ProgramFiles", "GitHub CLI"],
    ["ProgramFiles(x86)", "GitHub CLI"],
    ["LOCALAPPDATA", "Programs", "GitHub CLI"],
    ["LOCALAPPDATA", "Microsoft", "WinGet", "Links"],
  ],
  glab: [
    ["ProgramFiles", "glab"],
    ["LOCALAPPDATA", "Programs", "glab"],
    ["LOCALAPPDATA", "Microsoft", "WinGet", "Links"],
  ],
};

/** The characters `cmd` interprets, escaped with `^`. */
export const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * One argument of a `cmd /d /s /c` line, as `cmd` and then the `.cmd` script's program read it:
 * quoted and escaped twice (the shim passes it on), so that `&`, `|`, `%` or `"` never run anything.
 */
export function cmdArgument(argument: string): string {
  let quoted = argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1");
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/**
 * Starts a tool without a shell (its arguments are never interpreted), with `input` on its
 * standard input, and waits for it at most `CALL_TIMEOUT_MS` (`timedOut`). On Windows the tool is
 * found through `PATH` and `PATHEXT`; a `.cmd` or `.bat` shim runs through `cmd /d /s /c`, every
 * argument escaped. A tool that cannot be found or started is `missing`.
 */
export const runTool: ToolRunner = (command, args, options) =>
  new Promise((resolve) => {
    const env = toolEnv();
    const file = resolveCommand(command, env);
    if (file === undefined) {
      resolve({ status: null, stdout: "", stderr: `${command}: not found`, missing: true });
      return;
    }
    const shim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(file);
    let child: ReturnType<typeof spawn>;
    try {
      child = shim
        ? spawn(
            env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
            [
              "/d",
              "/s",
              "/c",
              `"${[file.replace(CMD_META, "^$1"), ...args.map(cmdArgument)].join(" ")}"`,
            ],
            { cwd: options.cwd, env, windowsHide: true, windowsVerbatimArguments: true },
          )
        : spawn(file, [...args], { cwd: options.cwd, env, windowsHide: true, shell: false });
    } catch {
      resolve({ status: null, stdout: "", stderr: "", missing: true });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, CALL_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: null,
        stdout: "",
        stderr: error.message,
        missing: error.code === "ENOENT",
      });
    });
    child.on("close", (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : status,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8").trim(),
        ...(timedOut ? { timedOut: true } : {}),
      });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });

export interface GitForgeOptions {
  /** The workspace root: the folder that holds `.agentplugged/`. */
  readonly cwd: string;
  readonly run?: GitRunner;
  /** Runs `gh` or `glab`; tests give a fake one. */
  readonly tool?: ToolRunner;
}

/** Branches never pushed by a story's delivery, whatever the caller says. */
const PROTECTED_BRANCHES = new Set(["main", "master", "HEAD"]);

/** A remote's name: letters, digits, dots, underscores and hyphens, never an option. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** A branch's name as the engine pushes and reads it: no option, no revision syntax. */
const SAFE_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** Refused by the remote itself (a hook, a protected branch): not a matter of fetching first. */
const REMOTE_REFUSED = /\[remote rejected\]|pre-receive hook declined|protected branch/i;
/** Not a fast-forward: fetch and rebase first. */
const PUSH_REJECTED = /\[rejected\]|non-fast-forward|fetch first|stale info/i;

/** The forge's tool stopped at its time limit: said as such. */
function timeoutError(tool: string, args: readonly string[]): Error {
  return new Error(
    `${tool} ${args.slice(0, 2).join(" ")}: timed out after ${CALL_TIMEOUT_MS / 1000} s`,
  );
}

/**
 * The Git and forge side of `story pr` and `open_pull_request`: reads the remotes
 * (the address Git really pushes to) and the story's branch, pushes that branch under its own name
 * (never forced, never the target or main branch), and runs `gh` or `glab` with fixed arguments,
 * the repository named, the text always on standard input (`gh … --body-file -`; on GitLab the
 * engine's own `glab api … --input -` call, `glab mr create` taking the text only as an argument).
 * Never reads, prints nor passes on the forge's token.
 */
export class GitForge implements StoryForge {
  readonly #cwd: string;
  readonly #run: GitRunner;
  readonly #tool: ToolRunner;

  constructor(options: GitForgeOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runGit;
    this.#tool = options.tool ?? runTool;
  }

  async #git(args: readonly string[]) {
    return this.#run(this.#cwd, args, undefined, { LC_ALL: "C" }, CALL_TIMEOUT_MS);
  }

  async #text(args: readonly string[]): Promise<string | undefined> {
    const run = await this.#git(args);
    return run.status === 0 ? run.stdout.toString("utf8").trim() : undefined;
  }

  async inspect(branch: string, base: string): Promise<ForgeInspection> {
    const prefix = await this.#text(["rev-parse", "--show-prefix"]);
    if (prefix === undefined) return { repository: false };
    const remotes = await this.#remotes();
    const head =
      (await this.#text(["rev-parse", "-q", "--verify", `refs/heads/${branch}^{commit}`])) ?? null;
    let commits: number | null = null;
    if (head !== null) {
      const meeting = await this.#text(["merge-base", base, head]);
      const count =
        meeting === undefined
          ? undefined
          : await this.#text(["rev-list", "--count", `${meeting}..${head}`]);
      if (count !== undefined && /^\d+$/.test(count)) commits = Number(count);
    }
    return { repository: true, prefix, remotes, head, commits };
  }

  async cli(repository: ForgeRepository): Promise<ForgeCliState> {
    const tool = forgeCli(repository.forge);
    const versionArgs = ["--version"];
    const version = await this.#tool(tool, versionArgs, { cwd: this.#cwd });
    if (version.timedOut === true) throw timeoutError(tool, versionArgs);
    if (version.missing === true || version.status !== 0) return "missing";
    const statusArgs = ["auth", "status", "--hostname", repository.host];
    const status = await this.#tool(tool, statusArgs, { cwd: this.#cwd });
    if (status.timedOut === true) throw timeoutError(tool, statusArgs);
    return status.status === 0 ? "ready" : "logged_out";
  }

  async push(remote: string, branch: string, base: string): Promise<BranchPushOutcome> {
    if (
      PROTECTED_BRANCHES.has(branch) ||
      branch === base ||
      branch.startsWith("-") ||
      remote.startsWith("-")
    ) {
      return { ok: false, reason: "push_failed", message: `refused to push ${branch}` };
    }
    const ref = `refs/heads/${branch}`;
    const run = await this.#git(["push", "--porcelain", remote, `${ref}:${ref}`]);
    if (run.status === 0) return { ok: true };
    const output = `${run.stdout.toString("utf8")}\n${run.stderr}`;
    const message = lastLine(run.stderr) || lastLine(output) || `git push exited (${run.status})`;
    if (!REMOTE_REFUSED.test(output) && PUSH_REJECTED.test(output)) {
      return { ok: false, reason: "push_rejected", message };
    }
    return { ok: false, reason: "push_failed", message };
  }

  async #call(
    repository: ForgeRepository,
    args: readonly string[],
    input?: string,
  ): Promise<string> {
    const tool = forgeCli(repository.forge);
    const run = await this.#tool(tool, args, {
      cwd: this.#cwd,
      ...(input === undefined ? {} : { input }),
    });
    if (run.timedOut === true) throw timeoutError(tool, args);
    if (run.status !== 0) {
      const why = lastLine(run.stderr) || lastLine(run.stdout) || `exited (${run.status})`;
      throw new Error(`${tool} ${args.slice(0, 2).join(" ")}: ${why}`);
    }
    return run.stdout;
  }

  /** The GitLab API path of the repository: `projects/<path, URL-encoded>`. */
  #project(repository: ForgeRepository): string {
    return `projects/${encodeURIComponent(repository.path)}`;
  }

  async pullRequests(repository: ForgeRepository, branch: string): Promise<ForgePullRequest[]> {
    if (repository.forge === "github") {
      const owner = (repository.path.split("/")[0] ?? "").toLowerCase();
      const text = await this.#call(repository, [
        "pr",
        "list",
        "--repo",
        `${repository.host}/${repository.path}`,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,url,state,title,body,headRepositoryOwner,isCrossRepository",
        "--limit",
        "50",
      ]);
      // A fork's branch of the same name is never the story's.
      return parseList(text, (entry) => {
        const login = (entry.headRepositoryOwner as { login?: unknown } | undefined)?.login;
        const own =
          entry.isCrossRepository !== true &&
          typeof login === "string" &&
          login.toLowerCase() === owner;
        return own
          ? {
              number: entry.number,
              url: entry.url,
              state: entry.state,
              title: entry.title,
              body: entry.body,
            }
          : undefined;
      });
    }
    const text = await this.#call(repository, [
      "mr",
      "list",
      "--repo",
      repositoryWebUrl(repository),
      "--source-branch",
      branch,
      "--all",
      "--output",
      "json",
    ]);
    return parseList(text, (entry) =>
      entry.source_project_id === entry.target_project_id
        ? {
            number: entry.iid,
            url: entry.web_url,
            state: entry.state,
            title: entry.title,
            body: entry.description ?? "",
          }
        : undefined,
    );
  }

  async create(
    repository: ForgeRepository,
    draft: PullRequestDraft,
  ): Promise<{ number: number; url: string }> {
    if (repository.forge === "github") {
      const text = await this.#call(
        repository,
        [
          "pr",
          "create",
          "--repo",
          `${repository.host}/${repository.path}`,
          "--base",
          draft.base,
          "--head",
          draft.branch,
          "--title",
          draft.title,
          "--body-file",
          "-",
        ],
        draft.body,
      );
      const created = createdPullRequest(text, repository);
      if (created === undefined) throw new Error("gh: no pull request address in its output");
      return created;
    }
    const text = await this.#call(
      repository,
      [
        "api",
        "--hostname",
        repository.host,
        "--method",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
        `${this.#project(repository)}/merge_requests`,
      ],
      JSON.stringify({
        source_branch: draft.branch,
        target_branch: draft.base,
        title: draft.title,
        description: draft.body,
      }),
    );
    const created = createdMergeRequest(text);
    if (created === undefined) throw new Error("glab: no merge request in its answer");
    return created;
  }

  async update(
    repository: ForgeRepository,
    number: number,
    draft: PullRequestDraft,
  ): Promise<void> {
    if (repository.forge === "github") {
      await this.#call(
        repository,
        [
          "pr",
          "edit",
          String(number),
          "--repo",
          `${repository.host}/${repository.path}`,
          "--title",
          draft.title,
          "--base",
          draft.base,
          "--body-file",
          "-",
        ],
        draft.body,
      );
      return;
    }
    await this.#call(
      repository,
      [
        "api",
        "--hostname",
        repository.host,
        "--method",
        "PUT",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
        `${this.#project(repository)}/merge_requests/${number}`,
      ],
      JSON.stringify({
        title: draft.title,
        description: draft.body,
        target_branch: draft.base,
      }),
    );
  }

  async retarget(repository: ForgeRepository, number: number, base: string): Promise<void> {
    if (!SAFE_BRANCH.test(base)) throw new Error("refused to retarget to that branch");
    if (repository.forge === "github") {
      await this.#call(repository, [
        "pr",
        "edit",
        String(number),
        "--repo",
        `${repository.host}/${repository.path}`,
        "--base",
        base,
      ]);
      return;
    }
    await this.#call(
      repository,
      [
        "api",
        "--hostname",
        repository.host,
        "--method",
        "PUT",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
        `${this.#project(repository)}/merge_requests/${number}`,
      ],
      JSON.stringify({ target_branch: base }),
    );
  }

  async branchProtection(
    repository: ForgeRepository,
    branch: string,
  ): Promise<"protected" | "open" | "unknown"> {
    if (!SAFE_BRANCH.test(branch)) return "unknown";
    const tool = forgeCli(repository.forge);
    const args =
      repository.forge === "github"
        ? [
            "api",
            "--hostname",
            repository.host,
            `repos/${repository.path}/branches/${branch}/protection`,
          ]
        : [
            "api",
            "--hostname",
            repository.host,
            `${this.#project(repository)}/protected_branches/${encodeURIComponent(branch)}`,
          ];
    const run = await this.#tool(tool, args, { cwd: this.#cwd });
    if (run.timedOut === true || run.missing === true) return "unknown";
    if (run.status === 0) return "protected";
    // The forge answers "not found" for a branch without protection, and "forbidden" when the
    // account may not read it: only the first is an answer.
    return /404|not found|not protected/i.test(`${run.stderr}\n${run.stdout}`) ? "open" : "unknown";
  }

  /**
   * Posts a review. GitHub: one review, `event: COMMENT`, on the commit reviewed, a
   * comment per finding on its line of the new side (`gh api … pulls/<n>/reviews --input -`).
   * GitLab: one discussion per finding, positioned on the merge request's diff (`glab api`, the
   * merge request's `diff_refs`), then the review's text as a note; every finding in the note when
   * the merge request moved on since the commit reviewed.
   */
  async postReview(
    repository: ForgeRepository,
    number: number,
    review: ForgeReviewDraft,
  ): Promise<void> {
    if (repository.forge === "github") {
      await this.#call(
        repository,
        [
          "api",
          "--hostname",
          repository.host,
          "--method",
          "POST",
          "--header",
          "Accept: application/vnd.github+json",
          "--input",
          "-",
          `repos/${repository.path}/pulls/${number}/reviews`,
        ],
        JSON.stringify({
          commit_id: review.commit,
          event: "COMMENT",
          body: review.body,
          comments: review.comments.map((comment) => ({
            path: comment.path,
            line: comment.line,
            side: "RIGHT",
            body: comment.body,
          })),
        }),
      );
      return;
    }
    const mergeRequest = `${this.#project(repository)}/merge_requests/${number}`;
    let refs: { base_sha: string; start_sha: string; head_sha: string } | undefined;
    if (review.comments.length > 0) {
      refs = diffRefs(
        await this.#call(repository, ["api", "--hostname", repository.host, mergeRequest]),
      );
      if (refs === undefined) throw new Error("glab: no diff_refs in the merge request");
    }
    // The merge request moved on since the commit reviewed: its lines would not match, so every
    // finding goes in the note.
    if (refs !== undefined && refs.head_sha !== review.commit) {
      const lines = review.comments.map(
        (comment) => `- \`${comment.path}:${comment.line}\`: ${comment.body.replace(/\n+/g, " ")}`,
      );
      await this.#gitlab(repository, "POST", `${mergeRequest}/notes`, {
        body: `${review.body}\n\n${lines.join("\n")}`,
      });
      return;
    }
    for (const comment of review.comments) {
      if (refs === undefined) break;
      await this.#gitlab(repository, "POST", `${mergeRequest}/discussions`, {
        body: comment.body,
        position: {
          position_type: "text",
          base_sha: refs.base_sha,
          start_sha: refs.start_sha,
          head_sha: refs.head_sha,
          old_path: comment.old_path,
          new_path: comment.path,
          new_line: comment.line,
          ...(comment.old_line === null ? {} : { old_line: comment.old_line }),
        },
      });
    }
    await this.#gitlab(repository, "POST", `${mergeRequest}/notes`, { body: review.body });
  }

  /** Posts a comment (a deviation): `gh pr comment --body-file -`, a GitLab note. */
  async comment(repository: ForgeRepository, number: number, body: string): Promise<void> {
    if (repository.forge === "github") {
      await this.#call(
        repository,
        [
          "pr",
          "comment",
          String(number),
          "--repo",
          `${repository.host}/${repository.path}`,
          "--body-file",
          "-",
        ],
        body,
      );
      return;
    }
    await this.#gitlab(
      repository,
      "POST",
      `${this.#project(repository)}/merge_requests/${number}/notes`,
      { body },
    );
  }

  /**
   * The diff of a pull request: GitHub `gh pr diff <n> --repo <host>/<path>`; GitLab
   * `glab api …/merge_requests/<n>/raw_diffs`. Read only; the number is a number, never an option.
   */
  async pullRequestDiff(repository: ForgeRepository, number: number): Promise<string> {
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("not a pull request number");
    if (repository.forge === "github") {
      return await this.#call(repository, [
        "pr",
        "diff",
        String(number),
        "--repo",
        `${repository.host}/${repository.path}`,
        "--color",
        "never",
      ]);
    }
    return await this.#call(repository, [
      "api",
      "--hostname",
      repository.host,
      `${this.#project(repository)}/merge_requests/${number}/raw_diffs`,
    ]);
  }

  /**
   * One pull request as the forge holds it now: GitHub `gh api repos/<path>/pulls/<n>`
   * (`state`, `merged`, `head.sha`, `merge_commit_sha`); GitLab `glab api …/merge_requests/<n>`
   * (`state`, `sha`, `merge_commit_sha` or `squash_commit_sha`).
   */
  async pullRequest(repository: ForgeRepository, number: number): Promise<ForgePullRequestState> {
    const path =
      repository.forge === "github"
        ? `repos/${repository.path}/pulls/${number}`
        : `${this.#project(repository)}/merge_requests/${number}`;
    const text = await this.#call(repository, ["api", "--hostname", repository.host, path]);
    const data = parseObject(text);
    if (repository.forge === "github") {
      const head = (data.head as { sha?: unknown } | undefined)?.sha;
      return {
        state: data.merged === true ? "merged" : data.state === "open" ? "open" : "closed",
        head: commitOf(head),
        merge_commit: data.merged === true ? commitOf(data.merge_commit_sha) : null,
        base: branchOf((data.base as { ref?: unknown } | undefined)?.ref),
        merged_by:
          data.merged === true
            ? accountOf((data.merged_by as { login?: unknown } | null | undefined)?.login)
            : null,
        merged_at: data.merged === true ? isoOf(data.merged_at) : null,
      };
    }
    // `locked`: GitLab is merging it right now; still open until it says merged.
    const state =
      data.state === "merged"
        ? "merged"
        : data.state === "opened" || data.state === "locked"
          ? "open"
          : "closed";
    return {
      state,
      head: commitOf(data.sha),
      merge_commit:
        state === "merged"
          ? (commitOf(data.merge_commit_sha) ?? commitOf(data.squash_commit_sha))
          : null,
      base: branchOf(data.target_branch),
      merged_by:
        state === "merged"
          ? accountOf(
              (data.merged_by as { username?: unknown } | null | undefined)?.username ??
                (data.merge_user as { username?: unknown } | null | undefined)?.username,
            )
          : null,
      merged_at: state === "merged" ? isoOf(data.merged_at) : null,
    };
  }

  /**
   * Merges a pull request on the commit given only, never deleting its branch nor
   * bypassing the forge's protections. GitHub: `gh api --method PUT repos/<path>/pulls/<n>/merge`
   * (`sha`, `merge_method`); GitLab: `glab api --method PUT …/merge_requests/<n>/merge` (`sha`,
   * `squash`, `should_remove_source_branch: false`, `merge_when_pipeline_succeeds: false`; the
   * project's own merge method applies, rebase included). A refusal of the forge is an outcome:
   * HTTP 409 (another head) `head_moved`, 405, 406 or 422 `not_mergeable`, any other `failed`.
   */
  async merge(
    repository: ForgeRepository,
    number: number,
    request: ForgeMergeRequest,
  ): Promise<ForgeMergeOutcome> {
    const github = repository.forge === "github";
    const path = github
      ? `repos/${repository.path}/pulls/${number}/merge`
      : `${this.#project(repository)}/merge_requests/${number}/merge`;
    const body = github
      ? { sha: request.commit, merge_method: request.method }
      : {
          sha: request.commit,
          squash: request.method === "squash",
          should_remove_source_branch: false,
          merge_when_pipeline_succeeds: false,
        };
    const tool = forgeCli(repository.forge);
    const args = [
      "api",
      "--hostname",
      repository.host,
      "--method",
      "PUT",
      "--header",
      "Content-Type: application/json",
      "--input",
      "-",
      path,
    ];
    const run = await this.#tool(tool, args, { cwd: this.#cwd, input: JSON.stringify(body) });
    if (run.timedOut === true) throw timeoutError(tool, args);
    if (run.missing === true) throw new Error(`${tool}: not installed`);
    if (run.status !== 0) {
      const message = lastLine(run.stderr) || lastLine(run.stdout) || `exited (${run.status})`;
      const status = /HTTP (\d{3})/.exec(`${run.stderr}\n${run.stdout}`)?.[1];
      const reason =
        status === "409"
          ? "head_moved"
          : status === "405" || status === "406" || status === "422"
            ? "not_mergeable"
            : "failed";
      return { ok: false, reason, message };
    }
    let data: Record<string, unknown>;
    try {
      data = parseObject(run.stdout);
    } catch {
      return { ok: false, reason: "failed", message: `${tool}: no JSON in its answer` };
    }
    if (github) {
      return data.merged === true
        ? { ok: true, merge_commit: commitOf(data.sha) }
        : { ok: false, reason: "not_mergeable", message: String(data.message ?? "not merged") };
    }
    if (data.state === "locked") {
      // GitLab merges it in the background: answering again records it once merged.
      return { ok: false, reason: "failed", message: "GitLab is merging it now: answer again" };
    }
    if (data.state !== "merged") {
      return {
        ok: false,
        reason: "not_mergeable",
        message: `the merge request is ${String(data.state ?? "not merged")}`,
      };
    }
    return {
      ok: true,
      merge_commit: commitOf(data.merge_commit_sha) ?? commitOf(data.squash_commit_sha),
    };
  }

  /** The remotes, each with the address Git pushes to (`pushurl`, `insteadOf` applied). */
  async #remotes(): Promise<ForgeRemote[]> {
    const remotes: ForgeRemote[] = [];
    for (const name of ((await this.#text(["remote"])) ?? "").split(/\r?\n/)) {
      if (name.trim() === "") continue;
      const url = await this.#text(["remote", "get-url", "--push", name.trim()]);
      if (url !== undefined) remotes.push({ name: name.trim(), url });
    }
    return remotes;
  }

  /**
   * The main branch as Git holds it here: the local `main`, else `master`, that has a
   * commit, with the workspace's place and the remotes. Reads only.
   */
  async inspectMain(): Promise<MainInspection> {
    const prefix = await this.#text(["rev-parse", "--show-prefix"]);
    if (prefix === undefined) return { repository: false };
    const remotes = await this.#remotes();
    for (const name of ["main", "master"]) {
      const head = await this.#text(["rev-parse", "-q", "--verify", `refs/heads/${name}^{commit}`]);
      if (head !== undefined && /^[0-9a-f]{40,64}$/.test(head)) {
        return { repository: true, prefix, remotes, branch: name, head };
      }
    }
    return { repository: true, prefix, remotes, branch: null, head: null };
  }

  /**
   * Where a remote's branch stands against a local commit: `git ls-remote` asks the
   * remote; when it holds a commit this repository lacks, `git fetch` brings it (the objects only:
   * no branch and no working tree move); then the ancestry says `behind` (a fast-forward),
   * `ahead` or `diverged`. A remote that cannot be reached or read is `unreadable`.
   */
  async remoteBranch(remote: string, branch: string, commit: string): Promise<RemoteBranchState> {
    if (!SAFE_NAME.test(remote) || !SAFE_BRANCH.test(branch) || !COMMIT_ID.test(commit)) {
      return { state: "unreadable", message: "refused to read that remote branch" };
    }
    const ref = `refs/heads/${branch}`;
    const listed = await this.#git(["ls-remote", "--heads", remote, ref]);
    if (listed.status !== 0) {
      return { state: "unreadable", message: lastLine(listed.stderr) || "git ls-remote failed" };
    }
    const line = listed.stdout
      .toString("utf8")
      .split(/\r?\n/)
      .find((entry) => entry.endsWith(`\t${ref}`));
    if (line === undefined) return { state: "missing" };
    const head = (line.split("\t")[0] ?? "").trim();
    if (!COMMIT_ID.test(head))
      return { state: "unreadable", message: "the remote answered no commit" };
    if (head === commit) return { state: "same", head };
    const held = async () => (await this.#git(["cat-file", "-e", `${head}^{commit}`])).status === 0;
    if (!(await held())) {
      const fetched = await this.#git(["fetch", "--no-tags", "--quiet", "--refmap=", remote, ref]);
      if (fetched.status !== 0 || !(await held())) {
        return {
          state: "unreadable",
          message: lastLine(fetched.stderr) || "the remote's commits could not be read",
        };
      }
    }
    const ancestor = async (older: string, newer: string) =>
      (await this.#git(["merge-base", "--is-ancestor", older, newer])).status === 0;
    if (await ancestor(head, commit)) return { state: "behind", head };
    if (await ancestor(commit, head)) return { state: "ahead", head };
    return { state: "diverged", head };
  }

  /**
   * Pushes a commit to the remote as its branch: `git push --porcelain <remote>
   * <commit>:refs/heads/<branch>`, with no force option, never prompting. A remote or a branch
   * that starts with `-`, or any name with a character Git would read as an option, is refused.
   * Then the branch follows `<remote>/<branch>` (best effort).
   */
  async pushMain(remote: string, branch: string, commit: string): Promise<BranchPushOutcome> {
    if (
      !SAFE_NAME.test(remote) ||
      !SAFE_BRANCH.test(branch) ||
      branch === "HEAD" ||
      !COMMIT_ID.test(commit)
    ) {
      return { ok: false, reason: "push_failed", message: `refused to push ${branch}` };
    }
    const run = await this.#git(["push", "--porcelain", remote, `${commit}:refs/heads/${branch}`]);
    if (run.status !== 0) {
      const output = `${run.stdout.toString("utf8")}\n${run.stderr}`;
      const message = lastLine(run.stderr) || lastLine(output) || `git push exited (${run.status})`;
      if (!REMOTE_REFUSED.test(output) && PUSH_REJECTED.test(output)) {
        return { ok: false, reason: "push_rejected", message };
      }
      return { ok: false, reason: "push_failed", message };
    }
    await this.#git(["branch", "--set-upstream-to", `${remote}/${branch}`, branch]);
    return { ok: true };
  }

  /**
   * Creates a repository on the forge with its tool and adds it as the remote `origin` (story
   * 3.20), private unless a public one is asked for; pushes nothing. GitHub: `gh repo create
   * [owner/]name --private|--public --source=. --remote=origin`. GitLab: the API (`glab api POST
   * projects`, the group's id read first when an owner is given), then `git remote add origin`.
   * A name already taken is `exists`; any other refusal is `failed`, with the tool's line.
   */
  async createRepository(request: RepositoryRequest): Promise<RepositoryCreation> {
    const tool = forgeCli(request.forge);
    const taken = /already exists|name already|has already been taken|already taken/i;
    const fail = (run: ToolRun): RepositoryCreation => ({
      ok: false,
      reason: taken.test(`${run.stderr}\n${run.stdout}`) ? "exists" : "failed",
      message: lastLine(run.stderr) || lastLine(run.stdout) || `${tool} exited (${run.status})`,
    });
    if (request.forge === "github") {
      const path = request.owner === undefined ? request.name : `${request.owner}/${request.name}`;
      const args = [
        "repo",
        "create",
        path,
        request.visibility === "public" ? "--public" : "--private",
        "--source=.",
        `--remote=${request.remote ?? "origin"}`,
      ];
      const run = await this.#tool(tool, args, { cwd: this.#cwd });
      if (run.timedOut === true) throw timeoutError(tool, args);
      if (run.missing === true) throw new Error(`${tool}: not installed`);
      if (run.status !== 0) return fail(run);
    } else {
      let namespace: number | undefined;
      if (request.owner !== undefined) {
        const groupArgs = [
          "api",
          "--hostname",
          request.host,
          `groups/${encodeURIComponent(request.owner)}`,
        ];
        const group = await this.#tool(tool, groupArgs, { cwd: this.#cwd });
        if (group.timedOut === true) throw timeoutError(tool, groupArgs);
        if (group.missing === true) throw new Error(`${tool}: not installed`);
        if (group.status !== 0) return fail(group);
        const id = (parseObject(group.stdout) as { id?: unknown }).id;
        if (typeof id !== "number") {
          return { ok: false, reason: "failed", message: "glab: no group id in its answer" };
        }
        namespace = id;
      }
      const args = [
        "api",
        "--hostname",
        request.host,
        "--method",
        "POST",
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
        "projects",
      ];
      const run = await this.#tool(tool, args, {
        cwd: this.#cwd,
        input: JSON.stringify({
          name: request.name,
          path: request.name,
          visibility: request.visibility,
          ...(namespace === undefined ? {} : { namespace_id: namespace }),
        }),
      });
      if (run.timedOut === true) throw timeoutError(tool, args);
      if (run.missing === true) throw new Error(`${tool}: not installed`);
      if (run.status !== 0) return fail(run);
      const url = (parseObject(run.stdout) as { http_url_to_repo?: unknown }).http_url_to_repo;
      if (typeof url !== "string" || !/^https:\/\//.test(url)) {
        return {
          ok: false,
          reason: "failed",
          message: "glab: no repository address in its answer",
        };
      }
      const added = await this.#git(["remote", "add", request.remote ?? "origin", url]);
      if (added.status !== 0) {
        return {
          ok: false,
          reason: "failed",
          message: lastLine(added.stderr) || "git remote add failed",
        };
      }
    }
    const name = request.remote ?? "origin";
    const added = (await this.#remotes()).find((remote) => remote.name === name);
    return added === undefined
      ? {
          ok: false,
          reason: "failed",
          message: `the repository was created but ${name} is not set`,
        }
      : { ok: true, remote: added };
  }

  /** One call of the GitLab API by the engine, the JSON on standard input. */
  async #gitlab(
    repository: ForgeRepository,
    method: "POST" | "PUT",
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<string> {
    return this.#call(
      repository,
      [
        "api",
        "--hostname",
        repository.host,
        "--method",
        method,
        "--header",
        "Content-Type: application/json",
        "--input",
        "-",
        path,
      ],
      JSON.stringify(body),
    );
  }
}

/** A JSON object the tool printed; throws when it printed none. */
function parseObject(text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("the forge's tool printed no JSON object");
  }
  return data as Record<string, unknown>;
}

/** A commit id (40 or 64 lowercase hexadecimal characters), or null. */
function commitOf(value: unknown): string | null {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value) ? value : null;
}

/** An account name the forge gave (a login: letters, digits, `.`, `_`, `-`), or null. */
function accountOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value)
    ? value
    : null;
}

/** A date the forge gave, as an ISO date (UTC), or null. */
function isoOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A branch name the forge gave (never an option, never an odd character), or null. */
function branchOf(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value)
    ? value
    : null;
}

/** The `diff_refs` of a GitLab merge request, as its API answered. */
function diffRefs(
  text: string,
): { base_sha: string; start_sha: string; head_sha: string } | undefined {
  try {
    const refs = (JSON.parse(text) as { diff_refs?: Record<string, unknown> }).diff_refs;
    const { base_sha, start_sha, head_sha } = refs ?? {};
    if (
      typeof base_sha === "string" &&
      typeof start_sha === "string" &&
      typeof head_sha === "string"
    ) {
      return { base_sha, start_sha, head_sha };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** A JSON list of pull requests, as the tool printed it; entries of another shape are skipped. */
function parseList(
  text: string,
  read: (
    entry: Record<string, unknown>,
  ) => { number: unknown; url: unknown; state: unknown; title: unknown; body: unknown } | undefined,
): ForgePullRequest[] {
  let data: unknown;
  try {
    data = JSON.parse(text.trim() === "" ? "[]" : text);
  } catch {
    throw new Error("the forge's tool printed no JSON list");
  }
  if (!Array.isArray(data)) throw new Error("the forge's tool printed no JSON list");
  const result: ForgePullRequest[] = [];
  for (const raw of data) {
    if (raw === null || typeof raw !== "object") continue;
    const entry = read(raw as Record<string, unknown>);
    if (entry === undefined) continue;
    const { number, url, state } = entry;
    if (typeof number !== "number" || !Number.isInteger(number) || number < 1) continue;
    if (typeof url !== "string" || typeof state !== "string") continue;
    const lower = state.toLowerCase();
    result.push({
      number,
      url,
      state:
        lower === "merged" ? "merged" : lower === "open" || lower === "opened" ? "open" : "closed",
      title: typeof entry.title === "string" ? entry.title : "",
      body: typeof entry.body === "string" ? entry.body : "",
    });
  }
  return result;
}

/** The address and number of the pull request `gh pr create` just printed. */
export function createdPullRequest(
  text: string,
  repository: ForgeRepository,
): { number: number; url: string } | undefined {
  const pattern =
    repository.forge === "github"
      ? /(https?:\/\/[^\s@]+\/pull\/(\d+))/
      : /(https?:\/\/[^\s@]+\/-\/merge_requests\/(\d+))/;
  const lines = text.split(/\r?\n/).reverse();
  for (const line of lines) {
    const match = pattern.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return { url: match[1], number: Number(match[2]) };
    }
  }
  return undefined;
}

/** The merge request the GitLab API answered with (`iid`, `web_url`). */
function createdMergeRequest(text: string): { number: number; url: string } | undefined {
  try {
    const data = JSON.parse(text) as { iid?: unknown; web_url?: unknown };
    if (
      typeof data.iid === "number" &&
      Number.isInteger(data.iid) &&
      typeof data.web_url === "string"
    ) {
      return { number: data.iid, url: data.web_url };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
