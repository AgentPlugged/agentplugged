import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { EvalAgent, EvalAgentOutcome, EvalAgentRequest, EvalFile } from "@agentplugged/core";
import { NodeToolProbe } from "./node-tool-probe.js";

/**
 * Claude Code as the agent of the behaviour evaluations: one non-interactive run in
 * a clean folder under the system's temporary folder, the request written on its standard input
 * (no text of a case ever reaches a command line), the transcript read from its standard output,
 * the folder removed afterwards.
 *
 * What a run is given: the folder, the skills staged in it, and a short list of the environment (no
 * variable of the creator's shell beyond the ones the tool needs to start and to authenticate).
 * What it can do: read, search, write files in its folder and call a skill. No shell, no network
 * tool, no MCP server (`--strict-mcp-config` with none), no setting of the user's (`--setting-sources
 * project`). A judge has no tool at all and no skill.
 *
 * It does not isolate the account: the tool authenticates as the creator does, so what it keeps in
 * the user's own folder (memory, skills) stays within its reach. The command says so.
 */

export interface NodeEvalAgentOptions {
  /** The environment to start from; only the variables the tool needs are passed on. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  /** Where the clean folders are made: the system's temporary folder when absent. */
  readonly temporary?: string;
  /** Another program and its leading arguments, in place of `claude` (tests give a fake one). */
  readonly launch?: { readonly file: string; readonly args: readonly string[] };
  /** Keeps the folder of each run (to look at what the agent did). */
  readonly keep?: boolean;
}

const PASSED_ENV = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "USERPROFILE",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_GIT_BASH_PATH",
  "ANTHROPIC_AUTH_TOKEN",
  // The other ways to reach the same models, for an account that uses one.
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "CLOUD_ML_REGION",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

const MAX_TRANSCRIPT = 8 * 1024 * 1024;
const MAX_PRODUCED_FILES = 30;
const MAX_PRODUCED_CHARS = 20_000;
/** The tools a working run has: no shell, no web. */
const WORK_TOOLS = "Read,Write,Edit,Glob,Grep,Skill";

/** True when `path` stays inside `folder`. */
function inside(folder: string, path: string): boolean {
  const rest = relative(folder, path);
  return rest !== "" && !rest.startsWith(`..${sep}`) && rest !== ".." && !isAbsolute(rest);
}

/** Every file under `folder` except Git's own and the skills the run was given. */
async function walk(folder: string, base = folder): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    const rest = relative(base, path).split(sep).join("/");
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === ".git" || rest === ".claude") continue;
      found.push(...(await walk(path, base)));
    } else if (entry.isFile()) {
      found.push(rest);
    }
  }
  return found;
}

export class NodeEvalAgent implements EvalAgent {
  readonly tool = "claude-code";
  readonly skillDir = ".claude/skills";
  /** The skills of the method name themselves under `.agentplugged/skills/` too. */
  readonly extraSkillDirs = [".agentplugged/skills"];
  readonly #options: NodeEvalAgentOptions;
  readonly #windows: boolean;

  constructor(options: NodeEvalAgentOptions) {
    this.#options = options;
    this.#windows = (options.platform ?? process.platform) === "win32";
  }

