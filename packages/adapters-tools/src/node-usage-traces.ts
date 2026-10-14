import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type AntigravityInfo,
  antigravityModelAt,
  antigravityPlace,
  antigravityTraceInfo,
  type TraceFile,
  type UsageTraces,
} from "@agentplugged/core";

/**
 * The traces of the AI tools on this machine, read for the product's folder and the
 * working copies of its stories. Claude Code keeps one folder per project under
 * `~/.claude/projects/` (named after the project's path, every character that is not a letter or
 * a digit replaced by a hyphen): its conversations as `<session>.jsonl`, and the sessions its
 * sub-agents ran as `<session>/subagents/agent-*.jsonl` with a `.meta.json` that names the agent
 * (`agentType`) and gives the session its title (`description`). Codex keeps its sessions under
 * `~/.codex/sessions/<year>/<month>/<day>/rollout-*.jsonl`, the first line naming the folder it ran
 * in. Antigravity keeps one folder per conversation under `~/.gemini/antigravity/brain/`, its
 * transcript in `<conversation>/.system_generated/logs/transcript.jsonl`: the files the
 * conversation names tell which folder it worked in, and a sub-agent's conversation (which never
 * says which model it runs on) takes the model its parent conversation ran on when it started.
 * Cursor keeps no token count in any local trace: nothing is read of it. This adapter only
 * reads files; `core` reads their text.
 */

/** A file larger than this is not read (a trace of this size is not a session of an agent). */
const MAX_TRACE_BYTES = 256 * 1024 * 1024;

/** Claude Code's name for the folder of a project: its path with every non alphanumeric character as a hyphen. */
export function claudeProjectFolder(path: string): string {
  return resolve(path).replace(/[^A-Za-z0-9]/gu, "-");
}

