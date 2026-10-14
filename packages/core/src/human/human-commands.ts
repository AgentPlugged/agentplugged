import { sha256 } from "@agentplugged/crypto";
import {
  type Assurance,
  CHAT_EVENT_TYPES,
  CHECKPOINT_EVENT_TYPES,
  type CheckpointResolvedPayload,
  ErrorCode,
  type EventEnvelope,
  HUMAN_EVENT_TYPES,
  type MethodConfig,
  type PresenceAlg,
  type PresenceCredential,
  type ProjectionState,
  RESOLUTION_DECISIONS,
  type ResolutionDecision,
} from "@agentplugged/protocol";
import { project } from "../agent-activity/agent-commands.js";
import { isReopenable } from "../chat/auto-apply.js";
import { byOpening } from "../checkpoints/checkpoint-rules.js";
import {
  answerable,
  mergeNotReadyKey,
  resolutionProblem,
  statusAt,
} from "../checkpoints/resolution-rules.js";
import { heldMergeCheckpoint, mergeGate, mergeHold } from "../ci/ci-rules.js";
import {
  type CommandContext,
  type CommandInput,
  type CommandResult,
  defineCommand,
  fail,
  type HumanAccess,
  ok,
} from "../command.js";
import {
  type ActionExecuted,
  afterExecution,
  executionEvent,
  executionProblem,
  executionStateProblem,
} from "../creator-actions/creator-action-execution.js";
import { type IntentPreview, intentPreviews } from "../docs/intent-preview.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig, productOf } from "../init/method-config.js";
import { deviceHeads, hashOf } from "../journal/prepare-event.js";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { createUlidFactory } from "../journal/ulid.js";
import { type MemoryPreview, memoryPreviews } from "../memory/preview.js";
import {
  afterMerge,
  type MergeResult,
  mergedEvent,
  mergeStory,
  mergesOn,
  notRecorded,
} from "../merge/story-merge.js";
import {
  ARCHITECTURE_SECURITY_REVIEW_PATH,
  type ArchitectureReview,
  citedReview,
} from "../phases/design-review.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import type { AgentState } from "../projection/agent-reducers.js";
import { budgetThresholdsOf } from "../projection/budget-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import type { HumanState, HumanTrust } from "../projection/human-reducers.js";
import { mergeHead } from "../review/merge-head.js";
import { sprintCheckpoints, sprintsOf } from "../sprints/sprint-rules.js";
import {
  type HumanDraft,
  type HumanSigner,
  linkPayload,
  localeSigner,
  prepareHumanEvents,
  presenceSigner,
} from "./human-events.js";
import { type HumanKey, loadHumanKey, readStoredPresence, storePresence } from "./human-key.js";
import type { PresenceAuthenticator } from "./presence.js";
import {
  exportKey,
  importKey,
  type KeyExportResult,
  type KeyImportResult,
  type KeySealResult,
  sealFiles,
} from "./product-key-commands.js";

/**
 * The creator's commands, reserved to the creator at a terminal: `review` (answer a
 * checkpoint) and `key presence` (link a Windows Hello credential to the creator's key). Neither
 * is ever exposed to agents (default audience `human`), and both refuse to run without an
 * interactive terminal (`REVIEW_NOT_INTERACTIVE`), before reading or writing anything.
 */

/**
 * `REVIEW_NOT_INTERACTIVE`: only the creator, at a terminal, answers or links. The one builder of
 * this error: core's commands and the CLI's own check before anything is read.
 */
export function reviewNotInteractive(command: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.REVIEW_NOT_INTERACTIVE, "error.review_not_interactive", {
    command,
  });
}

function unavailable(what: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
    reason: `no ${what} is available here`,
  });
}

function invalid(command: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command,
    reason: `${command}: ${reason}`,
  });
}

/** What a creator's command needs: the product, its journal and the creator's key access. */
export interface HumanTarget {
  readonly product: string;
  readonly journal: StateStore;
  readonly config: MethodConfig;
  readonly human: HumanAccess;
}

export async function humanTarget(
  context: CommandContext,
  command: string,
): Promise<HumanTarget | AgentPluggedError> {
  if (context.interactive !== true) return reviewNotInteractive(command);
  const { files } = context;
  if (!(await files.exists(METHOD_CONFIG_PATH))) return methodNotInstalled();
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const journal = context.journal;
  if (journal === undefined) return unavailable("journal");
  const human = context.human;
  if (human === undefined) return unavailable("keychain");
  const product = await productOf(loaded.config, journal);
  if (product instanceof AgentPluggedError) return product;
  return { product, journal, config: loaded.config, human };
}

function humansOf(state: ProjectionState["state"]): Record<string, HumanState> {
  return (state.humans as Record<string, HumanState> | undefined) ?? {};
}

