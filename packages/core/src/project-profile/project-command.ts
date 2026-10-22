import { ErrorCode } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_DIR } from "../init/layout.js";
import { isCodePath } from "../reuse/code-files.js";
import {
  BRICK_FILE_BYTES,
  type Brick,
  buildBricks,
  findBricks,
  matchingSources,
} from "./bricks.js";
import {
  acceptanceText,
  type KeptProfile,
  PROFILE_PATH,
  parseKept,
  renderProfile,
  type SingleSource,
  withSource,
} from "./profile-file.js";
import { type ProjectScan, scanProject } from "./scan.js";

/** Where the engine keeps the registry it read: the machine's memory, outside Git. */
export const BRICKS_CACHE_PATH = `${METHOD_DIR}/.cache/bricks.json`;

/** The answer of `docs profile`: the profile as the engine writes it now. */
export interface ProfileShown {
  readonly profile: {
    readonly path: string;
    /** True when the file was written or rewritten by this call. */
    readonly written: boolean;
    /** The file as it was, absent or no longer what the root files say. */
    readonly state: "created" | "refreshed" | "current" | "stale" | "absent";
    readonly lines: readonly string[];
  };
}

/** The answer of `docs bricks`. */
export interface BricksFound {
  readonly bricks: {
    readonly query: readonly string[];
    readonly hits: readonly {
      readonly name: string;
      readonly kind: Brick["kind"];
      readonly path: string;
      readonly line: number;
      readonly sig: string;
    }[];
    /** The single sources whose concept the request names: the one place to look first. */
    readonly sources: readonly SingleSource[];
    /** Bricks searched, and the commit they were read at (short). Absent when the code cannot be read. */
    readonly searched?: { readonly total: number; readonly commit: string };
    /** Set when nothing could be searched. */
    readonly unavailable?: "no_repository" | "no_commit" | "no_code_source";
    /** A single source declared now (`own`). */
    readonly declared?: SingleSource;
  };
}

const invalid = (reason: string) =>
  new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });

async function readText(context: CommandContext, path: string): Promise<string | undefined> {
  try {
    return (await context.files.exists(path)) ? await context.files.readText(path) : undefined;
  } catch {
    return undefined;
  }
}

/** The single sources the team declared (the table of the profile), empty without a profile. */
export async function singleSourcesOf(context: CommandContext): Promise<readonly SingleSource[]> {
  const text = await readText(context, PROFILE_PATH);
  return text === undefined ? [] : parseKept(text).sources;
}

/** The profile file for a scan, the parts people wrote kept from `current`. */
export function profileFile(scan: ProjectScan, current: string | undefined): string {
  const kept: KeptProfile =
    current === undefined ? { sources: [], acceptance: "", notes: "" } : parseKept(current);
  return renderProfile(scan, kept);
}

/**
 * `docs profile [refresh]`: the project profile. Without `refresh`, the file as it would be written
 * now (and whether the file on disk still says the same); with it, the file is written. The profile
 * is read from the root files of the product, so it is never invented.
 */
export async function showProfile(
  context: CommandContext,
  words: readonly string[],
): Promise<ProfileShown | AgentPluggedError> {
  if (words[0] === "accept") return declareAcceptance(context, words.slice(1));
  if (words.length > 1 || (words.length === 1 && words[0] !== "refresh")) {
    return invalid(
      `docs profile ${words.join(" ")} (profile [refresh], or profile accept <local|staging> [how])`,
    );
  }
  const current = await readText(context, PROFILE_PATH);
  const fresh = profileFile(await scanProject(context.files), current);
  const same = current !== undefined && current.replace(/\r\n/g, "\n") === fresh;
  if (words[0] === "refresh") {
    if (!same) await context.files.writeText(PROFILE_PATH, fresh);
    return {
      profile: {
        path: PROFILE_PATH,
        written: !same,
        state: current === undefined ? "created" : same ? "current" : "refreshed",
        lines: fresh.split("\n"),
      },
    };
  }
  return {
    profile: {
      path: PROFILE_PATH,
      written: false,
      state: current === undefined ? "absent" : same ? "current" : "stale",
      lines: fresh.split("\n"),
    },
  };
}

/**
 * `docs profile accept <local|staging> [how…]`: where the acceptance run happens, decided with the
 * creator and kept in the profile (a refresh never overwrites it).
 */
async function declareAcceptance(
  context: CommandContext,
  words: readonly string[],
): Promise<ProfileShown | AgentPluggedError> {
  const [place, ...how] = words;
  if (place !== "local" && place !== "staging") {
    return invalid("docs profile accept <local|staging> [how to reach it]");
  }
  const current = await readText(context, PROFILE_PATH);
  const kept: KeptProfile =
    current === undefined ? { sources: [], acceptance: "", notes: "" } : parseKept(current);
  const fresh = renderProfile(await scanProject(context.files), {
    ...kept,
    acceptance: acceptanceText(place, how.join(" ")),
  });
  await context.files.writeText(PROFILE_PATH, fresh);
  return {
    profile: { path: PROFILE_PATH, written: true, state: "refreshed", lines: fresh.split("\n") },
  };
}

interface Registry {
  readonly bricks: readonly Brick[];
  readonly commit: string;
}

type Loaded = Registry | "no_repository" | "no_commit" | "no_code_source";

