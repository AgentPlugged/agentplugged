import type { ProjectionState } from "@agentplugged/protocol";
import { ErrorCode, MAIN_SESSION_AGENT } from "@agentplugged/protocol";
import { agentWriteContext, project } from "../agent-activity/agent-commands.js";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import type { EventDraft } from "../journal/state-store.js";
import { ARCHITECTURE_PATH } from "../phases/design-review.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyJournalView } from "../stories/story-start.js";
import { storyText } from "../stories/story-text.js";
import { folderKey, storyFolders } from "../trust/install-folders.js";
import { approvedArchitecture } from "../trust/planned-dependencies.js";
import { type DecisionGuards, decisionGuards } from "./write-decisions.js";
import { settle } from "./write-path.js";
import { pathsNamedIn, type ScopeEntry, widenedEntries } from "./write-scope.js";

/**
 * What the guard before a write knows of the product, read once and kept while the journal stays
 * where it is: the stories being built and where their working copies are, the
 * scope of each, and the checkable decisions of the approved architecture. Building it reads the
 * journal and the stories, which can take longer than a write may wait: the build goes on in the
 * background, the write that asked for it passes in doubt, and the next one finds it ready. While a
 * newer one is built, the last one read is served for everything that cannot wrongly refuse.
 */

/** How long an index is kept when the journal does not move (the stories' files may change). */
export const INDEX_TTL_MS = 10_000;

/** Whose a path is: a story's working copy, nobody's, or several stories' (they share the folder). */
export type Owner =
  | { readonly kind: "story"; readonly id: string; readonly root: string }
  | { readonly kind: "none" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "outside" };

export interface GuardIndex {
  readonly product: string;
  readonly journal: NonNullable<CommandContext["journal"]>;
  /** The path's owner: the story whose working copy holds it. */
  ownerOf(path: string): Owner;
  /** The scope of a story: the files its text names, plus what the creator added. */
  scopeOf(id: string): Promise<readonly ScopeEntry[]>;
  readonly decisions: DecisionGuards | undefined;
}

/** The index for the journal as it is now (`fresh`), and the last one read before it (`stale`). */
export interface Obtained {
  readonly fresh: Promise<GuardIndex | AgentPluggedError>;
  readonly stale: GuardIndex | undefined;
}

interface Entry {
  readonly head: string | null;
  readonly at: number;
  readonly ready: Promise<GuardIndex | AgentPluggedError>;
}

const cache = new WeakMap<object, Entry>();

/** The last index that was read whole, by journal: served while a newer one is read. */
const lastGood = new WeakMap<object, GuardIndex>();

/** The absolute path of `path` asked from `cwd` (or the root), with `/`. Undefined when it is not one. */
export function absolutePath(
  path: string,
  cwd: string | undefined,
  root: string,
): string | undefined {
  // The long-path prefixes of Windows (`\\?\C:\…`) name the same file as the plain spelling.
  const text = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/\/[?.]\//, "");
  const isAbsolute = text.startsWith("/") || /^[A-Za-z]:\//.test(text);
  const full = isAbsolute
    ? text
    : `${(cwd ?? root).replaceAll("\\", "/").replace(/\/+$/, "")}/${text}`;
  const drive = /^([A-Za-z]:)\//.exec(full)?.[1];
  const settled = settle(drive === undefined ? full : full.slice(3));
  if (settled === undefined) return undefined;
  if (drive !== undefined) return `${drive}/${settled}`;
  return `/${settled}`;
}

/** The part of `path` inside `root`, with the case the path was written in; undefined outside it. */
export function inside(
  path: string,
  root: string,
  platform: string | undefined,
): string | undefined {
  const key = folderKey(path, platform);
  const base = folderKey(root, platform);
  if (key === base) return "";
  if (!key.startsWith(`${base}/`)) return undefined;
  const written = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return written.slice(written.length - (key.length - base.length - 1));
}

/**
 * The product's own folder: the folder itself, or, when a session runs in the working copy of a
 * story (`<product>.worktrees/<story>`, where `story start` puts it), the product the copy belongs to.
 */
export function productRootOf(root: string): string {
  const text = root.replaceAll("\\", "/").replace(/\/+$/, "");
  const copy = /^(.*)\/([^/]+)\.worktrees\/[^/]+$/.exec(text);
  return copy === null ? root : `${copy[1]}/${copy[2]}`;
}

async function build(
  context: CommandContext,
  now: number,
): Promise<GuardIndex | AgentPluggedError> {
  try {
    return await read(context, now);
  } catch (error) {
    // Whatever went wrong while reading the product, the guard lets the write through in doubt.
    return error instanceof AgentPluggedError
      ? error
      : new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
          reason: "the write guard could not read the product",
        });
  }
}