/** Where the creator's `presence` assurance stands in this product. */
export type PresenceStatus =
  /** A credential of this machine is linked in this journal: high risks are signed `presence`. */
  | "linked"
  /** A credential exists on this machine, not linked in this journal yet (`key presence`). */
  | "not_linked"
  /** Windows Hello is available, with no credential yet (`key presence`). */
  | "no_credential"
  /** Out of reach (another system, Windows Hello not configured): `locale` only. */
  | "unavailable";

export interface PresenceState {
  readonly status: PresenceStatus;
  /** Why it is unavailable (`platform`, `unsupported`, `not_configured`, `disabled`). */
  readonly reason?: string;
  /** The credential to sign with, when `linked`. */
  readonly credential?: PresenceCredential;
}

async function presenceState(
  human: HumanAccess,
  device: string | undefined,
  state: ProjectionState["state"],
): Promise<PresenceState> {
  const authenticator = human.presence;
  if (authenticator === undefined) return { status: "unavailable", reason: "unsupported" };
  const availability = await authenticator.availability();
  if (!availability.available) return { status: "unavailable", reason: availability.reason };
  const stored = await readStoredPresence(human.keys);
  if (stored === undefined) return { status: "no_credential" };
  const linked =
    device !== undefined &&
    (humansOf(state)[device]?.presence ?? []).some(
      (entry) => entry.credential_id === stored.credential_id,
    );
  return linked ? { status: "linked", credential: stored } : { status: "not_linked" };
}

function keyLock(human: HumanAccess) {
  return human.lock === undefined ? {} : { lock: human.lock };
}

/** The creator's events after their head in this journal, then written with `precondition`. */
export async function writeHuman(
  context: CommandContext,
  target: HumanTarget,
  key: HumanKey,
  drafts: readonly HumanDraft[],
  precondition?: (listing: JournalListing) => Promise<void>,
): Promise<readonly EventEnvelope[]> {
  const listing = await target.journal.list();
  const now = context.now ?? Date.now;
  const events = await prepareHumanEvents({
    key,
    drafts,
    deviceHead: deviceHeads(listing.events).get(key.device) ?? null,
    product: target.product,
    newId: createUlidFactory({ now }),
    now,
  });
  return target.journal.appendHuman(events, precondition === undefined ? {} : { precondition });
}

/**
 * The creator's key of this machine (never created here) and the state of the journal, once the key
 * is trusted; else why it is not (`HUMAN_KEY_MISSING`, `HUMAN_KEY_UNENDORSED`).
 */
export async function trustedCreator(
  context: CommandContext,
  target: HumanTarget,
): Promise<{ key: HumanKey; state: ProjectionState["state"] } | AgentPluggedError> {
  const key = await loadHumanKey(target.human.keys, { create: false });
  if (key === undefined) return humanKeyMissing();
  const { state } = await project(context, target.config, await target.journal.list());
  return trustProblem(state, key.device) ?? { key, state };
}

/** The context with a clock that never runs behind `at`: what it writes is dated after it. */
export function datedAfter(context: CommandContext, at: string): CommandContext {
  const clock = context.now ?? Date.now;
  const floor = Date.parse(at) + 1;
  return { ...context, now: () => Math.max(clock(), floor) };
}

/** `HUMAN_KEY_MISSING`: this machine has no creator's key, and this command never creates one. */
export function humanKeyMissing(): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.HUMAN_KEY_MISSING, "error.human_key_missing", {});
}

/**
 * Why `device` cannot sign as a trusted creator in this product, or undefined: its key is pending
 * (`HUMAN_KEY_UNENDORSED`), or not registered here while another creator's key already is (it
 * would be pending). Without any creator's key in the journal, it becomes the root key.
 */
export function trustProblem(
  state: ProjectionState["state"],
  device: string,
): AgentPluggedError | undefined {
  const humans = humansOf(state);
  const own = humans[device];
  const pending = own === undefined ? Object.keys(humans).length > 0 : own.trust === "pending";
  return pending
    ? new AgentPluggedError(ErrorCode.HUMAN_KEY_UNENDORSED, "error.human_key_unendorsed", {
        device,
      })
    : undefined;
}

/** The creator's keys waiting for an endorsement, in registration order. */
export interface PendingKey {
  readonly device: string;
  readonly registered_at: string;
}

function pendingKeys(state: ProjectionState["state"]): PendingKey[] {
  return Object.values(humansOf(state))
    .filter((human) => human.trust === "pending")
    .map((human) => ({ device: human.device, registered_at: human.registered_at }));
}

/** A checkpoint id as typed (`g-7m2k9qx4tb` too): ids are uppercase. */
function checkpointIdOfInput(value: unknown): string {
  return String(value).trim().toUpperCase();
}

// --- review ---------------------------------------------------------------------------------

