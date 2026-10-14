import {
  CompleteDeferredInputSchema,
  CREATOR_OWNER,
  canonicalStoryId,
  DEFERRED_EVENT_TYPES,
  DeferredIdInputSchema,
  type DeferredOutcome,
  DeferredReasonSchema,
  DeferWorkInputSchema,
  deferredIdOf,
  ErrorCode,
  MAIN_SESSION_AGENT,
  type ProjectionState,
  StoryIdSchema,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  defined,
  project,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import {
  type Command,
  type CommandContext,
  type CommandResult,
  defineCommand,
  fail,
  ok,
} from "../command.js";
import { AgentPluggedError, unexpected } from "../errors.js";
import { datedAfter, humanTarget, trustedCreator, writeHuman } from "../human/human-commands.js";
import { localeSigner } from "../human/human-events.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import {
  agentMayClose,
  closingProblem,
  type DeferredItem,
  deferredItems,
  deferredView,
  findItem,
  openItem,
} from "./deferred-rules.js";

function invalid(command: string, field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    field,
    reason: `${command}: ${field}: ${reason}`,
  });
}

/** The owner of a new item: given, else the calling agent (`creator` for the main session). */
function ownerOf(agent: string, owner: string | undefined): string {
  return owner ?? (agent === MAIN_SESSION_AGENT ? CREATOR_OWNER : agent);
}

/** The state of the product as the journal holds it now (after a write). */
export async function currentState(context: CommandContext): Promise<ProjectionState["state"]> {
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) throw loaded;
  if (context.journal === undefined) throw unexpected("no journal is available here");
  return (await project(context, loaded.config, await context.journal.list())).state;
}

/**
 * An agent's command run again by `retry` once written, then checked by `verify` (the
 * deviations use it too).
 */
export function verified(
  command: Command<RecordedEvent>,
  verify: (
    written: RecordedEvent,
    state: ProjectionState["state"],
    input: Readonly<Record<string, unknown>>,
  ) => "ok" | "retry" | AgentPluggedError,
): Command<RecordedEvent> {
  return defineCommand<RecordedEvent>({
    ...command,
    async run(context, input): Promise<CommandResult<RecordedEvent>> {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await command.run(context, input);
        if (!result.ok) return result;
        try {
          const verdict = verify(result.value, await currentState(context), input);
          if (verdict === "ok") return result;
          if (verdict !== "retry") return fail(verdict);
        } catch (error) {
          if (error instanceof AgentPluggedError) return fail(error);
          throw error;
        }
      }
      return fail(unexpected(`${command.name}: the id stayed taken after 3 attempts`));
    },
  });
}

const recordDeferred = agentEventCommand({
  name: "defer_work",
  description:
    "Record work put off for later in the product's register of deferred work: a review finding sorted « defer » (`origin: review`, with the `story` it comes from) or a point you deliberately leave for later (`origin: deliberate`). Give a one-line `title` and an optional `detail` (no control characters), the `owner` who will treat it (an active agent or `creator`; yourself when absent, `creator` for `main`), the `locks`: the stories that must neither start nor merge until it is treated, and optionally the `phase` to treat it in. Returns its id (`deferred`: D-…), stable and never reused. Never leave deferred work in a note or a file only. Once treated, its owner or you call complete_deferred; an item the creator owns, the creator closes; only the creator drops an item.",
  inputSchema: DeferWorkInputSchema,
  events: ({ agent, title, detail, origin, story, owner, locks, phase }) => ({
    events: [
      {
        type: DEFERRED_EVENT_TYPES.recorded,
        story,
        payload: defined({
          title,
          detail,
          origin,
          owner: ownerOf(agent, owner),
          locks: [...(locks ?? [])],
          phase,
        }),
      },
    ],
  }),
  check: ({ agent, owner }, _state, { agents }) => {
    const chosen = ownerOf(agent, owner);
    if (chosen === CREATOR_OWNER || agents.has(chosen)) return undefined;
    return invalid("defer_work", "owner", `${chosen} is neither creator nor an active agent`);
  },
});

