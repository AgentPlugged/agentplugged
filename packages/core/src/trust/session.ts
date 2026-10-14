import {
  type EventEnvelope,
  type ExternalRead,
  type ExternalReadPayload,
  type MethodConfig,
  type RuleAction,
  type RuleValue,
  SESSION_EVENT_TYPES,
} from "@agentplugged/protocol";
import { truncate } from "../checkpoints/checkpoint-rules.js";
import type { CommandContext } from "../command.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { newUlid } from "../journal/ulid.js";
import { resolveRules } from "../rules/resolve-rules.js";
import { SYNC_MANIFEST_PATH } from "../sync/manifest.js";

/** The rules in force as a session keeps them: what they are, and when and from what they were read. */
interface CachedRules {
  readonly at: number;
  /** `method.yaml` and the sync manifest as they were: either changing reads the rules again. */
  readonly stamp: string;
  readonly rules: Readonly<Record<RuleAction, RuleValue>>;
  readonly mainBranch: string | undefined;
}

/**
 * One session of an AI tool: one `agentplugged` MCP server, which the
 * tool starts for each of its sessions. The reads it made only ever grow: nothing an agent calls
 * takes a read away or forgets an id. They are a trace (the provenance of what the
 * session writes, the history), never a reason to block. The rules it keeps are a cache, read again
 * when they may have changed.
 */
export class AgentSession {
  /** This server instance: an approval is scoped to the session that asked (`sessions`). */
  readonly instance: string;
  /** The tool's session ids its hooks gave (`${session_id}`): their reads in the journal count. */
  readonly #ids = new Set<string>();
  readonly #reads = new Map<string, ExternalRead>();
  #rules: CachedRules | undefined;
  /** The MCP client's name, as it introduced itself: the first one given stays. */
  #client: string | undefined;
  /** What the client did with the engine's forms, as seen in this session. */
  #form: "works" | "refused" | undefined;

  constructor(
    /** When the session opened (milliseconds). */
    readonly startedAt: number = Date.now(),
    /**
     * The name the launcher of the MCP server gives the session: it keeps it when it
     * moves the session to a newer engine, so an approval asked before the move still counts. A
     * name that is not `server:` then letters and digits is ignored.
     */
    instance?: string,
  ) {
    this.instance =
      instance !== undefined && /^server:[0-9A-Za-z]{16,64}$/.test(instance)
        ? instance
        : `server:${newUlid()}`;
  }

