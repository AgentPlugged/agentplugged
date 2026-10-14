import type { AgentStoryStatus } from "@agentplugged/protocol";
import {
  CheckCiInputSchema,
  CI_EVENT_TYPES,
  CI_FORGES,
  type CiForge,
  type CiReportedPayload,
  CiReportedPayloadSchema,
  type CiStatus,
  type CiUnavailableReason,
  CiUrlSchema,
  CiWaiverReasonSchema,
  CommitIdSchema,
  ErrorCode,
  type EventEnvelope,
  MAX_CI_CHECK_NAME,
  MAX_CI_CHECKS,
  MAX_CI_FAILED,
  type MethodConfig,
} from "@agentplugged/protocol";
import {
  agentWriteContext,
  invalidInput,
  project,
  provenanceOf,
} from "../agent-activity/agent-commands.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError, unavailable } from "../errors.js";
import {
  type FastTrackOutcome,
  fastTrackEvents,
  outcomeOf,
  readFastTrack,
} from "../fast-track/fast-track-check.js";
import { humanTarget, trustedCreator, writeHuman } from "../human/human-commands.js";
import { localeSigner } from "../human/human-events.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig, productOf } from "../init/method-config.js";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import type { StoryWorkspace } from "../stories/story-workspace.js";
import { sessionTrust } from "../trust/session.js";
import type { CiCheck, CiReader } from "./ci-reader.js";
import { ciStatusOf } from "./ci-rules.js";

/** What `story ci` and `check_ci` read and recorded. */
export interface CiCheckResult {
  readonly story: string;
  readonly branch: string;
  /** The agent that builds the story (its `story.started`): the one to relaunch on a failure. */
  readonly agent: string;
  readonly forge: CiForge;
  readonly status: CiStatus;
  readonly checks: number;
  readonly failed: readonly string[];
  readonly pr?: number;
  readonly url?: string;
  /** The head of the story's branch the checks ran on. */
  readonly commit: string;
  /** True when this failure sent the story back to `in_progress` (read under the journal's lock). */
  readonly reopened: boolean;
  /**
   * What the engine read of the commit for a story in the fast track; absent when the
   * story is not in the fast track or the engine read this commit already.
   */
  readonly fast_track?: FastTrackOutcome;
  /** The story's status once recorded. */
  readonly story_status: AgentStoryStatus | null;
  /**
   * The CI is running or has not started on this commit: wait and read again, never
   * offer to accept the story without it.
   */
  readonly waiting?: boolean;
  /** No check has appeared yet (just pushed, or run again): the CI is about to start. */
  readonly starting?: true;
  /**
   * The commit is one the forge holds and this working copy lacks (added on the forge): it is
   * part of the story; fetch it in the story's worktree before working on it again.
   */
  readonly forge_ahead?: true;
  /**
   * The pull request conflicts with its target on the forge, so the CI does not start on it
   * (`starting`): say it to the creator in one sentence, they resolve it on the forge in two clicks
   * and the engine reads the new head; do not offer to accept the story without its CI.
   */
  readonly conflict_on_forge?: true;
  readonly event: { readonly id: string; readonly type: string; readonly at: string };
}

/** What `story ci <id> --waive "<reason>"` recorded: the creator accepts the story without CI. */
export interface CiWaiveResult {
  readonly story: string;
  readonly waived: true;
  readonly branch: string;
  readonly commit: string;
  readonly reason: string;
  readonly event: { readonly id: string; readonly type: string; readonly at: string };
}

/** `CI_UNAVAILABLE`: why the CI cannot be read, waived or set up; nothing written. */
export function ciUnavailable(
  reason: CiUnavailableReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.CI_UNAVAILABLE, `error.ci_unavailable.${reason}`, {
    reason,
    ...details,
  });
}

function invalid(field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "story",
    field,
    reason: `story ci: ${field}: ${reason}`,
  });
}

/** Who reads the CI: an agent through the MCP server, or the CLI (the engine, `system`). */
type Reporter = { readonly kind: "agent"; readonly agent: string } | { readonly kind: "system" };