/** `review` with `action: list`: the checkpoints the creator can answer, and how they sign. */
export interface ReviewList {
  readonly action: "list";
  /**
   * Open checkpoints (and waived ones whose deadline is past by the clock, shown open again),
   * in opening order.
   */
  readonly checkpoints: readonly CheckpointState[];
  /** The creator's device on this machine. */
  readonly device: string;
  readonly presence: PresenceState;
  /** Creator keys waiting for an endorsement (`key endorse`): a notice. */
  readonly pending: readonly PendingKey[];
  /**
   * The security review each listed end of the design phase cites, as Chloé submitted
   * it (verdict and counts), by checkpoint id. Absent when no listed checkpoint cites one.
   */
  readonly security_reviews?: Readonly<Record<string, ArchitectureReview | null>>;
  /**
   * The story intents each listed `document` checkpoint would freeze, by checkpoint id (story
   * 3.8). Absent without a Git reader, or when Git could not read the blobs.
   */
  readonly intents?: Readonly<Record<string, readonly IntentPreview[]>>;
  /**
   * What each listed `memory` checkpoint contains, decrypted here with the product
   * key: the checkpoint itself holds counts only. Absent when this machine lacks the key.
   */
  readonly memory?: Readonly<Record<string, MemoryPreview>>;
}

/** `review` with `action: resolve`: the answer written. */
export interface ReviewResolved {
  readonly action: "resolve";
  readonly checkpoint: string;
  readonly decision: ResolutionDecision;
  readonly event: { readonly id: string; readonly at: string };
  /** The assurance of the signature: `presence` or `locale`. */
  readonly assurance: Assurance;
  /** The checkpoint asked for presence, and the answer was signed `locale`: why. */
  readonly presenceFallback?: PresenceStatus;
  readonly presenceReason?: string;
  /** The creator's action the approval carried out. */
  readonly executed?: ActionExecuted;
  /** The story the engine merged once its merge checkpoint was approved. */
  readonly merged?: MergeResult;
}

export type ReviewResult = ReviewList | ReviewResolved | ReviewReopened;

const RESOLVE_FIELDS = new Set([
  "action",
  "checkpoint",
  "decision",
  "option",
  "note",
  "waiver_until",
]);

/**
 * `review`: `{ action: "list", checkpoint? }` lists the checkpoints to answer (only `checkpoint`
 * when given, matched whatever its case: `CHECKPOINT_NOT_FOUND` or `CHECKPOINT_NOT_OPEN` when it
 * cannot be answered); `{ action: "resolve", checkpoint, decision, option?, note?, waiver_until? }`
 * writes the creator's answer, `checkpoint.resolved` (`source: terminal`), signed by the
 * creator's key: `presence` when the checkpoint asks for it and a credential is linked here (the
 * prompt shows what is signed and its fingerprint first), else `locale` (said in the result).
 * Never creates a key (`HUMAN_KEY_MISSING`), and refuses a key this product does not trust yet
 * (`HUMAN_KEY_UNENDORSED`). The confirmations themselves (Enter and 10 s to undo, typing the id)
 * belong to the terminal, before this call. The checkpoint must still be answerable when written
 * (under the journal lock); expiry of a waiver follows the clock.
 */
