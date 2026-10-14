import { spawn } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, join, resolve } from "node:path";
import {
  CI_CONFIG_PATHS,
  type CiCheck,
  type CiReader,
  type CiReading,
  type CiRepository,
  GITHUB_WORKFLOWS_DIR,
  isWorkflowFile,
} from "@agentplugged/core";
import type { CiForge } from "@agentplugged/protocol";
import type { GitRunner } from "./git-docs-base.js";
import { resolveCommand, type ToolRun } from "./git-forge.js";
import { gitEnv, runGit } from "./git-process.js";

/** Longest one call to the forge's tool may take. */
export const CI_TOOL_TIMEOUT_MS = 60_000;

/** What a forge tool printed, or that it could not start (`missing`) or was too slow. */
export type CiToolRun = ToolRun;

/** Runs the forge's command-line tool (`gh`, `glab`) in a folder: injected by tests. */
export type CiToolRunner = (
  tool: string,
  args: readonly string[],
  cwd: string,
) => Promise<CiToolRun>;

export interface CiToolRunnerOptions {
  /** The environment: `PATH` (and `PATHEXT` on Windows) find the tool. */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: string;
  readonly timeoutMs?: number;
}

/** The value of `name` in `env`, whatever its case (Windows names `Path`). */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * The tool's file on the `PATH`: as is elsewhere, with each extension of `PATHEXT` on Windows
 * (`gh.exe`, `glab.cmd`). Undefined when none is found.
 */
export async function resolveCiTool(
  tool: string,
  env: NodeJS.ProcessEnv,
  platform: string,
): Promise<string | undefined> {
  const windows = platform === "win32";
  const extensions = windows
    ? (variable(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => ext !== "")
    : [""];
  const folders = (variable(env, "PATH") ?? "").split(windows ? ";" : delimiter);
  for (const folder of folders) {
    if (folder.trim() === "") continue;
    for (const ext of extensions) {
      const candidate = join(folder, `${tool}${ext.toLowerCase()}`);
      const found = await stat(candidate).catch(() => undefined);
      if (found?.isFile() === true) return candidate;
    }
  }
  // Not on the `PATH` (a tool installed after the editor opened): the installer's own folder.
  return windows ? resolveCommand(tool, env, platform) : undefined;
}

/** An argument for `cmd.exe /s /c "…"`: quoted, its quotes doubled. */
function cmdArgument(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * A runner of the forge's tool, without a prompt: found on the `PATH` (a `.cmd` or `.bat` on
 * Windows goes through `cmd.exe`), `missing` when it cannot be found, killed after its time limit
 * (`timedOut`).
 */
export function createCiToolRunner(options: CiToolRunnerOptions = {}): CiToolRunner {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? CI_TOOL_TIMEOUT_MS;
  return async (tool, args, cwd) => {
    const base = options.env ?? process.env;
    const file = await resolveCiTool(tool, base, platform);
    if (file === undefined) {
      return { status: null, stdout: "", stderr: `${tool}: not found`, missing: true };
    }
    const env = {
      ...(options.env === undefined ? gitEnv() : base),
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
      GLAB_NO_PROMPT: "1",
      NO_PROMPT: "1",
      NO_COLOR: "1",
    };
    const script = platform === "win32" && /^\.(?:cmd|bat)$/i.test(extname(file));
    const command = script ? (variable(base, "COMSPEC") ?? "cmd.exe") : file;
    const argv = script
      ? ["/d", "/s", "/c", `"${[file, ...args].map(cmdArgument).join(" ")}"`]
      : [...args];
    return new Promise((done) => {
      const child = spawn(command, argv, {
        cwd,
        env,
        windowsHide: true,
        windowsVerbatimArguments: script,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        done({ status: null, stdout: "", stderr: error.message, missing: error.code === "ENOENT" });
      });
      child.on("close", (status) => {
        clearTimeout(timer);
        done({
          status: timedOut ? null : status,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8").trim(),
          ...(timedOut ? { timedOut: true } : {}),
        });
      });
      child.stdin.end();
    });
  };
}

/** The runner of the CLI and the MCP server: this process's `PATH`, a minute per call. */
export const runCiTool: CiToolRunner = createCiToolRunner();

export interface ForgeCiReaderOptions {
  /** The workspace root: the folder that holds `.agentplugged/`. */
  readonly cwd: string;
  readonly run?: CiToolRunner;
  readonly git?: GitRunner;
}

/**
 * The forge of a remote's address, by its exact host: `github.com` or a host starting with
 * `github.`, `gitlab.com` or a host starting with `gitlab.`; else null (force it with `--forge` or
 * `ci.forge` in `method.yaml`).
 */
export function forgeOfRemote(url: string): CiForge | null {
  const host = (
    /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url)?.[1] ??
    /^(?:[^@/]+@)?([^/:]+):/.exec(url)?.[1] ??
    ""
  ).toLowerCase();
  if (host === "github.com" || host.startsWith("github.")) return "github";
  if (host === "gitlab.com" || host.startsWith("gitlab.")) return "gitlab";
  return null;
}