  /**
   * Notes the MCP client's name (`clientInfo.name` of its `initialize`): `claude-code` has the
   * hook that proves the chat's quotes. The first name given stays.
   */
  noteClient(name: string | undefined): void {
    const clean = name?.trim();
    if (this.#client === undefined && clean) this.#client = clean;
  }

  get client(): string | undefined {
    return this.#client;
  }

  /**
   * Notes what the client did with a form of the engine: `works` when the creator
   * answered it (the client shows forms), `refused` when the client refused it at once, before a
   * person could read it (the extension of VS Code does, 2.1.289). A form seen working stays so; a
   * refusal at once is kept until one works, so the engine stops sending a form that cannot be shown.
   */
  noteForm(outcome: "works" | "refused"): void {
    if (outcome === "works" || this.#form === undefined) this.#form = outcome;
  }

  /** What the client did with the engine's forms in this session, or undefined (not tried yet). */
  get form(): "works" | "refused" | undefined {
    return this.#form;
  }

  /** Learns one of the tool's session ids (a hook's `session_id`); empty ones are ignored. */
  learn(id: string | undefined): void {
    const clean = usableId(id);
    if (clean !== undefined) this.#ids.add(clean);
  }

  get ids(): readonly string[] {
    return [...this.#ids];
  }

  /** Every name of this session: the server instance, then the tool's session ids. */
  get identities(): readonly string[] {
    return [this.instance, ...this.#ids];
  }

  /** True when the session already has this read (same tool, same source). */
  hasRead(read: ExternalRead): boolean {
    return this.#reads.has(readKey(read));
  }

  /** Adds a read (once it is recorded); false when the session already had it. */
  addRead(read: ExternalRead): boolean {
    const key = readKey(read);
    if (this.#reads.has(key)) return false;
    this.#reads.set(key, { tool: read.tool, source: read.source });
    return true;
  }

  get reads(): readonly ExternalRead[] {
    return [...this.#reads.values()];
  }

  /** The rules kept, while fresh: read within `RULES_TTL_MS`, from the same files. */
  cachedRules(now: number, stamp: string): CachedRules | undefined {
    const cached = this.#rules;
    if (cached === undefined || cached.stamp !== stamp) return undefined;
    return now - cached.at >= 0 && now - cached.at < RULES_TTL_MS ? cached : undefined;
  }

  /** Keeps the rules just read. */
  rememberRules(rules: CachedRules): void {
    this.#rules = rules;
  }
}

const readKey = (read: ExternalRead) => `${read.tool}\u0000${read.source}`;

/** A tool session id as a hook gives it, or undefined when empty or not substituted. */
export function usableId(id: string | undefined): string | undefined {
  const clean = id?.trim();
  return clean && !clean.includes("${") ? clean : undefined;
}

/** How long a session keeps the rules it read (each read spawns Git): one minute. */
export const RULES_TTL_MS = 60_000;

/**
 * What a session is known to have read (for the provenance and the history, never to
 * block). `trusted` is true while it read no external content.
 */
export interface SessionTrust {
  readonly trusted: boolean;
  /** The external reads known: the session's, then those of its ids in the journal. */
  readonly reads: readonly ExternalRead[];
  /** The permission rules in force, read from the main branch. */
  readonly rules: Readonly<Record<RuleAction, RuleValue>>;
  /** The main branch's short name, when one was found (`push_main` names it). */
  readonly mainBranch: string | undefined;
  /** The session's names (`AgentSession.identities`); `unknown` without a session. */
  readonly identities: readonly string[];
}

/** The reads of the journal made under one of `ids` (a tool's session ids), in journal order. */
export function journalReads(
  events: Iterable<EventEnvelope>,
  ids: readonly string[],
): ExternalRead[] {
  if (ids.length === 0) return [];
  const wanted = new Set(ids);
  const reads: ExternalRead[] = [];
  for (const event of events) {
    if (event.type !== SESSION_EVENT_TYPES.externalRead || event.payload === undefined) continue;
    const payload = event.payload as Partial<ExternalReadPayload>;
    if (typeof payload.session !== "string" || !wanted.has(payload.session)) continue;
    if (typeof payload.tool !== "string" || typeof payload.source !== "string") continue;
    reads.push({ tool: payload.tool, source: payload.source });
  }
  return reads;
}

/** `method.yaml` and the sync manifest, as they are now: the rules' cache key. */
async function rulesStamp(context: CommandContext): Promise<string> {
  const { files } = context;
  const read = async (path: string) => ((await files.exists(path)) ? files.readText(path) : "");
  return `${await read(METHOD_CONFIG_PATH)}\u0000${await read(SYNC_MANIFEST_PATH)}`;
}

/**
 * The rules in force for a call: those the session keeps while fresh (one minute, same
 * `method.yaml` and sync manifest), else read again from the main branch (Git).
 */
async function rulesFor(
  context: CommandContext,
  config: MethodConfig,
): Promise<{ rules: Readonly<Record<RuleAction, RuleValue>>; mainBranch: string | undefined }> {
  const session = context.session;
  const now = (context.now ?? Date.now)();
  const stamp = session === undefined ? "" : await rulesStamp(context);
  const cached = session?.cachedRules(now, stamp);
  if (cached !== undefined) return cached;
  const resolved = await resolveRules(config, context.mainBranch);
  const fresh = { at: now, stamp, rules: resolved.rules, mainBranch: resolved.mainBranch };
  session?.rememberRules(fresh);
  return fresh;
}

/**
 * The trust of the calling session: untrusted once it read external
 * content (its own reads, and those the journal holds for its tool session ids, given by
 * `events`): a mark for the provenance of what it writes and for the history. Never from what an
 * agent declares about itself, except a read it adds. A call without a session
 * (`context.session` absent) is marked untrusted, by caution.
 */
export async function sessionTrust(
  context: CommandContext,
  config: MethodConfig,
  events: Iterable<EventEnvelope> = [],
): Promise<SessionTrust> {
  const { rules, mainBranch } = await rulesFor(context, config);
  const session = context.session;
  if (session === undefined) {
    // One name for every call without a session: a direct call (tests, scripts).
    const identities = ["unknown"];
    return { trusted: false, reads: [], rules, mainBranch, identities };
  }
  const reads = [...session.reads];
  for (const read of journalReads(events, session.ids)) {
    if (!reads.some((known) => known.tool === read.tool && known.source === read.source)) {
      reads.push(read);
    }
  }
  return {
    trusted: reads.length === 0,
    reads,
    rules,
    mainBranch,
    identities: session.identities,
  };
}

/** Removes control characters and collapses whitespace. */
export function cleanText(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.charCodeAt(0);
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? " " : char;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** The host of the first `http(s)` URL of `text` (lowercase, without credentials), or undefined. */
function hostOf(text: string, anywhere = false): string | undefined {
  const pattern = anywhere ? /https?:\/\/([^/?#\s'"]+)/i : /^https?:\/\/([^/?#\s]+)/i;
  const authority = pattern.exec(text)?.[1];
  if (authority === undefined) return undefined;
  const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  return host === "" ? undefined : host;
}

/** The program and its first argument of a shell command: `gh issue`, `git clone`, `curl`. */
function commandName(command: string): string {
  const words = command.split(" ").filter((word) => word !== "" && !/^[A-Za-z_]\w*=/.test(word));
  const [program, next] = words;
  if (program === undefined) return "shell";
  return next !== undefined && !next.startsWith("-") && !/[/:]/.test(next)
    ? `${program} ${next}`
    : program;
}

/**
 * The source of a read as it is recorded: the host of a URL; for a shell command (`Bash`), the
 * host of its first URL, else its program (`gh issue`); for a tool of another MCP server
 * (`mcp__github__get_issue`), its server and tool; `web search` for a search; else the text
 * given, cleaned. A value a hook could not substitute (`${…}`, empty) falls back on the tool.
 * Everything is cut at 200 UTF-16 units, never inside a surrogate pair.
 */
export function readSource(tool: string, raw: string | undefined): ExternalRead {
  const toolName = truncate(cleanText(tool), 200) || "unknown";
  const given = cleanText(raw ?? "");
  const usable = given !== "" && !given.includes("${");
  if (usable && (toolName === "Bash" || toolName === "PowerShell")) {
    const host = hostOf(given, true);
    return { tool: toolName, source: truncate(host ?? commandName(given), 200) };
  }
  if (usable) {
    const host = hostOf(given);
    if (host !== undefined) return { tool: toolName, source: truncate(host, 200) };
    if (toolName !== "WebSearch") return { tool: toolName, source: truncate(given, 200) };
  }
  if (toolName === "WebSearch") return { tool: toolName, source: "web search" };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp !== null) {
    return { tool: toolName, source: truncate(`${mcp[1]} (MCP: ${mcp[2]})`, 200) };
  }
  return { tool: toolName, source: toolName };
}