  /** The program that runs the tool: found on the path, a Windows shim resolved to the program it starts. */
  async #program(): Promise<{ file: string; args: string[] } | { error: string }> {
    if (this.#options.launch !== undefined) {
      return { file: this.#options.launch.file, args: [...this.#options.launch.args] };
    }
    const probe = new NodeToolProbe({
      env: this.#options.env,
      ...(this.#options.platform === undefined ? {} : { platform: this.#options.platform }),
    });
    const found = await probe.which(["claude"]);
    if (found === undefined)
      return { error: "claude is not on the path: install Claude Code first" };
    if (this.#windows && /\.(?:cmd|bat)$/iu.test(found.path)) {
      // npm's shim only starts this program: started directly, nothing is parsed by a shell.
      const native = join(
        dirname(found.path),
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "bin",
        "claude.exe",
      );
      if (!existsSync(native)) {
        return {
          error: `${found.path} cannot be started without a shell: install Claude Code's own program`,
        };
      }
      return { file: native, args: [] };
    }
    return { file: found.path, args: [] };
  }

  async available(): Promise<{ ok: boolean; detail?: string }> {
    const program = await this.#program();
    return "error" in program ? { ok: false, detail: program.error } : { ok: true };
  }

  #environment(): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {};
    const names = new Map(Object.keys(this.#options.env).map((name) => [name.toLowerCase(), name]));
    for (const wanted of PASSED_ENV) {
      const name = this.#windows ? names.get(wanted.toLowerCase()) : wanted;
      const value = name === undefined ? undefined : this.#options.env[name];
      // An empty value would override the tool's own way of finding its credential.
      if (value !== undefined && value !== "") env[wanted] = value;
    }
    return env;
  }

  async run(request: EvalAgentRequest): Promise<EvalAgentOutcome> {
    const program = await this.#program();
    if ("error" in program) {
      return { status: "failed", detail: program.error, transcript: "", produced: [], ms: 0 };
    }
    const folder = await mkdtemp(join(this.#options.temporary ?? tmpdir(), "agentplugged-eval-"));
    const started = Date.now();
    try {
      const staged = new Map<string, string>();
      for (const file of request.files) {
        const target = join(folder, ...file.path.split("/"));
        if (!inside(folder, target)) {
          return {
            status: "failed",
            detail: `${file.path} lies outside the folder`,
            transcript: "",
            produced: [],
            ms: 0,
          };
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, file.text, "utf8");
        staged.set(file.path, file.text);
      }
      const args = [
        ...program.args,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--no-session-persistence",
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        ...(request.role === "judge"
          ? ["--tools", "", "--disable-slash-commands"]
          : [
              "--permission-mode",
              "acceptEdits",
              "--tools",
              WORK_TOOLS,
              // The bare model has no skill at all, not even one of the account's.
              ...(request.bare === true ? ["--disable-slash-commands"] : []),
            ]),
        ...(request.model === undefined ? [] : ["--model", request.model]),
        ...(request.maxUsd === undefined ? [] : ["--max-budget-usd", String(request.maxUsd)]),
      ];
      const run = await this.#spawn(program.file, args, folder, request);
      const produced: EvalFile[] = [];
      if (run.status !== "failed" || run.transcript !== "") {
        for (const path of (await walk(folder)).sort().slice(0, MAX_PRODUCED_FILES * 4)) {
          if (produced.length >= MAX_PRODUCED_FILES) break;
          const file = join(folder, ...path.split("/"));
          const size = (await stat(file)).size;
          if (size > MAX_PRODUCED_CHARS * 4) {
            // Said, not skipped: a file the run wrote that is too big to be read here.
            produced.push({ path, text: `[too big to show: ${size} bytes]` });
            continue;
          }
          const full = await readFile(file, "utf8");
          // Compared whole, then cut: a staged file of more than the cut is not a file the run wrote.
          if (staged.get(path) !== full && !full.includes("\0")) {
            produced.push({ path, text: full.slice(0, MAX_PRODUCED_CHARS) });
          }
        }
      }
      return { ...run, produced, ms: Date.now() - started };
    } finally {
      if (this.#options.keep !== true)
        // A process killed a moment ago may still hold a file on Windows: try again a few times.
        await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
          () => undefined,
        );
    }
  }

  #spawn(
    file: string,
    args: string[],
    cwd: string,
    request: EvalAgentRequest,
  ): Promise<Omit<EvalAgentOutcome, "produced" | "ms">> {
    return new Promise((resolve) => {
      let transcript = "";
      let pending = "";
      let stderr = "";
      let settled = false;
      let stopped = false;
      let timedOut = false;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, {
          cwd,
          env: this.#environment(),
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
          shell: false,
        });
      } catch (error) {
        resolve({
          status: "failed",
          detail: error instanceof Error ? error.message : String(error),
          transcript: "",
        });
        return;
      }
      const kill = () => {
        if (this.#windows && child.pid !== undefined) {
          try {
            spawn(
              join(this.#options.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
              ["/pid", String(child.pid), "/T", "/F"],
              {
                stdio: "ignore",
                windowsHide: true,
              },
            ).on("error", () => undefined);
          } catch {
            // The direct kill below still applies.
          }
        }
        child.kill();
      };
      const finish = (outcome: Omit<EvalAgentOutcome, "produced" | "ms">) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(outcome);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
        // A grandchild may keep the pipes open: release them.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ status: "timeout", transcript });
      }, request.timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        if (transcript.length < MAX_TRANSCRIPT) transcript += chunk;
        if (request.stopWhen === undefined || stopped) return;
        pending += chunk;
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (lines.some((line) => line.trim() !== "" && request.stopWhen?.(line) === true)) {
          stopped = true;
          kill();
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({ status: "stopped", transcript });
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        if (stderr.length < 2_000) stderr += chunk;
      });
      child.stdin?.on("error", () => undefined);
      child.on("error", (error) => finish({ status: "failed", detail: error.message, transcript }));
      child.on("close", (code) => {
        if (timedOut || stopped) return;
        const detail = stderr.trim().slice(-300);
        if (code !== 0 && !transcript.includes('"type":"result"')) {
          finish({
            status: "failed",
            detail: detail === "" ? `exit code ${code}` : detail,
            transcript,
          });
        } else {
          finish({ status: "done", transcript });
        }
      });
      child.stdin?.end(request.prompt);
    });
  }
}