/** The first line of a tool's error, at most 300 characters. */
function firstLine(text: string): string {
  return (text.split(/\r?\n/).find((line) => line.trim() !== "") ?? "").trim().slice(0, 300);
}

const NOT_AUTHENTICATED =
  /auth(?:enticat\w*)? login|not logged in|authentication (?:required|failed)|\b401\b|unauthori[sz]ed|no token|bad credentials/i;
const NO_PULL_REQUEST =
  /no (?:open )?pull requests? found|no merge requests? (?:found|available)|merge request not found/i;
const NO_ACCESS =
  /\b40[34]\b|could not resolve to a repository|repository not found|project not found|not found: repository|forbidden|permission|resource not accessible/i;
const NO_CHECKS =
  /no checks reported|no pipelines? (?:found|running)|could not find any pipelines?/i;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/** A GitHub check's `bucket` (`gh pr checks --json bucket`). */
function githubState(bucket: unknown): CiCheck["state"] {
  if (bucket === "pass" || bucket === "skipping") return "pass";
  if (bucket === "fail" || bucket === "cancel") return "fail";
  return "pending";
}

/**
 * A GitLab job's `status`: a failed job allowed to fail passes; a manual job passes only when it
 * may be skipped (`allow_failure`), else it is still to run (`pending`).
 */
function gitlabState(status: unknown, allowFailure: unknown): CiCheck["state"] {
  if (status === "success" || status === "skipped") return "pass";
  if (status === "manual") return allowFailure === true ? "pass" : "pending";
  if (status === "failed") return allowFailure === true ? "pass" : "fail";
  if (status === "canceled" || status === "cancelled") return "fail";
  return "pending";
}