/**
 * `defer_work`: written, then read back. An id already taken by another item (the last 10
 * characters of two ULIDs alike) leaves the new event ignored: it is written again, with a fresh
 * id, up to 3 times.
 */
export const deferWorkCommand = verified(recordDeferred, (written, state) => {
  const id = deferredIdOf(written.id);
  const item = findItem(state, id);
  return !(item instanceof AgentPluggedError) && item.event === written.id ? "ok" : "retry";
});

const closeDeferred = agentEventCommand({
  name: "complete_deferred",
  description:
    "Mark an item of deferred work as treated: its id (`item`: D-…, from defer_work or get_state `deferred`) and how it was treated (`reason`, no control characters). The stories it locked may start and merge again. Only the item's owner (an agent) or the agent that recorded it closes it (else DEFERRED_NOT_ALLOWED); an item the creator owns, only the creator closes. Refused with DEFERRED_NOT_FOUND for an unknown id, DEFERRED_NOT_OPEN for an item already done or dropped; DEFERRED_CLOSING_IGNORED when the journal does not apply the closing (run it again after the journal is synced). You never drop an item: ask the creator.",
  inputSchema: CompleteDeferredInputSchema,
  events: ({ item, reason }) => ({
    events: [{ type: DEFERRED_EVENT_TYPES.closed, payload: { item, outcome: "done", reason } }],
  }),
  check: ({ agent, item }, state) => {
    const found = openItem(state, item);
    if (found instanceof AgentPluggedError) return found;
    if (agentMayClose(found, agent)) return undefined;
    return new AgentPluggedError(ErrorCode.DEFERRED_NOT_ALLOWED, "error.deferred_not_allowed", {
      item,
      agent,
      owner: found.owner,
    });
  },
});

/** `complete_deferred`: written, then read back: still open, `DEFERRED_CLOSING_IGNORED`. */
export const completeDeferredCommand = verified(closeDeferred, (written, state, input) => {
  const item = DeferredIdInputSchema.parse(input.item);
  return closingProblem(state, item, written.id) ?? "ok";
});

/** `deferred list`: the open items (and, with `all`, the closed ones), and the closed counts. */
export interface DeferredList {
  readonly action: "list";
  readonly story: string | null;
  readonly open: readonly DeferredItem[];
  /** With `all`: the closed items, in recording order; else null. */
  readonly closed: readonly DeferredItem[] | null;
  readonly done: number;
  readonly dropped: number;
}

/** `deferred show`: one item, whatever its status. */
export interface DeferredShown {
  readonly action: "show";
  readonly item: DeferredItem;
}

/** `deferred resolve|drop`: the closing written. */
export interface DeferredClosed {
  readonly action: "resolve" | "drop";
  readonly item: string;
  readonly title: string;
  readonly outcome: DeferredOutcome;
  readonly event: { readonly id: string; readonly at: string };
}

export type DeferredResult = DeferredList | DeferredShown | DeferredClosed;

const FIELDS: Readonly<Record<string, ReadonlySet<string>>> = {
  list: new Set(["action", "story", "all"]),
  show: new Set(["action", "item"]),
  resolve: new Set(["action", "item", "reason"]),
  drop: new Set(["action", "item", "reason"]),
};

/** The state of the product, read only: no key, nothing written. */
async function readState(context: CommandContext): Promise<ProjectionState["state"]> {
  if (!(await context.files.exists(METHOD_CONFIG_PATH))) throw methodNotInstalled();
  return currentState(context);
}

/**
 * `deferred`, the creator's command:
 * - `{ action: "list", story?, all? }`: the open items in recording order (those locking `story`
 *   when given), how many were done or dropped, and with `all` the closed items. Read only.
 * - `{ action: "show", item }`: one item, whatever its status. Read only.
 * - `{ action: "resolve" | "drop", item, reason }`: arguments checked first (`INVALID_ARGUMENTS`),
 *   then `deferred.closed` (`done` or `dropped`) written, signed by the creator's key (`locale`),
 *   at an interactive terminal only (`REVIEW_NOT_INTERACTIVE`). Never creates a key
 *   (`HUMAN_KEY_MISSING`), refuses a key the product does not trust (`HUMAN_KEY_UNENDORSED`), an
 *   unknown item (`DEFERRED_NOT_FOUND`) or a closed one (`DEFERRED_NOT_OPEN`), checked again under
 *   the journal lock. The closing is dated after the item's recording (a clock behind it never
 *   orders it first), then read back: not applied, `DEFERRED_CLOSING_IGNORED`.
 * Never exposed to agents.
 */