interface CheckTarget {
  readonly product: string;
  readonly journal: StateStore;
  readonly config: MethodConfig;
  readonly reader: CiReader;
  readonly workspace: StoryWorkspace;
}

async function checkTarget(
  context: CommandContext,
  reporter: Reporter,
): Promise<CheckTarget | AgentPluggedError> {
  const reader = context.ciReader;
  const workspace = context.storyWorkspace;
  if (reporter.kind === "agent") {
    const write = await agentWriteContext(context, reporter.agent);
    if (write instanceof AgentPluggedError) return write;
    if (reader === undefined) return unavailable("no CI reader");
    if (workspace === undefined) return unavailable("no Git workspace");
    return { ...write, reader, workspace };
  }
  const { files } = context;
  if (!(await files.exists(METHOD_CONFIG_PATH))) return methodNotInstalled();
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const journal = context.journal;
  if (journal === undefined) return unavailable("no journal");
  if (reader === undefined) return unavailable("no CI reader");
  if (workspace === undefined) return unavailable("no Git workspace");
  const product = await productOf(loaded.config, journal);
  if (product instanceof AgentPluggedError) return product;
  return { product, journal, config: loaded.config, reader, workspace };
}

/**
 * A check's name as recorded: control characters dropped, at most 200 UTF-16 code units, never
 * half an emoji.
 */
export function checkName(name: string): string {
  const clean = [...name]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
    })
    .join("")
    .trim();
  let cut = clean.slice(0, MAX_CI_CHECK_NAME);
  const last = cut.charCodeAt(cut.length - 1);
  if (cut.length < clean.length && last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd() || "(unnamed)";
}

/**
 * The payload of a reading: the status of all the checks, the failed ones by name (each once; past
 * 50, the last entry says how many more), the commit, when the forge was read, and the pull
 * request's number and address only when they are well formed.
 */
export function ciPayload(
  forge: CiForge,
  checks: readonly CiCheck[],
  extra: {
    readonly commit: string;
    readonly read_at: string;
    readonly pr?: number;
    readonly url?: string;
  },
): CiReportedPayload {
  const status = checks.length === 0 ? "pending" : ciStatusOf(checks);
  const names =
    status === "fail"
      ? [...new Set(checks.filter((check) => check.state === "fail").map((c) => checkName(c.name)))]
      : [];
  const failed =
    names.length > MAX_CI_FAILED
      ? [...names.slice(0, MAX_CI_FAILED - 1), `… (+${names.length - (MAX_CI_FAILED - 1)} more)`]
      : names;
  const pr =
    extra.pr !== undefined && Number.isSafeInteger(extra.pr) && extra.pr >= 1
      ? extra.pr
      : undefined;
  const url =
    extra.url !== undefined && CiUrlSchema.safeParse(extra.url).success ? extra.url : undefined;
  return CiReportedPayloadSchema.parse({
    forge,
    status,
    checks: Math.min(checks.length, MAX_CI_CHECKS),
    failed,
    ...(pr === undefined ? {} : { pr }),
    ...(url === undefined ? {} : { url }),
    commit: extra.commit,
    read_at: extra.read_at,
  });
}

/** Why the journal forbids recording a CI read (or a waiver) of the story now. */
export function journalProblem(
  state: Readonly<Record<string, unknown>>,
  id: string,
): AgentPluggedError | undefined {
  const story = storyIn(state, id);
  const checkpoints = Object.values(checkpointsOf(state));
  if (storyDoneAt(checkpoints, id, story) !== undefined) {
    return ciUnavailable("done", { story: id });
  }
  if (story?.started === undefined) return ciUnavailable("not_started", { story: id });
  return undefined;
}

/**
 * The head of the story's branch, through the Git port, and whether it came from the
 * forge: commits added on the forge (a conflict resolved there, a suggestion accepted)
 * are part of the story, so when the remote's branch is strictly ahead of the local one, its head
 * is the story's head and the CI and the reviews are read on it.
 */