export const reviewCommand = defineCommand<ReviewResult>({
  name: "review",
  async run(context, input) {
    const target = await humanTarget(context, "review");
    if (target instanceof AgentPluggedError) return fail(target);
    const now = context.now ?? Date.now;
    try {
      const key = await loadHumanKey(target.human.keys, { create: false });
      if (key === undefined) return fail(humanKeyMissing());
      if (input.action === "list") {
        const listing = await target.journal.list();
        const { state } = await project(context, target.config, listing);
        const at = now();
        // A story's merge checkpoint waits for a green CI and a done review.
        // An automatic application is reopened by its id (`review <G-id>`) only: the
        // list stays the checkpoints that wait for the creator.
        let checkpoints = Object.values(checkpointsOf(state))
          .filter((checkpoint) => answerable(checkpoint, at))
          .filter((checkpoint) => !heldMergeCheckpoint(state, checkpoint))
          .sort(byOpening);
        // `review <G-id>`: that checkpoint only, when it can be answered.
        if (input.checkpoint !== undefined) {
          const one = findAnswerable(
            checkpointsOf(state),
            checkpointIdOfInput(input.checkpoint),
            at,
            true,
          );
          if (one instanceof AgentPluggedError) return fail(one);
          if (heldMergeCheckpoint(state, one) && one.story !== null) {
            const gate = mergeGate(state, one.story);
            return fail(
              new AgentPluggedError(ErrorCode.MERGE_NOT_READY, mergeNotReadyKey(gate.fast_track), {
                checkpoint: one.id,
                story: one.story,
                ci: gate.ci,
                review: gate.review,
                deviations: gate.deviations,
                course: gate.course ?? 0,
                untriaged: gate.untriaged,
                ...(gate.fast_track === undefined ? {} : { fast_track: gate.fast_track }),
              }),
            );
          }
          checkpoints = [one];
        }
        // The review an end of the design cites, with its verdict (null: none Chloé submitted).
        const agents = (state.agents as Record<string, AgentState> | undefined) ?? {};
        const reviews = Object.fromEntries(
          checkpoints
            .filter(
              (checkpoint) =>
                checkpoint.type === "phase_end" &&
                checkpoint.phase === "design" &&
                checkpoint.documents.some(
                  (document) =>
                    document.path.replaceAll("\\", "/") === ARCHITECTURE_SECURITY_REVIEW_PATH,
                ),
            )
            .map((checkpoint) => [
              checkpoint.id,
              citedReview(agents, checkpoint.documents) ?? null,
            ]),
        );
        // What approving would freeze: best effort, the card shows without it.
        let intents: Record<string, IntentPreview[]> | undefined;
        if (context.docsBase !== undefined) {
          intents = await intentPreviews(
            context.docsBase,
            checkpoints,
            Object.values(checkpointsOf(state)),
            at,
          ).catch(() => undefined);
        }
        // What a change of the memory contains, best effort like the intents.
        const product = target.config.product_id ?? (await target.journal.productId());
        let previews: Record<string, MemoryPreview> | undefined;
        if (product !== null && checkpoints.some((checkpoint) => checkpoint.type === "memory")) {
          const found = await memoryPreviews(
            context,
            target.config,
            product,
            listing,
            checkpoints,
          ).catch(() => ({}));
          if (Object.keys(found).length > 0) previews = found;
        }
        return ok({
          action: "list",
          checkpoints: checkpoints.map((checkpoint) => ({
            ...checkpoint,
            status: statusAt(checkpoint, at),
          })),
          device: key.device,
          presence: await presenceState(target.human, key.device, state),
          pending: pendingKeys(state),
          ...(Object.keys(reviews).length === 0 ? {} : { security_reviews: reviews }),
          ...(intents === undefined ? {} : { intents }),
          ...(previews === undefined ? {} : { memory: previews }),
        });
      }
      if (input.action === "reopen") return await reopen(context, target, key, input, now);
      if (input.action !== "resolve") {
        return fail(invalid("review", "action (list, resolve, reopen)"));
      }
      const extra = Object.keys(input).find((field) => !RESOLVE_FIELDS.has(field));
      if (extra !== undefined) return fail(invalid("review", extra));
      const { decision } = input;
      if (typeof input.checkpoint !== "string") return fail(invalid("review", "checkpoint"));
      const id = checkpointIdOfInput(input.checkpoint);
      if (
        typeof decision !== "string" ||
        !(RESOLUTION_DECISIONS as readonly string[]).includes(decision)
      ) {
        return fail(invalid("review", `decision (${RESOLUTION_DECISIONS.join(", ")})`));
      }
      const text = (field: string) =>
        typeof input[field] === "string" && (input[field] as string).trim() !== ""
          ? (input[field] as string).trim()
          : undefined;
      const payload: CheckpointResolvedPayload = {
        checkpoint: id,
        decision: decision as ResolutionDecision,
        ...(text("option") === undefined ? {} : { option: text("option") }),
        ...(text("note") === undefined ? {} : { note: text("note") }),
        ...(text("waiver_until") === undefined ? {} : { waiver_until: text("waiver_until") }),
        source: "terminal",
      };

      // A pull request the creator already merged on the forge is recorded first (dynamic import: no cycle).
      await (await import("../merge/forge-follow.js")).followForge(context, { force: true });
      const listing = await target.journal.list();
      const { state } = await project(context, target.config, listing);
      const untrusted = trustProblem(state, key.device);
      if (untrusted !== undefined) return fail(untrusted);
      const checkpoint = findAnswerable(checkpointsOf(state), id, now());
      if (checkpoint instanceof AgentPluggedError) return fail(checkpoint);
      // A sprint checkpoint is never waived.
      const sprint = sprintCheckpoints(sprintsOf(state)).has(checkpoint.id);
      // Nor a budget checkpoint.
      const budget = Object.values(budgetThresholdsOf(state)).some((entries) =>
        entries.some((entry) => entry.checkpoint === checkpoint.id),
      );
      // The gate checks the branch's head as Git reads it now.
      const head = await mergeHead(context, state, checkpoint);
      const problem = resolutionProblem(
        {
          ...checkpoint,
          sprint,
          budget,
          ...mergeHold(state, checkpoint, head === undefined ? {} : { head }),
        },
        payload,
        now(),
      );
      if (problem !== undefined) return fail(problem);

      let signer: HumanSigner = localeSigner(key);
      let fallback: PresenceState | undefined;
      if (checkpoint.confirmation.includes("presence")) {
        const presence = await presenceState(target.human, key.device, state);
        if (presence.status === "linked" && presence.credential !== undefined) {
          signer = presenceSigner(
            target.human.presence as PresenceAuthenticator,
            presence.credential,
            target.human.onPresencePrompt,
          );
        } else fallback = presence;
      }
      // An approved story's merge checkpoint: the answer signed first (the presence
      // it asks for), then merged at the forge, then the answer and `story.merged` written.
      if (mergesOn(checkpoint, payload.decision)) {
        return await resolveMerge(context, target, key, state, checkpoint, {
          payload,
          signer,
          head,
          now,
          ...(fallback === undefined ? {} : { fallback }),
        });
      }
      // An approved creator's action: carried out by the engine in the same write,
      // signed by the creator's key too (`locale`: the approval itself carries the presence).
      const record =
        payload.decision === "approved" ? (checkpoint.creator_action ?? undefined) : undefined;
      const drafts: HumanDraft[] = [
        {
          type: CHECKPOINT_EVENT_TYPES.resolved,
          payload: { ...payload },
          signer,
          ...storyOf(checkpoint),
        },
      ];
      if (record !== undefined) {
        const refused =
          executionStateProblem(record, state) ??
          (await executionProblem(context, state, id, record));
        if (refused !== undefined) return fail(refused);
        const { type, story, payload: carried } = executionEvent(id, record, "terminal");
        drafts.push({
          type,
          payload: carried,
          signer: localeSigner(key),
          ...(story === undefined ? {} : { story }),
        });
      }
      const [event] = (
        await writeHuman(context, target, key, drafts, async (written) => {
          const current = await project(context, target.config, written);
          const still = findAnswerable(checkpointsOf(current.state), id, now());
          if (still instanceof AgentPluggedError) throw still;
          if (record === undefined) return;
          const again = executionStateProblem(record, current.state);
          if (again !== undefined) throw again;
        })
      ).filter((written) => written.type === CHECKPOINT_EVENT_TYPES.resolved);
      if (event === undefined) throw new Error("review: nothing was written");
      const executed = record === undefined ? undefined : await afterExecution(context, id, record);
      if (executed instanceof AgentPluggedError) return fail(executed);
      return ok({
        action: "resolve",
        checkpoint: id,
        decision: payload.decision,
        event: { id: event.id, at: event.at },
        assurance: signer.assurance,
        ...(fallback === undefined ? {} : { presenceFallback: fallback.status }),
        ...(fallback?.reason === undefined ? {} : { presenceReason: fallback.reason }),
        ...(executed === undefined ? {} : { executed }),
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/**
 * `review` approving a story's merge checkpoint: the creator's answer is signed first
 * (with the presence the checkpoint asks for: a presence refused merges nothing), then the engine
 * merges the story's pull request at the forge, then signs `story.merged` (`locale`) chained right
 * after the answer, and writes both, checked again under the journal lock. A write refused after
 * the merge: `MERGE_FAILED` `not_recorded` (answer again: the merge is then recorded). Then the
 * story's worktree is removed.
 */
async function resolveMerge(
  context: CommandContext,
  target: HumanTarget,
  key: HumanKey,
  state: ProjectionState["state"],
  checkpoint: CheckpointState,
  answer: {
    readonly payload: CheckpointResolvedPayload;
    readonly signer: HumanSigner;
    readonly head: string | undefined;
    readonly now: () => number;
    readonly fallback?: PresenceState;
  },
) {
  const { payload, signer, head, now, fallback } = answer;
  const listing = await target.journal.list();
  const newId = createUlidFactory({ now });
  const story = storyOf(checkpoint);
  const answered = await prepareHumanEvents({
    key,
    drafts: [{ type: CHECKPOINT_EVENT_TYPES.resolved, payload: { ...payload }, signer, ...story }],
    deviceHead: deviceHeads(listing.events).get(key.device) ?? null,
    product: target.product,
    newId,
    now,
  });
  const last = answered.at(-1);
  if (last === undefined) throw new Error("review: nothing was signed");
  const merge = await mergeStory(context, target.config, state, checkpoint, head);
  if (merge instanceof AgentPluggedError) return fail(merge);
  const recorded = mergedEvent(merge, "terminal");
  const merged = await prepareHumanEvents({
    key,
    drafts: [
      { type: recorded.type, payload: recorded.payload, signer: localeSigner(key), ...story },
    ],
    deviceHead: { id: last.id, hash: hashOf(last) },
    product: target.product,
    newId,
    now,
  });
  let written: readonly EventEnvelope[];
  try {
    written = await target.journal.appendHuman([...answered, ...merged], {
      precondition: async (current) => {
        const projected = await project(context, target.config, current);
        const still = findAnswerable(checkpointsOf(projected.state), checkpoint.id, now());
        if (still instanceof AgentPluggedError) throw still;
        // The gate still open (a deviation reported meanwhile would make the answer ignored).
        const held = resolutionProblem(
          {
            ...still,
            ...mergeHold(projected.state, still, head === undefined ? {} : { head }),
          },
          payload,
          now(),
        );
        if (held !== undefined) throw held;
      },
    });
  } catch (error) {
    if (error instanceof AgentPluggedError) return fail(notRecorded(merge, error));
    throw error;
  }
  const event = written.find((entry) => entry.type === CHECKPOINT_EVENT_TYPES.resolved);
  if (event === undefined) throw new Error("review: nothing was written");
  return ok({
    action: "resolve" as const,
    checkpoint: checkpoint.id,
    decision: payload.decision,
    event: { id: event.id, at: event.at },
    assurance: signer.assurance,
    ...(fallback === undefined ? {} : { presenceFallback: fallback.status }),
    ...(fallback?.reason === undefined ? {} : { presenceReason: fallback.reason }),
    merged: await afterMerge(context, merge),
  });
}

function storyOf(checkpoint: CheckpointState): { story?: string } {
  return checkpoint.story === null ? {} : { story: checkpoint.story };
}

/**
 * The checkpoint `id`, answerable at `now` (milliseconds): else `CHECKPOINT_NOT_FOUND` or
 * `CHECKPOINT_NOT_OPEN`.
 */
function findAnswerable(
  checkpoints: Record<string, CheckpointState>,
  id: string,
  now: number,
  /** An automatic application counts too: the creator can reopen it. */
  reopenable = false,
): CheckpointState | AgentPluggedError {
  if (!Object.hasOwn(checkpoints, id)) {
    return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", {
      checkpoint: id,
    });
  }
  const checkpoint = checkpoints[id] as CheckpointState;
  if (!answerable(checkpoint, now) && !(reopenable && isReopenable(checkpoint))) {
    return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_OPEN, "error.checkpoint_not_open", {
      checkpoint: id,
      status: checkpoint.status,
    });
  }
  return checkpoint;
}

/** `review` with `action: reopen`: the automatic application cancelled. */
export interface ReviewReopened {
  readonly action: "reopen";
  readonly checkpoint: string;
  readonly event: { readonly id: string; readonly at: string };
}

/**
 * `review` `{ action: "reopen", checkpoint }`: cancels a checkpoint the engine
 * answered on its own at the `auto` level, `checkpoint.reopened` (`source: terminal`), signed by
 * the creator's key (`locale`: a reopening only makes the checkpoint open again). The checkpoint
 * must still be an automatic application when written (`CHECKPOINT_NOT_REOPENABLE`).
 */
async function reopen(
  context: CommandContext,
  target: HumanTarget,
  key: HumanKey,
  input: CommandInput,
  now: () => number,
): Promise<CommandResult<ReviewResult>> {
  const extra = Object.keys(input).find((field) => field !== "action" && field !== "checkpoint");
  if (extra !== undefined) return fail(invalid("review", extra));
  if (typeof input.checkpoint !== "string") return fail(invalid("review", "checkpoint"));
  const id = checkpointIdOfInput(input.checkpoint);
  const reopenable = (state: ProjectionState["state"]): AgentPluggedError | undefined => {
    const checkpoints = checkpointsOf(state);
    if (!Object.hasOwn(checkpoints, id)) {
      return new AgentPluggedError(ErrorCode.CHECKPOINT_NOT_FOUND, "error.checkpoint_not_found", {
        checkpoint: id,
      });
    }
    const checkpoint = checkpoints[id] as CheckpointState;
    const stories = (state.stories as Record<string, { merged?: unknown }> | undefined) ?? {};
    const mergeDone =
      checkpoint.type === "story" &&
      checkpoint.source === "merge" &&
      checkpoint.story !== null &&
      stories[checkpoint.story]?.merged !== undefined;
    return isReopenable(checkpoint) && !mergeDone
      ? undefined
      : new AgentPluggedError(
          ErrorCode.CHECKPOINT_NOT_REOPENABLE,
          "error.checkpoint_not_reopenable",
          {
            checkpoint: id,
            status: statusAt(checkpoint, now()),
          },
        );
  };
  const listing = await target.journal.list();
  const { state } = await project(context, target.config, listing);
  const untrusted = trustProblem(state, key.device);
  if (untrusted !== undefined) return fail(untrusted);
  const refused = reopenable(state);
  if (refused !== undefined) return fail(refused);
  const checkpoint = checkpointsOf(state)[id] as CheckpointState;
  const [event] = (
    await writeHuman(
      context,
      target,
      key,
      [
        {
          type: CHAT_EVENT_TYPES.reopened,
          payload: { checkpoint: id, source: "terminal" },
          signer: localeSigner(key),
          ...storyOf(checkpoint),
        },
      ],
      async (written) => {
        const again = reopenable((await project(context, target.config, written)).state);
        if (again !== undefined) throw again;
      },
    )
  ).filter((written) => written.type === CHAT_EVENT_TYPES.reopened);
  if (event === undefined) throw new Error("review: nothing was written");
  return ok({ action: "reopen", checkpoint: id, event: { id: event.id, at: event.at } });
}

// --- key ------------------------------------------------------------------------------------

export const KEY_ACTIONS = ["presence", "endorse", "export", "import", "seal"] as const;

/** What `key presence` did. */
export interface KeyPresenceResult {
  readonly action: "presence";
  /** Linked now, linked already in this journal, or out of reach (`locale` stays). */
  readonly status: "linked" | "already_linked" | "unavailable";
  readonly reason?: string;
  readonly device?: string;
  readonly credential_id?: string;
  readonly alg?: PresenceAlg;
  /** True when the credential was created by this run (one prompt more). */
  readonly created?: boolean;
}

/** What `key endorse` did: the keys waiting (no device given), or the key endorsed. */
export type KeyEndorseResult =
  | { readonly action: "endorse"; readonly status: "list"; readonly pending: readonly PendingKey[] }
  | { readonly action: "endorse"; readonly status: "endorsed"; readonly device: string };

export type KeyResult =
  | KeyPresenceResult
  | KeyEndorseResult
  | KeyExportResult
  | KeyImportResult
  | KeySealResult;

/**
 * `key presence [--reset]`: protects the creator's validations with Windows Hello. Creates the
 * platform credential once per machine (a prompt; its public part is kept in the keychain) — or
 * again with `reset`, when the stored one no longer works — then writes `human.presence_linked`
 * in this journal (`human.key_registered` first when needed), signed both by the credential (a
 * second prompt, showing what is signed and its fingerprint) and, in its payload, by the `locale`
 * key. Out of reach: `status: unavailable`, nothing is written.
 *
 * `key endorse [<human:…>]`: without a device, lists the creator keys waiting for an
 * endorsement; with one, a trusted creator endorses it (`human.key_endorsed`, signed by the
 * `locale` key): its answers count from then on.
 *
 * `key export` and `key import`: the product key, exported under a passphrase on a
 * machine that holds it, imported on another (`product-key-commands.ts`).
 */
export const keyCommand = defineCommand<KeyResult>({
  name: "key",
  async run(context, input) {
    if (input.action === "endorse") return endorse(context, input);
    // The product key: at the creator's terminal only, like every `key` action.
    if (input.action === "export" || input.action === "import" || input.action === "seal") {
      if (context.interactive !== true) return fail(reviewNotInteractive("key"));
      if (input.action === "seal") return sealFiles(context);
      return input.action === "export" ? exportKey(context) : importKey(context, input);
    }
    if (input.action !== "presence") {
      return fail(invalid("key", `${String(input.action ?? "")} (${KEY_ACTIONS.join(", ")})`));
    }
    const target = await humanTarget(context, "key");
    if (target instanceof AgentPluggedError) return fail(target);
    const authenticator = target.human.presence;
    try {
      const availability =
        authenticator === undefined
          ? { available: false as const, reason: "unsupported" }
          : await authenticator.availability();
      if (!availability.available || authenticator === undefined) {
        return ok({
          action: "presence",
          status: "unavailable",
          reason: availability.available ? "unsupported" : availability.reason,
        });
      }
      const key = (await loadHumanKey(target.human.keys, keyLock(target.human))) as HumanKey;
      const listing = await target.journal.list();
      const { state } = await project(context, target.config, listing);
      const untrusted = trustProblem(state, key.device);
      if (untrusted !== undefined) return fail(untrusted);
      let credential =
        input.reset === true
          ? undefined
          : await readStoredPresence(target.human.keys, { confirmAbsence: true });
      const created = credential === undefined;
      if (credential === undefined) {
        try {
          credential = await authenticator.create({
            id: sha256(key.publicKey).slice(0, 16),
            name: "agentplugged",
            displayName: `AgentPlugged (${key.device})`,
          });
        } catch (error) {
          if (error instanceof AgentPluggedError) throw error;
          throw new AgentPluggedError(ErrorCode.CANCELLED, "error.presence_failed", {
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        await storePresence(target.human.keys, credential);
      }
      const linkedHere = (humansOf(state)[key.device]?.presence ?? []).some(
        (entry) => entry.credential_id === credential?.credential_id,
      );
      const described = {
        device: key.device,
        credential_id: credential.credential_id,
        alg: credential.alg,
        created,
      };
      if (linkedHere) return ok({ action: "presence", status: "already_linked", ...described });
      await writeHuman(context, target, key, [
        {
          type: HUMAN_EVENT_TYPES.presenceLinked,
          payload: { ...(await linkPayload(key, credential)) },
          signer: presenceSigner(authenticator, credential, target.human.onPresencePrompt),
        },
      ]);
      return ok({ action: "presence", status: "linked", ...described });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

async function endorse(
  context: CommandContext,
  input: Readonly<Record<string, unknown>>,
): Promise<CommandResult<KeyResult>> {
  const target = await humanTarget(context, "key");
  if (target instanceof AgentPluggedError) return fail(target);
  try {
    const listing = await target.journal.list();
    const { state } = await project(context, target.config, listing);
    const pending = pendingKeys(state);
    if (input.device === undefined) return ok({ action: "endorse", status: "list", pending });
    const device = String(input.device).trim();
    const key = await loadHumanKey(target.human.keys, { create: false });
    if (key === undefined) return fail(humanKeyMissing());
    const untrusted = trustProblem(state, key.device);
    if (untrusted !== undefined) return fail(untrusted);
    const candidate = humansOf(state)[device];
    if (candidate === undefined || candidate.trust !== "pending") {
      return fail(
        new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
          command: "key",
          field: "device",
          reason: `key endorse: ${device} is not a creator key waiting for an endorsement`,
          reason_key: "reason.key.not_pending",
        }),
      );
    }
    await writeHuman(context, target, key, [
      {
        type: HUMAN_EVENT_TYPES.keyEndorsed,
        payload: { device, public_key: candidate.public_key },
        signer: localeSigner(key),
      },
    ]);
    return ok({ action: "endorse", status: "endorsed", device });
  } catch (error) {
    if (error instanceof AgentPluggedError) return fail(error);
    throw error;
  }
}

// --- init -----------------------------------------------------------------------------------

/** What `init` did with the creator's key. */
export interface InitHumanKey {
  /**
   * `ready`: the key exists; `keychain_unavailable`: the system keychain could not be used;
   * `keychain_full`: it refused the new key, being full (`KEYCHAIN_FULL`).
   */
  readonly status: "ready" | "keychain_unavailable" | "keychain_full";
  readonly reason?: string;
  readonly device?: string;
  readonly created?: boolean;
  /**
   * `written`: `human.key_registered` was written now; `already`: the journal holds a valid one;
   * `no_repo`: no Git repository yet (written by the first creator's command there); `failed`:
   * the journal could not be written (`publishReason`).
   */
  readonly published?: "written" | "already" | "no_repo" | "failed";
  readonly publishReason?: string;
  /** How far this product trusts the key (`pending` until endorsed), once published. */
  readonly trust?: HumanTrust;
  readonly presence?: PresenceState;
}

/**
 * The creator's key at `init`: created on the first install on this machine, under the
 * lock of key creation, then published in this repository's journal by `human.key_registered`
 * when there is a Git repository and the projection holds no valid registration of it. Never fails
 * `init`: a keychain or journal problem is reported.
 */
export async function installHumanKey(
  context: CommandContext,
  product: string,
): Promise<InitHumanKey | undefined> {
  const human = context.human;
  if (human === undefined) return undefined;
  let key: HumanKey;
  try {
    key = (await loadHumanKey(human.keys, keyLock(human))) as HumanKey;
  } catch (error) {
    if (error instanceof AgentPluggedError && error.code === ErrorCode.KEYCHAIN_FULL) {
      return { status: "keychain_full", reason: String(error.details.reason ?? "") };
    }
    return {
      status: "keychain_unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const base = { status: "ready" as const, device: key.device, created: key.created };
  const journal = context.journal;
  let published: InitHumanKey["published"] = "no_repo";
  let publishReason: string | undefined;
  let state: ProjectionState["state"] = {};
  if (journal !== undefined) {
    try {
      const loaded = await loadMethodConfig(context.files);
      if (loaded instanceof AgentPluggedError) throw loaded;
      const config = loaded.config;
      const listing = await journal.list();
      state = (await project(context, config, listing)).state;
      if (humansOf(state)[key.device] !== undefined) published = "already";
      else {
        const now = context.now ?? Date.now;
        const events = await prepareHumanEvents({
          key,
          drafts: [],
          deviceHead: deviceHeads(listing.events).get(key.device) ?? null,
          product,
          newId: createUlidFactory({ now }),
          now,
        });
        await journal.appendHuman(events);
        state = (await project(context, config, await journal.list())).state;
        published = "written";
      }
    } catch (error) {
      if (error instanceof AgentPluggedError && error.code === ErrorCode.NOT_A_GIT_REPO) {
        published = "no_repo";
      } else {
        published = "failed";
        publishReason =
          error instanceof AgentPluggedError
            ? String(error.details.reason ?? error.code)
            : error instanceof Error
              ? error.message
              : String(error);
      }
    }
  }
  let presence: PresenceState;
  try {
    presence = await presenceState(human, key.device, state);
  } catch (error) {
    presence = {
      status: "unavailable",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const { credential: _credential, ...shown } = presence;
  const trust = humansOf(state)[key.device]?.trust;
  return {
    ...base,
    published,
    ...(publishReason === undefined ? {} : { publishReason }),
    ...(trust === undefined ? {} : { trust }),
    presence: shown,
  };
}