/** The bricks at the commit the folder is on: read from the cache, or read again when it moved. */
async function loadBricks(context: CommandContext): Promise<Loaded> {
  if (context.codeSource === undefined || context.docsBase === undefined) return "no_code_source";
  const head = await context.docsBase.read("HEAD", [PROFILE_PATH]).catch(() => undefined);
  if (head === undefined) return "no_repository";
  if (!head.found) return head.reason === "no_commit" ? "no_commit" : "no_repository";
  const cached = await readText(context, BRICKS_CACHE_PATH);
  if (cached !== undefined) {
    try {
      const parsed = JSON.parse(cached) as { v?: unknown; commit?: unknown; bricks?: unknown };
      if (parsed.v === 1 && parsed.commit === head.commit && Array.isArray(parsed.bricks)) {
        const bricks = (parsed.bricks as unknown[][]).flatMap((row): Brick[] =>
          typeof row[0] === "string" &&
          (row[1] === "fn" || row[1] === "type") &&
          typeof row[2] === "string" &&
          Number.isInteger(row[3]) &&
          typeof row[4] === "string"
            ? [{ name: row[0], kind: row[1], path: row[2], line: row[3] as number, sig: row[4] }]
            : [],
        );
        return { bricks, commit: head.commit };
      }
    } catch {
      // An unreadable cache is read again.
    }
  }
  const tree = await context.codeSource
    .read(head.commit, (path, bytes) => isCodePath(path) && bytes <= BRICK_FILE_BYTES)
    .catch(() => undefined);
  if (tree === undefined) return "no_repository";
  const bricks = buildBricks(tree);
  await context.files
    .writeText(
      BRICKS_CACHE_PATH,
      JSON.stringify({
        v: 1,
        commit: head.commit,
        bricks: bricks.map((brick) => [brick.name, brick.kind, brick.path, brick.line, brick.sig]),
      }),
    )
    .catch(() => undefined);
  return { bricks, commit: head.commit };
}

/**
 * `docs bricks <words>`: does something like this already exist? The bricks (functions and types)
 * whose names carry the words, best first, and the single source that owns the concept if one is
 * declared. `docs bricks own <concept> <path> [rule…]` declares a single source: the concept then
 * has one home, and a second one added by a story is flagged at its review.
 */
export async function findInRegistry(
  context: CommandContext,
  words: readonly string[],
): Promise<BricksFound | AgentPluggedError> {
  if (words[0] === "own") return declareSource(context, words.slice(1));
  if (words.length === 0) return invalid("docs bricks <words> | docs bricks own <concept> <path>");
  const sources = await singleSourcesOf(context);
  const named = matchingSources(sources, words);
  const loaded = await loadBricks(context);
  if (typeof loaded === "string") {
    return { bricks: { query: words, hits: [], sources: named, unavailable: loaded } };
  }
  const hits = findBricks(loaded.bricks, words).map(({ brick }) => ({
    name: brick.name,
    kind: brick.kind,
    path: brick.path,
    line: brick.line,
    sig: brick.sig,
  }));
  return {
    bricks: {
      query: words,
      hits,
      sources: named,
      searched: { total: loaded.bricks.length, commit: loaded.commit.slice(0, 12) },
    },
  };
}

async function declareSource(
  context: CommandContext,
  words: readonly string[],
): Promise<BricksFound | AgentPluggedError> {
  const [concept, owner, ...rule] = words;
  if (concept === undefined || owner === undefined || concept.length < 2) {
    return invalid("docs bricks own <concept> <path> [rule…]");
  }
  const bare = owner
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  if (bare === "" || bare.startsWith("/") || bare.split("/").includes("..")) {
    return invalid(`docs bricks own ${concept} ${owner} (a path of the product)`);
  }
  if (!(await context.files.exists(bare))) {
    return invalid(`docs bricks own ${concept} ${owner} (no such file or folder)`);
  }
  const source: SingleSource = {
    concept: concept.replace(/[|\r\n]+/g, " ").trim(),
    // A folder ends with a slash: it owns every file under it.
    owner: ((await context.files.listEntries?.(bare)) ?? []).length > 0 ? `${bare}/` : bare,
    rule: rule.join(" ").slice(0, 160),
  };
  const current = await readText(context, PROFILE_PATH);
  const scan = await scanProject(context.files);
  const kept = withSource(
    current === undefined ? { sources: [], acceptance: "", notes: "" } : parseKept(current),
    source,
  );
  await context.files.writeText(PROFILE_PATH, renderProfile(scan, kept));
  return { bricks: { query: [concept], hits: [], sources: [source], declared: source } };
}

/** What a developer is handed when a story starts: the profile in a few lines, never the file. */
export interface ProfileBrief {
  readonly path: string;
  readonly stack: readonly string[];
  readonly commands: readonly string[];
  readonly single_sources: readonly string[];
  /** The advice that bears on the work, each with its reason. */
  readonly advice: readonly string[];
  /** The command that answers « does this already exist? ». */
  readonly ask: string;
}

/** Longest list of each kind in the brief. */
const BRIEF_ROWS = 6;

/**
 * The profile brief for a story: read from the root files now (a stale file never misleads) with the
 * single sources of the profile. Undefined when the product has no stack to describe yet.
 */
export async function profileBrief(context: CommandContext): Promise<ProfileBrief | undefined> {
  try {
    const scan = await scanProject(context.files);
    if (scan.stack.length === 0 && scan.commands.length === 0) return undefined;
    const sources = await singleSourcesOf(context);
    return {
      path: PROFILE_PATH,
      stack: scan.stack.slice(0, BRIEF_ROWS).map((row) => row.slice(0, 140)),
      commands: scan.commands.slice(0, BRIEF_ROWS * 2).map((c) => `${c.name}: ${c.command}`),
      single_sources: sources
        .slice(0, 10)
        .map((s) => `${s.concept} -> ${s.owner}${s.rule === "" ? "" : ` (${s.rule})`}`),
      advice: scan.advice.slice(0, 3).map((a) => `${a.advice} Why: ${a.why}`.slice(0, 220)),
      ask: "npx agentplugged docs bricks <words>",
    };
  } catch {
    return undefined;
  }
}
