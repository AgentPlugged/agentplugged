import type { ToolId } from "@agentplugged/protocol";
import { forgeCli } from "../stories/story-forge.js";
import { compareVersions, type DetectedTool, parseVersion } from "../tools/detect-tools.js";
import type { Detect, DirectorySpecData, Outcome } from "./catalog.js";
import type { EnvironmentProbe, FoundCommand } from "./environment-probe.js";

/**
 * The detectors of the catalogue: a closed set, each turning what the machine shows
 * into an outcome and the facts the sentences use (`{version}`, `{path}`…). They only look: a
 * detector never installs, writes nor reads a secret (the forge's login is the exit code of the
 * tool's own `auth status`, nothing else).
 */

/** What a detector found: an outcome (`skipped` when the check does not apply here) and facts. */
export interface Evaluation {
  readonly outcome: Outcome | "skipped";
  readonly facts: Readonly<Record<string, string>>;
}

/** What the detectors share during one run. */
export interface EvaluationContext {
  readonly probe: EnvironmentProbe;
  /** The AI tools found on the machine (detected once). */
  readonly tools: () => Promise<readonly DetectedTool[]>;
  /** The tools the product targets, when it says (its `method.yaml`); undefined: not decided. */
  readonly targeted: readonly ToolId[] | undefined;
  /** The text of the repository's `.gitattributes`; undefined when there is none. */
  readonly attributes?: (() => Promise<string | undefined>) | undefined;
  /** The folders the system's PATH has and this process' does not, read once per report. */
  readonly unseen?: (() => Promise<string[]>) | undefined;
}

/** Time limit of a question to Docker's engine, which may be starting. */
const DOCKER_TIMEOUT_MS = 20_000;