export async function branchHeads(
  workspace: StoryWorkspace,
  id: string,
  branch: string,
  options: { readonly fresh?: boolean } = {},
): Promise<{ head: string; forge_ahead: boolean } | AgentPluggedError> {
  const local = await localBranchHead(workspace, id, branch);
  if (local instanceof AgentPluggedError) return local;
  const remote = await workspace.remoteHead?.(branch, local, options).catch(() => undefined);
  return remote === undefined
    ? { head: local, forge_ahead: false }
    : { head: remote.toLowerCase(), forge_ahead: true };
}

/** The head of the story's branch in this repository, forge commits included. */
export async function branchHead(
  workspace: StoryWorkspace,
  id: string,
  branch: string,
): Promise<string | AgentPluggedError> {
  const heads = await branchHeads(workspace, id, branch);
  return heads instanceof AgentPluggedError ? heads : heads.head;
}

async function localBranchHead(
  workspace: StoryWorkspace,
  id: string,
  branch: string,
): Promise<string | AgentPluggedError> {
  const inspection = await workspace.inspect({
    id,
    branch,
    path: `.agentplugged/stories/${id}.md`,
  });
  if (!inspection.repository) return ciUnavailable("no_repository", { story: id });
  const head = inspection.branch?.commit;
  if (head === undefined) return ciUnavailable("no_branch", { story: id, branch });
  return head.toLowerCase();
}

/** The forge: given (`--forge`, `forge`), else `method.yaml`'s `ci.forge`, else `origin`'s. */
function forgeOf(
  asked: CiForge | undefined,
  config: MethodConfig,
  detected: CiForge | null,
): CiForge | null {
  return asked ?? config.ci?.forge ?? detected;
}

/**
 * Reads the CI of a started story's open pull request through the forge's tool. The reading
 * counts only for the head of the story's branch (read through the Git port), and
 * is written in one append whose precondition checks the story again under the journal's lock:
 * still started and not done, its status not declared since the read. Nothing is written when the
 * CI cannot be read (`CI_UNAVAILABLE`).
 */