/** The CI files at a folder (the repository's top): workflows directly in their folder. */
async function ciFilesAt(top: string): Promise<string[]> {
  const found: string[] = [];
  const workflows = await readdir(join(top, GITHUB_WORKFLOWS_DIR), { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of workflows.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = `${GITHUB_WORKFLOWS_DIR}/${entry.name}`;
    if (entry.isFile() && isWorkflowFile(path)) found.push(path);
  }
  for (const path of CI_CONFIG_PATHS) {
    // A file where a folder is expected (ENOTDIR), or nothing at all: absent.
    if ((await stat(join(top, path)).catch(() => undefined)) !== undefined) found.push(path);
  }
  return found;
}

/**
 * The CI of a story's pull request, through the forge's command-line tool the creator signed in
 *: `gh pr view` and `gh pr checks` on GitHub, `glab mr view` and `glab ci get` on
 * GitLab, each with JSON output. Only an open pull request of this repository counts. Reads only:
 * never a token, never `gh api`, never a write. The forge comes from the `origin` remote's host.
 */
export class ForgeCiReader implements CiReader {
  readonly #cwd: string;
  readonly #run: CiToolRunner;
  readonly #git: GitRunner;

  constructor(options: ForgeCiReaderOptions) {
    this.#cwd = options.cwd;
    this.#run = options.run ?? runCiTool;
    this.#git = options.git ?? runGit;
  }

  async #gitText(args: readonly string[]): Promise<string | undefined> {
    const run = await this.#git(this.#cwd, args, undefined, { LC_ALL: "C" }, CI_TOOL_TIMEOUT_MS);
    return run.status === 0 ? run.stdout.toString("utf8").trim() : undefined;
  }

  async repository(): Promise<CiRepository | null> {
    const inside = await this.#gitText(["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return null;
    const prefix = (await this.#gitText(["rev-parse", "--show-prefix"])) ?? "";
    const top = await this.#gitText(["rev-parse", "--show-toplevel"]);
    const remote = await this.#gitText(["remote", "get-url", "origin"]);
    const head = await this.#gitText(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    let main: string | null = head?.replace(/^refs\/remotes\/origin\//, "") || null;
    for (const name of ["main", "master"]) {
      if (main !== null) break;
      const found = await this.#gitText(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
      if (found !== undefined && found !== "") main = name;
    }
    const root =
      top === undefined || top === "" ? undefined : isAbsolute(top) ? top : resolve(this.#cwd, top);
    return {
      forge: remote === undefined ? null : forgeOfRemote(remote),
      prefix,
      main,
      ci: root === undefined ? [] : await ciFilesAt(root),
    };
  }

  read(branch: string, forge: CiForge): Promise<CiReading> {
    return forge === "github" ? this.#github(branch) : this.#gitlab(branch);
  }

  /** A failed run of `tool`, as a reading. */
  #failure(tool: string, run: CiToolRun, noPullRequest: boolean): CiReading {
    if (run.missing === true) return { ok: false, reason: "forge_cli_missing", tool };
    if (run.timedOut === true) return { ok: false, reason: "forge_timeout", tool };
    const text = `${run.stderr}\n${run.stdout}`;
    const detail = firstLine(run.stderr) || `exited (${String(run.status)})`;
    if (NOT_AUTHENTICATED.test(text)) return { ok: false, reason: "not_authenticated", tool };
    if (noPullRequest && NO_PULL_REQUEST.test(text)) {
      return { ok: false, reason: "no_pull_request", tool };
    }
    if (NO_ACCESS.test(text)) return { ok: false, reason: "forge_access", tool, detail };
    return { ok: false, reason: "forge_failed", tool, detail };
  }

  async #github(branch: string): Promise<CiReading> {
    const tool = "gh";
    const view = await this.#run(
      tool,
      ["pr", "view", branch, "--json", "number,url,headRefOid,state,isCrossRepository,mergeable"],
      this.#cwd,
    );
    const pr = view.status === 0 ? record(parseJson(view.stdout)) : undefined;
    if (pr === undefined) return this.#failure(tool, view, true);
    // Only an open pull request from this repository's own branch is the story's.
    if (pr.state !== "OPEN" || pr.isCrossRepository === true) {
      return { ok: false, reason: "no_pull_request", tool };
    }
    const number = typeof pr.number === "number" ? pr.number : undefined;
    const target = number === undefined ? branch : String(number);
    // `gh pr checks` exits 1 when a check failed and 8 when one is pending: its JSON still holds.
    const run = await this.#run(
      tool,
      ["pr", "checks", target, "--json", "name,bucket,link"],
      this.#cwd,
    );
    const listed = parseJson(run.stdout);
    let checks: CiCheck[];
    if (Array.isArray(listed)) {
      checks = listed.flatMap((entry) => {
        const check = record(entry);
        if (check === undefined) return [];
        return [{ name: String(check.name ?? ""), state: githubState(check.bucket) }];
      });
    } else if (run.timedOut !== true && NO_CHECKS.test(`${run.stderr}\n${run.stdout}`)) {
      checks = [];
    } else {
      return this.#failure(tool, run, false);
    }
    return {
      ok: true,
      checks,
      ...(number === undefined ? {} : { pr: number }),
      ...(typeof pr.url === "string" ? { url: pr.url } : {}),
      ...(typeof pr.headRefOid === "string" ? { commit: pr.headRefOid } : {}),
      ...(pr.mergeable === "CONFLICTING" ? { conflicting: true as const } : {}),
    };
  }

  async #gitlab(branch: string): Promise<CiReading> {
    const tool = "glab";
    const view = await this.#run(tool, ["mr", "view", branch, "-F", "json"], this.#cwd);
    const mr = view.status === 0 ? record(parseJson(view.stdout)) : undefined;
    if (mr === undefined) return this.#failure(tool, view, true);
    // Only an open merge request from this project's own branch is the story's.
    const sameProject =
      mr.source_project_id === undefined || mr.source_project_id === mr.target_project_id;
    if (mr.state !== "opened" || !sameProject) {
      return { ok: false, reason: "no_pull_request", tool };
    }
    // The merge request's own pipeline (`head_pipeline`), else the branch's last one.
    const headPipeline = record(mr.head_pipeline);
    const pipelineId = typeof headPipeline?.id === "number" ? headPipeline.id : undefined;
    const run = await this.#run(
      tool,
      pipelineId === undefined
        ? ["ci", "get", "-b", branch, "-F", "json"]
        : ["ci", "get", "-p", String(pipelineId), "-F", "json"],
      this.#cwd,
    );
    const pipeline = run.status === 0 ? record(parseJson(run.stdout)) : undefined;
    let checks: CiCheck[];
    let commit: unknown = headPipeline?.sha ?? mr.sha;
    if (pipeline !== undefined) {
      commit = pipeline.sha ?? commit;
      const jobs = Array.isArray(pipeline.jobs) ? pipeline.jobs : undefined;
      checks =
        jobs === undefined
          ? [{ name: "pipeline", state: gitlabState(pipeline.status, false) }]
          : jobs.flatMap((entry) => {
              const job = record(entry);
              if (job === undefined) return [];
              return [
                { name: String(job.name ?? ""), state: gitlabState(job.status, job.allow_failure) },
              ];
            });
    } else if (run.timedOut !== true && NO_CHECKS.test(`${run.stderr}\n${run.stdout}`)) {
      checks = [];
    } else {
      return this.#failure(tool, run, false);
    }
    const iid = typeof mr.iid === "number" ? mr.iid : undefined;
    return {
      ok: true,
      checks,
      ...(iid === undefined ? {} : { pr: iid }),
      ...(typeof mr.web_url === "string" ? { url: mr.web_url } : {}),
      ...(typeof commit === "string" ? { commit } : {}),
      ...(mr.has_conflicts === true ? { conflicting: true as const } : {}),
    };
  }
}