async function read(context: CommandContext, now: number): Promise<GuardIndex | AgentPluggedError> {
  const target = await agentWriteContext(context, MAIN_SESSION_AGENT);
  if (target instanceof AgentPluggedError) return target;
  const given = context.projectRoot ?? context.chat?.project;
  const root = given === undefined ? undefined : productRootOf(given);
  const listing = await target.journal.list();
  const projection: ProjectionState = await project(context, target.config, listing);
  const state = projection.state;
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const building = new Set(storyJournalView(state, "0-0", now).building);
  const platform = context.platform;
  const folders =
    root === undefined
      ? new Map<string, { story: string; absolute: string }>()
      : storyFolders(root, stories, platform);
  const shared = [...building].filter((id) => stories[id]?.started?.worktree === ".").sort();
  const architecture = await approvedArchitecture(context, state).catch(() => undefined);
  const decisions =
    architecture === undefined ? undefined : decisionGuards(ARCHITECTURE_PATH, architecture);
  const scopes = new Map<string, Promise<readonly ScopeEntry[]>>();
  return {
    product: target.product,
    journal: target.journal,
    decisions,
    ownerOf(path) {
      if (root === undefined) return { kind: "none" };
      // A working copy of a story lives next to the product's folder (`<product>.worktrees/`).
      const key = folderKey(path, platform);
      const found = [...folders.entries()]
        .filter(([folder]) => key === folder || key.startsWith(`${folder}/`))
        .sort((a, b) => b[0].length - a[0].length)[0];
      if (found !== undefined) {
        // The copy of a story that is done holds nothing the guard watches.
        if (!building.has(found[1].story)) return { kind: "outside" };
        return { kind: "story", id: found[1].story, root: found[1].absolute };
      }
      if (inside(path, root, platform) === undefined) return { kind: "outside" };
      if (shared.length === 0) return { kind: "none" };
      if (shared.length > 1) return { kind: "ambiguous" };
      return { kind: "story", id: shared[0] as string, root };
    },
    scopeOf(id) {
      let scope = scopes.get(id);
      if (scope === undefined) {
        scope = storyText(context, state, id, now)
          .then((text) => [
            ...(text === undefined ? [] : pathsNamedIn(text.body)),
            ...widenedEntries(stories[id]?.scope_widened ?? []),
          ])
          .catch((error: unknown) => {
            // A reading that failed is tried again by the next write.
            scopes.delete(id);
            throw error;
          });
        scopes.set(id, scope);
      }
      return scope;
    },
  };
}

/**
 * The index for the journal as it is now, and the last one read before it. A build in progress is
 * shared by the writes that come while it runs, and goes on after a write gave up waiting for it.
 */
export async function guardIndex(context: CommandContext): Promise<Obtained> {
  const journal = context.journal;
  if (journal === undefined) {
    const error = new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: "no journal",
    });
    return { fresh: Promise.resolve(error), stale: undefined };
  }
  const head = await journal.head();
  const kept = cache.get(journal);
  if (kept !== undefined && kept.head === head && Date.now() - kept.at < INDEX_TTL_MS) {
    return { fresh: kept.ready, stale: lastGood.get(journal) };
  }
  const ready = build(context, (context.now ?? Date.now)());
  cache.set(journal, { head, at: Date.now(), ready });
  void ready.then((value) => {
    if (value instanceof AgentPluggedError) {
      // A build that failed is not kept: the next write tries again.
      if (cache.get(journal)?.ready === ready) cache.delete(journal);
    } else lastGood.set(journal, value);
  });
  return { fresh: ready, stale: lastGood.get(journal) };
}

/** An index to read the journal and place a path with, for a trace: the last one, else the new one. */
export async function anyIndex(context: CommandContext): Promise<GuardIndex | AgentPluggedError> {
  const got = await guardIndex(context);
  return got.stale ?? (await got.fresh);
}

/**
 * Writes an event of the guard (a refusal, a doubt) in the journal. Such an event changes nothing
 * the index reads, so the index stays valid across it: without this, every refusal would send the
 * next write to read the whole journal again, and past its budget. Only when the journal stood
 * where the index was read, as far as the head says.
 */
export async function appendOwn(
  journal: NonNullable<CommandContext["journal"]>,
  draft: EventDraft,
): Promise<void> {
  const kept = cache.get(journal);
  const before = kept === undefined ? undefined : await journal.head();
  await journal.append(draft);
  if (kept !== undefined && before === kept.head && cache.get(journal) === kept) {
    cache.set(journal, { head: await journal.head(), at: kept.at, ready: kept.ready });
  }
}

/** Forgets what was read (tests; a journal that changed under the engine). */
export function forgetGuardIndex(context: CommandContext): void {
  if (context.journal === undefined) return;
  cache.delete(context.journal);
  lastGood.delete(context.journal);
}