async function checkCi(
  context: CommandContext,
  id: string,
  reporter: Reporter,
  asked: CiForge | undefined,
): Promise<CiCheckResult | AgentPluggedError> {
  const target = await checkTarget(context, reporter);
  if (target instanceof AgentPluggedError) return target;
  const { journal, config, reader, workspace } = target;
  const now = context.now ?? Date.now;
  // What the creator did on the forge is read first (a pull request merged by hand).
  await (await import("../merge/forge-follow.js")).followForge(context, { force: true });
  const listing = await journal.list();
  const state = (await project(context, config, listing)).state;
  const problem = journalProblem(state, id);
  if (problem !== undefined) {
    const merged = storyIn(state, id)?.merged;
    return merged?.source === "forge"
      ? ciUnavailable("done", { story: id, merged_on_forge: true, merged_by: merged.merged_by })
      : problem;
  }
  const started = (storyIn(state, id) as StoryState).started as NonNullable<StoryState["started"]>;
  const repository = await reader.repository();
  if (repository === null) return ciUnavailable("no_repository", { story: id });
  const forge = forgeOf(asked, config, repository.forge);
  if (forge === null) return ciUnavailable("no_forge", { story: id });
  const heads = await branchHeads(workspace, id, started.branch, { fresh: true });
  if (heads instanceof AgentPluggedError) return heads;
  const head = heads.head;
  // The read starts now: a status declared after this moment may not be covered by it.
  const readAt = new Date(now()).toISOString();
  const reading = await reader.read(started.branch, forge);
  if (!reading.ok) {
    return ciUnavailable(reading.reason, {
      story: id,
      tool: reading.tool,
      branch: started.branch,
      ...(reading.detail === undefined ? {} : { detail: reading.detail }),
    });
  }
  // A pull request with no check yet, in a product that has a CI, is a CI that has not
  // started on the commit (just pushed, or run again): pending, never "no CI".
  const starting = reading.checks.length === 0 && repository.ci.length > 0;
  if (reading.checks.length === 0 && !starting) {
    return ciUnavailable("no_checks", { story: id, branch: started.branch });
  }
  const commit = reading.commit?.toLowerCase();
  if (commit === undefined || !CommitIdSchema.safeParse(commit).success || commit !== head) {
    return ciUnavailable("head_mismatch", {
      story: id,
      branch: started.branch,
      commit: commit ?? "?",
      head,
    });
  }
  const payload = ciPayload(forge, reading.checks, {
    commit,
    read_at: readAt,
    ...(reading.pr === undefined ? {} : { pr: reading.pr }),
    ...(reading.url === undefined ? {} : { url: reading.url }),
  });
  const trust =
    reporter.kind === "agent" ? await sessionTrust(context, config, listing.events) : undefined;
  let before: StoryState["status"] = null;
  const writer = {
    actor:
      reporter.kind === "agent"
        ? { kind: "agent" as const, agent: reporter.agent }
        : { kind: "system" as const },
    product: target.product,
    provenance: trust === undefined ? ("trusted" as const) : provenanceOf(trust),
  };
  // A story in the fast track: the engine reads the commit's changes in the same write.
  const track = await readFastTrack(context, storyIn(state, id), commit);
  const written = await journal.appendAll(
    [
      { type: CI_EVENT_TYPES.reported, ...writer, story: id, payload },
      ...(track === undefined
        ? []
        : fastTrackEvents(track, {
            id,
            checkpoints: Object.values(checkpointsOf(state)),
            writer,
          })),
    ],
    {
      // Under the journal's lock: still started, not done, and no status declared since the read.
      precondition: async (current: JournalListing) => {
        const latest = (await project(context, config, current)).state;
        const again = journalProblem(latest, id);
        if (again !== undefined) throw again;
        const story = storyIn(latest, id);
        const since = story?.status_by?.at;
        if (since !== undefined && Date.parse(since) > Date.parse(readAt)) {
          throw ciUnavailable("stale_read", { story: id, read_at: readAt, status_at: since });
        }
        before = story?.status ?? null;
      },
    },
  );
  const event = written[0] as EventEnvelope;
  const exited = track !== undefined && !track.verdict.ok;
  const reopened = !exited && payload.status === "fail" && before === "in_review";
  return {
    story: id,
    branch: started.branch,
    agent: started.agent,
    forge,
    status: payload.status,
    checks: payload.checks,
    failed: payload.failed,
    ...(payload.pr === undefined ? {} : { pr: payload.pr }),
    ...(payload.url === undefined ? {} : { url: payload.url }),
    commit,
    reopened,
    ...(track === undefined ? {} : { fast_track: outcomeOf(track) }),
    story_status: exited ? "blocked" : reopened ? "in_progress" : before,
    waiting: payload.status === "pending",
    ...(payload.checks === 0 ? { starting: true } : {}),
    ...(heads.forge_ahead ? { forge_ahead: true } : {}),
    ...(starting && reading.conflicting === true ? { conflict_on_forge: true } : {}),
    event: { id: event.id, type: event.type, at: event.at },
  };
}

/**
 * `story ci <id> --waive "<reason>"`: the creator accepts a story whose CI cannot
 * be read, for the current head of its branch only; signed by the creator's key, never by an agent.
 */
async function waiveCi(
  context: CommandContext,
  id: string,
  reason: string,
): Promise<CiWaiveResult | AgentPluggedError> {
  const parsed = CiWaiverReasonSchema.safeParse(reason);
  if (!parsed.success) return invalid("waive", "1 to 500 characters, without control characters");
  const target = await humanTarget(context, "story ci --waive");
  if (target instanceof AgentPluggedError) return target;
  const workspace = context.storyWorkspace;
  if (workspace === undefined) return unavailable("no Git workspace");
  const creator = await trustedCreator(context, target);
  if (creator instanceof AgentPluggedError) return creator;
  const { key, state } = creator;
  const problem = journalProblem(state, id);
  if (problem !== undefined) return problem;
  const started = (storyIn(state, id) as StoryState).started as NonNullable<StoryState["started"]>;
  const head = await branchHead(workspace, id, started.branch);
  if (head instanceof AgentPluggedError) return head;
  const [event] = (
    await writeHuman(
      context,
      target,
      key,
      [
        {
          type: CI_EVENT_TYPES.waived,
          story: id,
          payload: { reason: parsed.data, commit: head },
          signer: localeSigner(key),
        },
      ],
      async (written) => {
        const current = await project(context, target.config, written);
        const again = journalProblem(current.state, id);
        if (again !== undefined) throw again;
      },
    )
  ).filter((written) => written.type === CI_EVENT_TYPES.waived);
  if (event === undefined) throw new Error("story ci: nothing was written");
  return {
    story: id,
    waived: true,
    branch: started.branch,
    commit: head,
    reason: parsed.data,
    event: { id: event.id, type: event.type, at: event.at },
  };
}