/** The host of the registry npm uses, from its configuration; undefined when npm is not there. */
async function npmRegistry(probe: EnvironmentProbe): Promise<string | undefined> {
  const fromEnv = probe.env("npm_config_registry") ?? probe.env("NPM_CONFIG_REGISTRY");
  if (fromEnv !== undefined) return hostOfAddress(fromEnv);
  const npm = await probe.find(["npm"]);
  if (npm === undefined) return undefined;
  const run = await probe.run([npm.path, "config", "get", "registry"], {
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  const line = run.stdout.trim().split(/\r?\n/).at(-1) ?? "";
  return run.status === 0 && line !== "" ? hostOfAddress(line) : undefined;
}

/** Time limit of a version probe. */
const VERSION_TIMEOUT_MS = 10_000;

/** The folder of a path, with either separator. */
export function dirOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path : path.slice(0, cut);
}

const DEFAULT_HOSTS = { github: "github.com", gitlab: "gitlab.com" } as const;

/** The forge's name as its own people write it. */
function forgeName(forge: "github" | "gitlab"): string {
  return forge === "github" ? "GitHub" : "GitLab";
}

/** A folder as compared with another: no trailing separator, case-insensitive on Windows. */
function sameFolder(platform: string, a: string, b: string): boolean {
  const norm = (folder: string) => {
    const trimmed = folder.replace(/[\\/]+$/, "");
    return platform === "win32" ? trimmed.replaceAll("/", "\\").toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

/** The folders the system's own PATH holds and this process' PATH does not. */
export async function foldersNotYetSeen(probe: EnvironmentProbe): Promise<string[]> {
  const system = await probe.systemPath();
  if (system === undefined) return [];
  const have = probe.processPath();
  return system.filter((folder) => !have.some((seen) => sameFolder(probe.platform, seen, folder)));
}

/** A host as written in an address or a `host:port`, without user, password, path or port. */
export function hostOfAddress(value: string): string | undefined {
  const match =
    /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/?#]*@)?(\[[0-9a-f:]+\]|[a-z0-9]([a-z0-9._-]*[a-z0-9])?)(?::\d+)?(?:[/?#].*)?$/i.exec(
      value.trim(),
    );
  return match?.[1]?.toLowerCase();
}

function skipped(): Evaluation {
  return { outcome: "skipped", facts: {} };
}

function specsFor(
  specs: readonly DirectorySpecData[] | undefined,
  command: string | undefined,
): DirectorySpecData[] {
  return (specs ?? []).filter((spec) => spec.for === undefined || spec.for === command);
}

/** A program looked for, its version read, compared with what is required. */
async function evaluateCommand(
  probe: EnvironmentProbe,
  names: readonly string[],
  min: string | undefined,
  extra: readonly DirectorySpecData[],
  facts: Record<string, string>,
  unseenFolders: () => Promise<string[]>,
  readVersion = true,
): Promise<Evaluation> {
  let found: FoundCommand | undefined = await probe.find(names, extra);
  // The system's own PATH may hold it while this process (opened before) does not: « stale ».
  let stale = false;
  if (found?.onPath !== true) {
    const unseen = await unseenFolders();
    const there = unseen.length === 0 ? undefined : await probe.findIn(names, unseen);
    if (there !== undefined) {
      found = there;
      stale = true;
    } else if (found !== undefined) {
      const dir = dirOf(found.path);
      stale = unseen.some((folder) => sameFolder(probe.platform, folder, dir));
    }
  }
  if (found === undefined) return { outcome: "missing", facts: { ...facts, name: names[0] ?? "" } };
  // A name taken from a failure's text is only looked for: its program is never started.
  const run = readVersion
    ? await probe.run([found.path, "--version"], { timeoutMs: VERSION_TIMEOUT_MS })
    : undefined;
  const version = run?.status === 0 ? parseVersion(run.stdout.trim() || run.stderr) : undefined;
  const known = {
    ...facts,
    name: found.name,
    path: found.path,
    dir: dirOf(found.path),
    version: version ?? "?",
    ...(min === undefined ? {} : { min }),
  };
  if (min !== undefined && readVersion) {
    if (version === undefined) return { outcome: "unreadable", facts: known };
    if (compareVersions(version, min) < 0) return { outcome: "old", facts: known };
  }
  return { outcome: found.onPath ? "ok" : stale ? "stale" : "off_path", facts: known };
}

/** The forge of the repository, with the host its tool is connected to; none when unknown. */
async function forgeOf(
  probe: EnvironmentProbe,
): Promise<{ forge: "github" | "gitlab"; host: string } | undefined> {
  const remote = await probe.forge();
  // A remote on a host that is neither GitHub nor GitLab has no tool the engine drives.
  if (remote.forge === undefined && remote.host !== undefined) return undefined;
  const forge = remote.forge ?? "github";
  return { forge, host: remote.host ?? DEFAULT_HOSTS[forge] };
}

/** Runs one detector. */
export async function evaluateDetect(
  detect: Detect,
  context: EvaluationContext,
): Promise<Evaluation> {
  const { probe } = context;
  const unseenFolders = context.unseen ?? (() => foldersNotYetSeen(probe));
  switch (detect.kind) {
    case "node": {
      const version = parseVersion(probe.nodeVersion()) ?? "?";
      const facts = { version, min: detect.min };
      return {
        outcome: version !== "?" && compareVersions(version, detect.min) >= 0 ? "ok" : "old",
        facts,
      };
    }
    case "command":
      return evaluateCommand(
        probe,
        detect.names,
        detect.min,
        specsFor(detect.also_in, detect.names[0]),
        {},
        unseenFolders,
        detect.version !== false,
      );
    case "forge-cli": {
      const forge = await forgeOf(probe);
      if (forge === undefined) return skipped();
      const cli = forgeCli(forge.forge);
      return evaluateCommand(
        probe,
        [cli],
        undefined,
        specsFor(detect.also_in, cli),
        {
          forge: forge.forge,
          forge_name: forgeName(forge.forge),
          cli,
          host: forge.host,
        },
        unseenFolders,
      );
    }
    case "forge-login": {
      const forge = await forgeOf(probe);
      if (forge === undefined) return skipped();
      const cli = forgeCli(forge.forge);
      const facts = {
        forge: forge.forge,
        forge_name: forgeName(forge.forge),
        cli,
        host: forge.host,
      };
      // The tool may be installed off PATH: its install folders are the catalogue's.
      const found = await probe.find([cli], specsFor(detect.also_in, cli));
      // No tool, no login to check: the CLI check says it.
      if (found === undefined) return skipped();
      const status = await probe.run([found.path, "auth", "status", "--hostname", forge.host], {
        timeoutMs: VERSION_TIMEOUT_MS,
      });
      if (status.status === 0) return { outcome: "ok", facts };
      // The tool asks the forge's servers: when they cannot be reached, nothing is known of the login.
      const offline =
        /dial tcp|no such host|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|timed? ?out|network is unreachable|could not resolve|connection (?:refused|reset)/i;
      if (status.timedOut === true || offline.test(`${status.stderr}\n${status.stdout}`)) {
        return { outcome: "unreadable", facts };
      }
      return { outcome: "logged_out", facts };
    }
    case "git-repo":
      // Without Git there is no repository to speak of: the Git check says it.
      if ((await probe.find(["git"])) === undefined) return skipped();
      return { outcome: (await probe.isRepository()) ? "ok" : "missing", facts: {} };
    case "git-config": {
      if ((await probe.find(["git"])) === undefined) return skipped();
      const missing: string[] = [];
      for (const key of detect.keys) {
        if ((await probe.gitConfig(key)) === undefined) missing.push(key);
      }
      return {
        outcome: missing.length === 0 ? "ok" : "unset",
        facts: {
          missing: missing.join(", "),
          git_name: (await probe.gitConfig("user.name")) ?? "",
          git_email: (await probe.gitConfig("user.email")) ?? "",
        },
      };
    }
    case "ai-tool": {
      const detected = await context.tools();
      if (detect.tool === "any") {
        const names = detected.filter((tool) => tool.found).map((tool) => tool.name);
        return { outcome: names.length > 0 ? "ok" : "missing", facts: { names: names.join(", ") } };
      }
      const tool = detected.find((entry) => entry.id === detect.tool);
      if (tool === undefined) return skipped();
      // A tool the product does not target, and that is not on the machine, is none of its business.
      const wanted =
        context.targeted === undefined ? tool.found : context.targeted.includes(tool.id);
      if (!wanted) return skipped();
      const facts = {
        name: tool.name,
        version: tool.version ?? "?",
        ...(tool.offPath === undefined ? {} : { dir: tool.offPath }),
      };
      if (!tool.found) return { outcome: "missing", facts };
      if (tool.offPath === undefined) return { outcome: "ok", facts };
      const dir = tool.offPath;
      const unseen = await unseenFolders();
      const known = unseen.some((folder) => sameFolder(probe.platform, folder, dir));
      return { outcome: known ? "stale" : "off_path", facts };
    }
    case "keychain":
      return { outcome: (await probe.keychain()) ? "ok" : "unavailable", facts: {} };
    case "presence":
      return { outcome: (await probe.presence()) ? "ok" : "unavailable", facts: {} };
    case "port": {
      const state = await probe.port(detect.port);
      const facts: Record<string, string> = { port: String(detect.port) };
      if (state === "refused") {
        // A refusal inside a range the system keeps for itself is told apart from an unknown one.
        const range = (await probe.reservedPortRanges())?.find(
          (entry) => detect.port >= entry.from && detect.port <= entry.to,
        );
        if (range !== undefined) {
          return {
            outcome: "reserved",
            facts: { ...facts, from: String(range.from), to: String(range.to) },
          };
        }
      }
      return { outcome: state === "free" ? "ok" : state, facts };
    }
    case "memory": {
      const memory = probe.memoryGb();
      return {
        outcome: memory >= detect.min_gb ? "ok" : "low",
        facts: { memory: String(Math.round(memory * 10) / 10), needed: String(detect.min_gb) },
      };
    }
    case "path-stale": {
      if ((await probe.systemPath()) === undefined) return skipped();
      const unseen = await unseenFolders();
      return {
        outcome: unseen.length === 0 ? "ok" : "stale",
        facts: {
          count: String(unseen.length),
          first: unseen[0] ?? "",
          dirs: unseen.slice(0, 3).join(" ; "),
        },
      };
    }
    case "docker-daemon": {
      const docker = await probe.find(["docker"], specsFor(detect.also_in, "docker"));
      if (docker === undefined) return skipped();
      const run = await probe.run([docker.path, "info", "--format", "{{.ServerVersion}}"], {
        timeoutMs: DOCKER_TIMEOUT_MS,
      });
      const facts = { path: docker.path, dir: dirOf(docker.path) };
      if (run.status === 0 && run.stdout.trim() !== "") {
        return { outcome: "ok", facts: { ...facts, version: run.stdout.trim().slice(0, 40) } };
      }
      if (run.timedOut === true) return { outcome: "unreadable", facts };
      if (/permission denied|access is denied/i.test(`${run.stderr}\n${run.stdout}`)) {
        return { outcome: "denied", facts };
      }
      return { outcome: "stopped", facts };
    }
    case "docker-memory": {
      const docker = await probe.find(["docker"], specsFor(detect.also_in, "docker"));
      if (docker === undefined) return skipped();
      const run = await probe.run([docker.path, "info", "--format", "{{.MemTotal}}"], {
        timeoutMs: DOCKER_TIMEOUT_MS,
      });
      // Docker not answering is the daemon check's finding, not a memory one.
      if (run.status !== 0) return skipped();
      const bytes = Number(run.stdout.trim());
      const needed = String(detect.min_gb);
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return { outcome: "unreadable", facts: { needed, memory: "?" } };
      }
      const memory = bytes / 1024 ** 3;
      return {
        outcome: memory >= detect.min_gb ? "ok" : "low",
        facts: { memory: String(Math.round(memory * 10) / 10), needed },
      };
    }
    case "disk": {
      const free = await probe.diskFreeGb();
      const needed = String(detect.min_gb);
      if (free === undefined) return { outcome: "unreadable", facts: { needed, free: "?" } };
      return {
        outcome: free >= detect.min_gb ? "ok" : "full",
        facts: { free: String(Math.round(free * 10) / 10), needed, folder: probe.workingFolder() },
      };
    }
    case "path-length": {
      const folder = probe.workingFolder();
      const enabled = await probe.longPathsEnabled();
      return {
        outcome: folder.length > detect.max ? "long" : "ok",
        facts: {
          length: String(folder.length),
          max: String(detect.max),
          folder,
          windows_long: enabled === undefined ? "?" : enabled ? "yes" : "no",
        },
      };
    }
    case "line-endings": {
      if ((await probe.find(["git"])) === undefined) return skipped();
      if (!(await probe.isRepository())) return skipped();
      const autocrlf = (await probe.gitConfig("core.autocrlf")) ?? "not set";
      const attributes = (await context.attributes?.()) ?? "";
      // A rule for every file, or any explicit end-of-line rule, settles it for the repository.
      const fixed =
        /^\s*\*\s[^\n]*(?:eol=|text=auto|-text)/m.test(attributes) || /\seol=/.test(attributes);
      // `input` and `false` do not touch the files; `true` (or Windows' default, unset) rewrites them.
      const risky =
        !fixed && (autocrlf === "true" || (autocrlf === "not set" && probe.platform === "win32"));
      return {
        outcome: risky ? "risky" : "ok",
        facts: { autocrlf, attributes: attributes.trim() === "" ? "no" : "yes" },
      };
    }
    case "administrator": {
      const admin = await probe.isAdministrator();
      return {
        outcome: admin === undefined ? "unreadable" : admin ? "ok" : "denied",
        facts: {},
      };
    }
    case "proxy": {
      const via: string[] = [];
      for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"]) {
        const value = probe.env(name) ?? probe.env(name.toLowerCase());
        if (value === undefined) continue;
        // Only the host: an address can carry a user and a password.
        via.push(`${name} (${hostOfAddress(value) ?? "?"})`);
      }
      const gitProxy = (await probe.gitConfig("http.proxy"))?.trim();
      if (gitProxy !== undefined) via.push(`git http.proxy (${hostOfAddress(gitProxy) ?? "?"})`);
      const registry = await npmRegistry(probe);
      if (registry !== undefined && registry !== "registry.npmjs.org") {
        via.push(`npm registry (${registry})`);
      }
      return { outcome: via.length > 0 ? "proxy" : "ok", facts: { via: via.join(" ; ") } };
    }
  }
}