export const deferredCommand = defineCommand<DeferredResult>({
  name: "deferred",
  async run(context, input) {
    const action = String(input.action ?? "list");
    const fields = Object.hasOwn(FIELDS, action) ? FIELDS[action] : undefined;
    if (fields === undefined) {
      return fail(invalid("deferred", "action", `${action} (list, show, resolve, drop)`));
    }
    const extra = Object.keys(input).find((field) => !fields.has(field));
    if (extra !== undefined) return fail(invalid("deferred", extra, "unknown"));
    try {
      if (action === "list") {
        const story = input.story;
        if (story !== undefined && !StoryIdSchema.safeParse(story).success) {
          return fail(invalid("deferred", "story", `${String(story)} (<epic>-<story>, e.g. 2-6)`));
        }
        if (input.all !== undefined && typeof input.all !== "boolean") {
          return fail(invalid("deferred", "all", "true or false"));
        }
        const key = story === undefined ? undefined : canonicalStoryId(story as string);
        const state = await readState(context);
        const view = deferredView(state);
        const locking = (item: DeferredItem) => key === undefined || item.locks.includes(key);
        return ok({
          action: "list",
          story: key ?? null,
          open: view.open.filter(locking),
          closed:
            input.all === true
              ? deferredItems(state).filter((item) => item.status !== "open" && locking(item))
              : null,
          done: view.done,
          dropped: view.dropped,
        });
      }
      const id = DeferredIdInputSchema.safeParse(input.item);
      if (!id.success) return fail(invalid("deferred", "item", "expected D- then 10 characters"));
      if (action === "show") {
        const item = findItem(await readState(context), id.data);
        return item instanceof AgentPluggedError ? fail(item) : ok({ action: "show", item });
      }
      const reason = DeferredReasonSchema.safeParse(input.reason);
      if (!reason.success) {
        return fail(
          invalid("deferred", "reason", "1 to 1000 characters, without control characters"),
        );
      }
      const target = await humanTarget(context, "deferred");
      if (target instanceof AgentPluggedError) return fail(target);
      const outcome: DeferredOutcome = action === "drop" ? "dropped" : "done";
      const creator = await trustedCreator(context, target);
      if (creator instanceof AgentPluggedError) return fail(creator);
      const { key, state } = creator;
      const item = openItem(state, id.data);
      if (item instanceof AgentPluggedError) return fail(item);
      // Dated after the recording: a clock behind it never puts the closing first.
      const dated = datedAfter(context, item.recorded_at);
      const [event] = (
        await writeHuman(
          dated,
          target,
          key,
          [
            {
              type: DEFERRED_EVENT_TYPES.closed,
              payload: { item: item.id, outcome, reason: reason.data },
              signer: localeSigner(key),
            },
          ],
          async (written) => {
            const current = await project(context, target.config, written);
            const still = openItem(current.state, id.data);
            if (still instanceof AgentPluggedError) throw still;
          },
        )
      ).filter((written) => written.type === DEFERRED_EVENT_TYPES.closed);
      if (event === undefined) throw new Error("deferred: nothing was written");
      const applied = closingProblem(await currentState(context), item.id, event.id);
      if (applied !== undefined) return fail(applied);
      return ok({
        action: action as "resolve" | "drop",
        item: item.id,
        title: item.title,
        outcome,
        event: { id: event.id, at: event.at },
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The agents' tools of the register, exposed as MCP tools after the others. */
export const deferredAgentCommands = [deferWorkCommand, completeDeferredCommand] as const;