function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function names(folder: string): Promise<string[]> {
  try {
    return (await readdir(folder)).sort();
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

async function readSmall(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_TRACE_BYTES) return undefined;
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

/** What `readIfChanged` gives for a file not modified since it was measured. */
const UNCHANGED = Symbol("unchanged");

/**
 * The text of a trace, `UNCHANGED` when it was not modified since the engine measured it
 * (`since(session)`: the time of that measure), undefined when it is missing or too large. A file
 * already measured whose last change is older is not read: a finished session is never read twice.
 */
async function readIfChanged(
  path: string,
  session: string,
  since: ((session: string) => number | undefined) | undefined,
): Promise<string | typeof UNCHANGED | undefined> {
  const measured = since?.(session);
  if (measured !== undefined) {
    try {
      if ((await stat(path)).mtimeMs <= measured) return UNCHANGED;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  }
  return await readSmall(path);
}

/** A conversation's identifier as a folder name (a parent's comes from a trace: never a path). */
const CONVERSATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/** The same folder written two ways (case, slashes): compared on Windows without caring. */
const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

/** A folder the product's sessions may have run in: its own, or a story's working copy. */
interface Place {
  readonly path: string;
  readonly worktree: string | undefined;
}

type LoadConversation = (id: string) => Promise<string | undefined>;

/**
 * The place an Antigravity conversation worked in. The creator's own conversation belongs to the
 * product's folder, never to a story's working copy, whatever file was open (the engine cuts it
 * by its journal). A sub-agent's conversation that works elsewhere (an agent reading the engine's
 * own sources for a retrospective) or names no file is where its parent conversation worked: the
 * one who handed it the work.
 */
async function placeOf(
  text: string,
  info: AntigravityInfo,
  places: readonly Place[],
  load: LoadConversation,
  depth: number,
): Promise<Place | undefined> {
  const found = antigravityPlace(
    text,
    places.map((place) => place.path),
  );
  if (found !== undefined && found !== "elsewhere") return places[info.kind === "main" ? 0 : found];
  if (info.kind !== "sub" || info.parent === undefined || depth > 4) return undefined;
  const parent = await load(info.parent);
  if (parent === undefined) return undefined;
  return await placeOf(parent, antigravityTraceInfo(parent), places, load, depth + 1);
}

/**
 * The model a sub-agent's conversation ran on: its parent conversation's when it started (the tool
 * writes none for a sub-agent), the parent's own parent's when that one never chose any.
 */
async function modelOf(
  info: AntigravityInfo,
  load: LoadConversation,
  depth: number,
): Promise<string | undefined> {
  if (info.parent === undefined || depth > 4) return undefined;
  const text = await load(info.parent);
  if (text === undefined) return undefined;
  const parent = antigravityTraceInfo(text);
  const inherited =
    parent.parent === undefined ? undefined : await modelOf(parent, load, depth + 1);
  return antigravityModelAt(text, info.started_at ?? 0, inherited);
}

export interface NodeUsageTracesOptions {
  /** The product's folder (the repository's top). */
  readonly root: string;
  /** Claude Code's folder (`~/.claude`): for tests. */
  readonly claudeHome?: string;
  /** Codex's folder (`~/.codex`): for tests. */
  readonly codexHome?: string;
  /** Antigravity's folder (`~/.gemini/antigravity`): for tests. */
  readonly antigravityHome?: string;
}

export class NodeUsageTraces implements UsageTraces {
  readonly #root: string;
  readonly #claude: string;
  readonly #codex: string;
  readonly #antigravity: string;

  constructor(options: NodeUsageTracesOptions) {
    this.#root = resolve(options.root);
    this.#claude = options.claudeHome ?? join(homedir(), ".claude");
    this.#codex = options.codexHome ?? join(homedir(), ".codex");
    this.#antigravity = options.antigravityHome ?? join(homedir(), ".gemini", "antigravity");
  }

  async read(
    worktrees: readonly string[],
    since?: (session: string) => number | undefined,
  ): Promise<readonly TraceFile[]> {
    const places = [
      { path: this.#root, worktree: undefined as string | undefined },
      ...worktrees.map((worktree) => ({ path: resolve(this.#root, worktree), worktree })),
    ];
    const traces: TraceFile[] = [];
    for (const place of places) {
      traces.push(...(await this.#claudeTraces(place.path, place.worktree, since)));
    }
    traces.push(...(await this.#codexTraces(places, since)));
    traces.push(...(await this.#antigravityTraces(places, since)));
    return traces;
  }

  async #claudeTraces(
    path: string,
    worktree: string | undefined,
    since: ((session: string) => number | undefined) | undefined,
  ): Promise<TraceFile[]> {
    const folder = join(this.#claude, "projects", claudeProjectFolder(path));
    const traces: TraceFile[] = [];
    const withWorktree = worktree === undefined ? {} : { worktree };
    for (const name of await names(folder)) {
      if (name.endsWith(".jsonl")) {
        const id = name.slice(0, -".jsonl".length);
        const text = await readIfChanged(join(folder, name), `claude-code:${id}`, since);
        if (text !== undefined) {
          traces.push({
            source: "claude-code",
            id,
            kind: "main",
            ...withWorktree,
            ...(text === UNCHANGED ? { unchanged: true, text: "" } : { text }),
          });
        }
        continue;
      }
      const subs = join(folder, name, "subagents");
      for (const sub of await names(subs)) {
        if (!sub.endsWith(".jsonl")) continue;
        const id = sub.slice(0, -".jsonl".length);
        const text = await readIfChanged(join(subs, sub), `claude-code:${id}`, since);
        if (text === undefined) continue;
        const meta = await this.#meta(join(subs, `${id}.meta.json`));
        traces.push({
          source: "claude-code",
          id,
          kind: "sub",
          ...(meta.agentType === undefined ? {} : { agent_type: meta.agentType }),
          ...(meta.description === undefined ? {} : { description: meta.description }),
          ...withWorktree,
          ...(text === UNCHANGED ? { unchanged: true, text: "" } : { text }),
        });
      }
    }
    return traces;
  }

  async #meta(path: string): Promise<{ agentType?: string; description?: string }> {
    const text = await readSmall(path);
    if (text === undefined) return {};
    try {
      const parsed = JSON.parse(text) as { agentType?: unknown; description?: unknown };
      return {
        ...(typeof parsed.agentType === "string"
          ? { agentType: parsed.agentType.toLowerCase() }
          : {}),
        ...(typeof parsed.description === "string" ? { description: parsed.description } : {}),
      };
    } catch {
      return {};
    }
  }

  /** Codex's rollouts whose first line says they ran in the product's folder or a story's. */
  async #codexTraces(
    places: readonly { path: string; worktree: string | undefined }[],
    since: ((session: string) => number | undefined) | undefined,
  ): Promise<TraceFile[]> {
    const traces: TraceFile[] = [];
    for (const file of await this.#rollouts(join(this.#codex, "sessions"), 0)) {
      const cwd = await firstLineCwd(file);
      if (cwd === undefined) continue;
      const place = places.find((candidate) => same(candidate.path, cwd));
      if (place === undefined) continue;
      const base = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1);
      const id = base.slice(0, -".jsonl".length);
      const text = await readIfChanged(file, `codex:${id}`, since);
      if (text === undefined) continue;
      traces.push({
        source: "codex",
        id,
        kind: "main",
        ...(place.worktree === undefined ? {} : { worktree: place.worktree }),
        ...(text === UNCHANGED ? { unchanged: true, text: "" } : { text }),
      });
    }
    return traces;
  }

  /**
   * Antigravity's conversations that worked in the product's folder or a story's. A conversation
   * already measured and not modified since is not read: it holds nothing new. A conversation
   * that cannot be read (the tool is writing it) is left for the next measure, never an error.
   */
  async #antigravityTraces(
    places: readonly Place[],
    since: ((session: string) => number | undefined) | undefined,
  ): Promise<TraceFile[]> {
    const brain = join(this.#antigravity, "brain");
    // A parent is read once per measure, however many sub-agents it started.
    const loaded = new Map<string, Promise<string | undefined>>();
    const load = (id: string): Promise<string | undefined> => {
      if (!CONVERSATION_ID.test(id)) return Promise.resolve(undefined);
      let text = loaded.get(id);
      if (text === undefined) {
        text = readSmall(join(brain, id, ".system_generated", "logs", "transcript.jsonl")).catch(
          () => undefined,
        );
        loaded.set(id, text);
      }
      return text;
    };
    const traces: TraceFile[] = [];
    for (const id of await names(brain)) {
      try {
        const file = join(brain, id, ".system_generated", "logs", "transcript.jsonl");
        const text = await readIfChanged(file, `antigravity:${id}`, since);
        if (text === undefined) continue;
        if (text === UNCHANGED) {
          traces.push({ source: "antigravity", id, kind: "main", unchanged: true, text: "" });
          continue;
        }
        const info = antigravityTraceInfo(text);
        const place = await placeOf(text, info, places, load, 0);
        if (place === undefined) continue;
        const model = info.parent === undefined ? undefined : await modelOf(info, load, 0);
        traces.push({
          source: "antigravity",
          id,
          kind: info.kind,
          ...(info.agent_type === undefined ? {} : { agent_type: info.agent_type }),
          ...(info.description === undefined ? {} : { description: info.description }),
          ...(place.worktree === undefined ? {} : { worktree: place.worktree }),
          ...(model === undefined ? {} : { model }),
          text,
        });
      } catch {
        // A file busy or unreadable at this moment: measured the next time.
      }
    }
    return traces;
  }

  async #rollouts(folder: string, depth: number): Promise<string[]> {
    if (depth > 4) return [];
    const found: string[] = [];
    for (const name of await names(folder)) {
      const path = join(folder, name);
      if (name.startsWith("rollout-") && name.endsWith(".jsonl")) found.push(path);
      else if (!name.includes(".")) found.push(...(await this.#rollouts(path, depth + 1)));
    }
    return found;
  }
}

/** The `cwd` of a Codex rollout's first line (`session_meta`), without reading the whole file. */
async function firstLineCwd(path: string): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(65536);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
    const parsed = JSON.parse(line) as { payload?: { cwd?: unknown } };
    return typeof parsed.payload?.cwd === "string" ? parsed.payload.cwd : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}