/**
 * `story ci <id> [--forge github|gitlab] [--waive "<reason>"]`: the creator, or an agent at its
 * terminal, reads a story's CI; `--waive`, the creator's alone, accepts the story
 * without a readable CI for the branch's current head.
 */
export async function storyCi(
  context: CommandContext,
  id: string,
  options: { readonly forge?: unknown; readonly waive?: unknown } = {},
): Promise<CiCheckResult | CiWaiveResult | AgentPluggedError> {
  try {
    if (options.waive !== undefined) {
      if (options.forge !== undefined) return invalid("forge", "not with --waive");
      return await waiveCi(context, id, String(options.waive));
    }
    const forge = options.forge;
    if (forge !== undefined && !(CI_FORGES as readonly unknown[]).includes(forge)) {
      return invalid("forge", `${String(forge)} (github, gitlab)`);
    }
    return await checkCi(context, id, { kind: "system" }, forge as CiForge | undefined);
  } catch (error) {
    if (error instanceof AgentPluggedError) return error;
    throw error;
  }
}

/** `check_ci`: an agent reads the CI of a story's pull request. */
export const checkCiCommand = defineCommand<CiCheckResult>({
  name: "check_ci",
  audience: "agent",
  description:
    "Read the CI of a started story's pull request: `story` is `<epic>-<story>`, `agent` your own id (or `main`), `forge` (github or gitlab) only when the forge is hosted under another name and `method.yaml` does not say it. The engine finds the open pull request (GitHub) or merge request (GitLab) of the story's branch with the forge's command-line tool the creator signed in (`gh`, `glab`), reads its checks and records `story.ci_reported` with the status (`pass`, `fail` or `pending`), the failed checks by name, the pull request's address and the commit. The read counts only for the head of the story's branch in this repository: push your commits first. Commits added on the forge count (`forge_ahead`: fetch them). Merged on the forge: `done`, `merged_on_forge`. `waiting` true (`starting`: no check yet): wait, call again, never offer to accept the story without the CI; `conflict_on_forge`: tell the creator. A failed CI sends a story in review back to in_progress: its builder fixes it in the story's worktree, pushes, then calls check_ci again. A pending CI: call it again later. The creator is shown a story's merge only once its CI is green on the branch's head, read since the story was sent to review, and its review is done. Refused with CI_UNAVAILABLE, nothing written: not_started, done, no_repository, no_forge, no_branch, forge_cli_missing, not_authenticated (ask the creator to sign the tool in), forge_access, forge_timeout, no_pull_request (open it first), no_checks (no CI: Omar sets it up with `npx agentplugged ci setup`), head_mismatch (the checks ran on another commit: push, wait, read again), stale_read (the story's status changed meanwhile: read again), forge_failed. When the CI cannot be read, or the creator wants to go on without it, only the creator may accept the story without it: you may offer it, ask them in the chat with request_creator_action (`ci_waive`, one answer, the reason recorded in the journal), and never decide it yourself. It never merges, reviews nor writes to the forge.",
  inputSchema: CheckCiInputSchema,
  async run(context, input) {
    const parsed = CheckCiInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("check_ci", parsed.error));
    const { agent, story, forge } = parsed.data;
    try {
      const result = await checkCi(context, story, { kind: "agent", agent }, forge);
      return result instanceof AgentPluggedError ? fail(result) : ok(result);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
