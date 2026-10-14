import {
  CREATOR_OWNER,
  ErrorCode,
  type EventEnvelope,
  FAST_TRACK_EVENT_TYPES,
  type FastTrackEnteredPayload,
  type FastTrackEntry,
  isStoryBranch,
  MAIN_SESSION_AGENT,
  type MethodConfig,
  missingDeclarations,
  type ProjectionState,
  STORY_EVENT_TYPES,
  StartStoryFastTrackInputSchema,
  type StoryHeader,
  StoryIdSchema,
  type StoryStartedPayload,
  type StoryStartReason,
} from "@agentplugged/protocol";
import {
  agentWriteContext,
  invalidInput,
  project,
  provenanceOf,
} from "../agent-activity/agent-commands.js";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { type CiCheckResult, type CiWaiveResult, storyCi } from "../ci/ci-check.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { storyLockProblem } from "../deferred/deferred-rules.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { AgentPluggedError, unavailable } from "../errors.js";
import { fastTrackNotPossible } from "../fast-track/fast-track-commands.js";
import { fastTrackHold } from "../fast-track/fast-track-rules.js";
import { workflowOf } from "../git/git-workflow.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig, productOf } from "../init/method-config.js";
import { readMachineKey } from "../journal/key-store.js";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { isSkipped } from "../journey/journey-rules.js";
import { STORY_BUILDERS } from "../phases/phases.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import type { StoryStarted, StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import {
  currentSprint,
  type SprintState,
  type SprintStory,
  sprintsOf,
  storyDoneAt,
  validationOf,
} from "../sprints/sprint-rules.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { activeAgentNames, loadDefinitions } from "../sync/sync-command.js";
import { sessionTrust } from "../trust/session.js";
import { commitHookFiles, type TraceSkips, traceSkipsOf } from "./commit-hook.js";
import { openPullRequest, type StoryPullRequestResult } from "./pull-request.js";
import { latestStoryApproval } from "./story-review.js";
import type { CommitHookInstall, StoryWorkspace, StoryWorkspaceTarget } from "./story-workspace.js";

/** What `story start` and `start_story` did. */
export interface StoryStartResult {
  /** `started`: branch, worktree and `story.started` created now; `resumed`: started before. */
  readonly status: "started" | "resumed";
  readonly story: string;
  /** Who builds it, as `story.started` records it. */
  readonly agent: string;
  readonly branch: string;
  readonly base: string;
  readonly base_ref: string;
  /**
   * False when the creator chose to work on the integration branch itself: the story
   * has no branch of its own, `branch` is that branch and `worktree` the main working folder.
   */
  readonly story_branch?: false;
  /** The worktree's folder, absolute. */
  readonly worktree: string;
  /** Where to work: the worktree, with the folder holding `.agentplugged/` when it is not the top. */
  readonly workdir: string;
  /**
   * `fast`: the story is a small change in the fast track; `full`: the full lane,
   * from the start or after the way back from the fast track.
   */
  readonly track: "fast" | "full";
  /** The event written, only when written now. */
  readonly event?: { readonly id: string; readonly type: string; readonly at: string };
  /** The commit hook; absent for a story without a branch of its own (nothing to check there). */
  readonly hook?: CommitHookInstall;
}

/** `STORY_NOT_STARTABLE`: why the story cannot start; nothing created nor written. */
export function notStartable(
  story: string,
  reason: StoryStartReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.STORY_NOT_STARTABLE,
    `error.story_not_startable.${reason}`,
    { story, reason, ...details },
  );
}

function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** What the journal says about a story, as its start needs it. */
export interface StoryJournalView {
  readonly checkpoints: readonly CheckpointState[];
  readonly story: StoryState | undefined;
  readonly sprint: SprintState | undefined;
  /** Whether a story is done, by id. */
  readonly done: (id: string) => boolean;
  /** `STORY_LOCKED` when an open item of deferred work locks the story's start. */
  readonly locked: AgentPluggedError | undefined;
  /**
   * The stories started and not done, sorted: the instances of developers at work,
   * all developers together.
   */
  readonly building: readonly string[];
  /**
   * What the creator skipped for this story: its contract (valid, validated), the
   * order of the stories (dependencies done first) and sprint planning (the story in the sprint in
   * force). Each is a warning in the journey, never a refusal. Absent: nothing skipped.
   */
  readonly skips?: {
    readonly contract: boolean;
    readonly order: boolean;
    readonly sprint: boolean;
  };
  /**
   * The stories whose commits need cite no requirement (no PRD, no traceability), given
   * to the commit hook; absent when nothing is skipped.
   */
  readonly traceSkips?: TraceSkips;
}

/** The journal's view of a story at `now`. */
export function storyJournalView(
  state: ProjectionState["state"],
  id: string,
  now: number,
): StoryJournalView {
  const checkpointsById = checkpointsOf(state);
  const checkpoints = Object.values(checkpointsById);
  const trace = traceSkipsOf(state);
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  return {
    checkpoints,
    story: own(stories, id),
    sprint: currentSprint(sprintsOf(state), checkpointsById, now),
    done: (story: string) => storyDoneAt(checkpoints, story, own(stories, story)) !== undefined,
    locked: storyLockProblem(state, id, "start"),
    skips: {
      contract: isSkipped(state, "story_contract", id),
      order: isSkipped(state, "story_order", id),
      sprint: isSkipped(state, "sprint_planning"),
    },
    ...(trace === undefined ? {} : { traceSkips: trace }),
    building: Object.keys(stories)
      .filter((story) => {
        const entry = own(stories, story);
        return (
          entry?.started !== undefined &&
          storyDoneAt(checkpoints, story, entry) === undefined &&
          // A story the creator stopped on leaving the fast track builds nothing.
          fastTrackHold(entry, checkpoints, story) !== "stopped"
        );
      })
      .sort(),
  };
}

/**
 * The profile's ceiling of stories built at once (`max_parallel_stories`):
 * reached, the story waits until one of them is done (`STORY_NOT_STARTABLE`, `parallel_limit`).
 * Every developer's instances count, whatever their specialty. Undefined without a ceiling.
 */
export function parallelLimitProblem(
  id: string,
  limit: number | undefined,
  journal: StoryJournalView,
): AgentPluggedError | undefined {
  if (limit === undefined) return undefined;
  const building = journal.building.filter((story) => story !== id);
  if (building.length < limit) return undefined;
  return notStartable(id, "parallel_limit", { limit, building: building.join(", ") });
}

/**
 * Why the journal forbids a story to start now (checked before anything is created, then again
 * under the journal's lock): done, already started or given a status, outside the sprint in
 * force, a dependency not done, an open item of deferred work that locks it (`STORY_LOCKED`).
 * Undefined when it may start.
 */
export function journalStartProblem(
  id: string,
  dependsOn: readonly string[],
  journal: StoryJournalView,
): AgentPluggedError | undefined {
  if (journal.done(id)) return notStartable(id, "done");
  const status = journal.story?.status ?? null;
  if (journal.story?.started !== undefined || status !== null) {
    return notStartable(id, "already_started", { status: status ?? "in_progress" });
  }
  const sprint = journal.sprint;
  if (
    sprint !== undefined &&
    journal.skips?.sprint !== true &&
    !sprint.stories.some((entry) => entry.id === id)
  ) {
    return notStartable(id, "not_in_sprint", { sprint: sprint.id });
  }
  const open = dependsOn.find((dependency) => !journal.done(dependency));
  if (open !== undefined && journal.skips?.order !== true) {
    return notStartable(id, "dependency_open", { dependency: open });
  }
  // An open item of deferred work locks it: `STORY_LOCKED`, nothing created.
  if (journal.locked !== undefined) return journal.locked;
  return undefined;
}

/**
 * Why the journal and the working copy forbid a story to start, in order: unknown,
 * unreadable, refused by `docs check`, never validated or changed since, then the journal's
 * reasons (`journalStartProblem`). Undefined when it may start.
 */
export function storyStartProblem(input: {
  readonly id: string;
  readonly story: SprintStory | undefined;
  readonly validation: "validated" | "changed" | "never" | undefined;
  readonly journal: StoryJournalView;
}): AgentPluggedError | undefined {
  const { id, story, validation, journal } = input;
  if (story === undefined) return notStartable(id, "unknown_story");
  if (story.state === "unreadable") return notStartable(id, "unreadable", { path: story.path });
  // The creator skipped the story's contract: it starts invalid or not validated.
  const contractSkipped = journal.skips?.contract === true;
  if (story.state === "invalid" && !contractSkipped) {
    return notStartable(id, "invalid_story", { path: story.path, why: story.faults.join(", ") });
  }
  if (validation !== "validated" && !contractSkipped) {
    return notStartable(id, "not_validated", { path: story.path, why: validation ?? "never" });
  }
  return journalStartProblem(id, story.depends_on, journal);
}

/**
 * The blob of the story at `path` in the creator's latest approval of it: among the approved
 * `document` checkpoints (never waived) listing that path, the one answered last. Undefined when
 * none lists it.
 */
export function latestApprovedStoryBlob(
  checkpoints: Iterable<CheckpointState>,
  path: string,
  now: number,
): string | undefined {
  return latestStoryApproval(checkpoints, path, now)?.blob;
}

/** This machine's device, when its key exists; null without one, undefined when unreadable. */
async function machineOf(context: CommandContext): Promise<string | null | undefined> {
  const keys = context.keys ?? context.human?.keys;
  if (keys === undefined) return undefined;
  try {
    return (await readMachineKey(keys))?.device ?? null;
  } catch {
    return undefined;
  }
}

/** `NOT_A_GIT_REPO`: no repository holds the current folder. */
function notARepository(): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.NOT_A_GIT_REPO, "error.not_a_git_repo", { path: "." });
}

/** Who starts the story: an agent through the MCP server, or the CLI (the engine, `system`). */
type Starter = { readonly kind: "agent"; readonly agent: string } | { readonly kind: "system" };

export interface StartTarget {
  readonly product: string;
  readonly journal: StateStore;
  readonly config: MethodConfig;
  readonly workspace: StoryWorkspace;
  /** The active agents of the product. */
  readonly agents: ReadonlySet<string>;
}

/**
 * The product, journal, active agents and Git workspace of the CLI's start; also the CLI's
 * `story pr`.
 */
export async function cliTarget(context: CommandContext): Promise<StartTarget | AgentPluggedError> {
  const { files } = context;
  if (!(await files.exists(METHOD_CONFIG_PATH))) return methodNotInstalled();
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const journal = context.journal;
  if (journal === undefined) return unavailable("no journal");
  const workspace = context.storyWorkspace;
  if (workspace === undefined) return unavailable("no Git workspace");
  const definitions = await loadDefinitions(files);
  if (definitions instanceof AgentPluggedError) return definitions;
  const agents = activeAgentNames(definitions, loaded.config);
  const product = await productOf(loaded.config, journal);
  if (product instanceof AgentPluggedError) return product;
  return { product, journal, config: loaded.config, workspace, agents };
}

/** The folder to work in: the worktree, then the workspace root inside it. */
function workdirOf(worktree: string, prefix: string): string {
  if (prefix === "") return worktree;
  const separator = worktree.includes("\\") && !worktree.includes("/") ? "\\" : "/";
  const inner = prefix.replace(/\/$/, "").split("/").join(separator);
  return `${worktree.replace(/[\\/]$/, "")}${separator}${inner}`;
}

/**
 * Who builds a story, as `next` names them: its owner in the sprint in force (else in its file);
 * `creator` stays the creator; an inactive owner gives way to the first active agent of the
 * sprint's capacity, else the creator. A developer retired by the renaming gives way
 * to its successor (`currentDeveloper`).
 */
export function storyBuilder(
  id: string,
  owner: string | undefined,
  sprint: SprintState | undefined,
  active: ReadonlySet<string>,
): string {
  const named = sprint?.stories.find((entry) => entry.id === id)?.owner ?? owner;
  if (named === undefined || named === CREATOR_OWNER) return CREATOR_OWNER;
  const recorded = currentDeveloper(named);
  if (active.has(recorded)) return recorded;
  return (
    sprint?.capacity.agents.map(currentDeveloper).find((agent) => active.has(agent)) ??
    CREATOR_OWNER
  );
}

/**
 * Whether an agent may start the story: the creator's main session always; with a sprint in force,
 * the story's owner in it or an agent of its approved capacity; without, the story's owner.
 */
function mayBuild(
  agent: string,
  id: string,
  owner: string | undefined,
  sprint: SprintState | undefined,
): boolean {
  if (agent === MAIN_SESSION_AGENT) return true;
  if (sprint === undefined) return owner !== undefined && agent === currentDeveloper(owner);
  const entry = sprint.stories.find((story) => story.id === id);
  return (
    (entry !== undefined && currentDeveloper(entry.owner) === agent) ||
    sprint.capacity.agents.some((member) => currentDeveloper(member) === agent)
  );
}

/** The requirements of the story in a blob of the repository (its approved version). */
async function requirementsAt(
  workspace: StoryWorkspace,
  blob: string | undefined,
  path: string,
): Promise<string[]> {
  if (blob === undefined) return [];
  const text = await workspace.readBlob(blob);
  if (text === undefined) return [];
  const header = parseDocumentFile(path, text).header as StoryHeader | undefined;
  return Array.isArray(header?.requirements) ? [...header.requirements] : [];
}

async function startTarget(
  context: CommandContext,
  starter: Starter,
): Promise<StartTarget | AgentPluggedError> {
  if (starter.kind === "system") return cliTarget(context);
  const write = await agentWriteContext(context, starter.agent);
  if (write instanceof AgentPluggedError) return write;
  if (context.storyWorkspace === undefined) return unavailable("no Git workspace");
  return { ...write, workspace: context.storyWorkspace };
}

/**
 * Starts a story: checks it may start (the journal, the working copy, then Git),
 * creates its branch and worktree, writes `story.started` in one append whose precondition checks
 * the journal again under its lock, then installs the commit hook. A refused append removes what
 * this call created, or says honestly that it stays. A story already started is resumed.
 */
async function startStory(
  context: CommandContext,
  id: string,
  starter: Starter,
  fast?: FastTrackEntry,
): Promise<StoryStartResult | AgentPluggedError> {
  const target = await startTarget(context, starter);
  if (target instanceof AgentPluggedError) return target;
  const { journal, config, workspace } = target;
  const now = (context.now ?? Date.now)();
  const listing = await journal.list();
  const state = (await project(context, config, listing)).state;
  const view = storyJournalView(state, id, now);
  const documents = await readSprintStories(context.files);
  const document = documents.get(id);

  if (view.done(id)) return notStartable(id, "done");
  const started = view.story?.started;
  if (started !== undefined) {
    // The fast track is entered when the story starts, never afterwards.
    // (another developer's story, or another machine's, gets the engine's own refusal first)
    if (
      fast !== undefined &&
      view.story?.fast_track?.status !== "active" &&
      starter.kind === "agent" &&
      currentDeveloper(starter.agent) === currentDeveloper(started.agent)
    ) {
      return fastTrackNotPossible(
        id,
        view.story?.fast_track === undefined ? "already_started" : "already_left",
      );
    }
    return resume(context, target, starter, view, id, started, document?.path);
  }
  // Only a complete declaration enters the fast track: nothing created otherwise.
  if (fast !== undefined) {
    const missing = missingDeclarations(fast.declared);
    if (missing.length > 0) {
      return fastTrackNotPossible(id, "declaration", { missing: missing.join(", ") });
    }
  }

  const validation = validationOf(documents, view.checkpoints, now).get(id);
  const refused = storyStartProblem({ id, story: document, validation, journal: view });
  if (refused !== undefined) return refused;
  const ceiling = config.profile?.max_parallel_stories;
  const story = document as SprintStory;
  // The creator's workflow says where the stories land and whether each has a branch.
  const flow = workflowOf(state).resolved;
  const branch = story.branch ?? "";
  if (flow.story_branches && !isStoryBranch(id, branch)) {
    return notStartable(id, "branch_name", { branch });
  }
  // Without sprint planning (skipped by the creator), any developer takes a story as it comes.
  const takesAny =
    starter.kind === "agent" &&
    view.skips?.sprint === true &&
    STORY_BUILDERS.includes(currentDeveloper(starter.agent));
  if (
    starter.kind === "agent" &&
    !takesAny &&
    !mayBuild(starter.agent, id, story.owner, view.sprint)
  ) {
    return notStartable(id, "not_builder", {
      agent: starter.agent,
      owner: storyBuilder(id, story.owner, view.sprint, target.agents),
    });
  }
  // The ceiling of stories at once, once the builder is known.
  const full = parallelLimitProblem(id, ceiling, view);
  if (full !== undefined) return full;
  const where: StoryWorkspaceTarget = { id, branch: branch || `feat/${id}`, path: story.path };
  const landing = flow.integration === undefined ? undefined : { base: flow.integration };
  let inspection = await workspace.inspect(where, landing);
  if (!inspection.repository) {
    return inspection.unsupported === undefined
      ? notARepository()
      : notStartable(id, "unsupported_repository", { why: inspection.unsupported });
  }
  // The integration branch does not exist yet (`main` + `dev` just chosen): created from the main
  // branch, never a new history.
  if (inspection.main === null && flow.integration !== undefined && workspace.ensureBranch) {
    await workspace.ensureBranch(flow.integration, flow.production);
    inspection = await workspace.inspect(where, landing);
    if (!inspection.repository) return notARepository();
  }
  let main = inspection.main;
  if (main === null) return notStartable(id, "no_main_branch");
  const approved = latestApprovedStoryBlob(view.checkpoints, story.path, now);
  // A story never approved, whose contract the creator skipped, is the file on the
  // main branch as it is: only a file missing there is refused (the branch is cut from it).
  const unapprovedByChoice = view.skips?.contract === true;
  // With a staging branch, the documents the creator approved were committed on the main
  // branch, which the staging branch has not taken in yet: the engine brings the production branch into
  // it (a merge here, never pushed) before it looks again.
  const stale =
    inspection.storyBlob === null ||
    (inspection.storyBlob.toLowerCase() !== approved && !unapprovedByChoice);
  if (stale && flow.integration !== undefined && workspace.mergeBranch !== undefined) {
    const own = await workspace.inspect(where);
    const production = flow.production ?? (own.repository ? own.main?.ref : undefined);
    if (production !== undefined) {
      await workspace.mergeBranch({
        from: production.startsWith("origin/") ? production.slice("origin/".length) : production,
        into: flow.integration,
        method: "merge",
        message: `Bring ${production} into ${flow.integration}`,
      });
      const again = await workspace.inspect(where, landing);
      if (again.repository && again.main !== null) {
        inspection = again;
        main = again.main;
      }
    }
  }
  if (
    inspection.storyBlob === null ||
    (inspection.storyBlob.toLowerCase() !== approved && !unapprovedByChoice)
  ) {
    return notStartable(id, "not_on_main", {
      why: inspection.storyBlob === null ? "missing" : "differs",
      base_ref: main.ref,
      path: story.path,
    });
  }
  // No branch of its own. The story is built on the branch the stories land on, in the
  // main working folder: nothing to create, only `story.started` to write.
  if (!flow.story_branches) {
    return startOnBase(context, target, starter, {
      id,
      story,
      main,
      root: inspection.root ?? "",
      current: inspection.current,
      view,
      ceiling,
      fast,
    });
  }
  const existing = inspection.branch;
  // A branch left by an interrupted start is taken only when it holds the approved story: at the
  // main branch's commit, or at an older one with the same story.
  if (
    existing !== null &&
    (!existing.merged ||
      (existing.commit !== main.commit && existing.storyBlob?.toLowerCase() !== approved))
  ) {
    return notStartable(id, "branch_exists", { branch });
  }
  if (inspection.checkedOut !== null && !inspection.checkedOut.atTarget) {
    return notStartable(id, "branch_checked_out", { branch, path: inspection.checkedOut.path });
  }
  if (inspection.target.exists && inspection.checkedOut === null) {
    return notStartable(id, "worktree_path_taken", { path: inspection.target.path });
  }

  const base = existing?.commit ?? main.commit;
  const requirements = await requirementsAt(workspace, approved, story.path);
  const agent =
    starter.kind === "agent"
      ? starter.agent
      : storyBuilder(id, story.owner, view.sprint, target.agents);
  const payload: StoryStartedPayload = {
    agent,
    branch,
    base,
    base_ref: main.ref,
    worktree: inspection.target.relative,
  };
  const trust =
    starter.kind === "agent" ? await sessionTrust(context, config, listing.events) : undefined;
  const created = await workspace.create(where, base);
  let event: EventEnvelope;
  try {
    event = await writeStart(context, target, starter, {
      id,
      story,
      payload,
      agent,
      trust,
      ceiling,
      fast,
    });
  } catch (error) {
    if (await workspace.discard(where, base, created)) throw error;
    throw notStartable(id, "not_recorded", {
      branch,
      path: created.worktree,
      cause: error instanceof AgentPluggedError ? error.code : String(error),
    });
  }
  const hook = await workspace.installCommitHook(
    commitHookFiles({ id, requirements }, view.traceSkips ?? []),
  );
  return {
    status: "started",
    story: id,
    agent,
    branch,
    base,
    base_ref: main.ref,
    worktree: created.worktree,
    workdir: workdirOf(created.worktree, inspection.prefix),
    track: fast !== undefined && starter.kind === "agent" ? "fast" : "full",
    event: { id: event.id, type: event.type, at: event.at },
    hook,
  };
}

/**
 * Writes `story.started` (and the fast-track entry, in the same write), as the journal stands when
 * written: under its lock, nobody started the story meanwhile and the ceiling still holds.
 */
async function writeStart(
  context: CommandContext,
  target: StartTarget,
  starter: Starter,
  input: {
    readonly id: string;
    readonly story: SprintStory;
    readonly payload: StoryStartedPayload;
    readonly agent: string;
    readonly trust: Awaited<ReturnType<typeof sessionTrust>> | undefined;
    readonly ceiling: number | undefined;
    readonly fast: FastTrackEntry | undefined;
  },
): Promise<EventEnvelope> {
  const { id, story, payload, agent, trust, ceiling, fast } = input;
  const writer = {
    actor:
      starter.kind === "agent"
        ? { kind: "agent" as const, agent: starter.agent }
        : { kind: "system" as const },
    product: target.product,
    story: id,
    provenance: trust === undefined ? ("trusted" as const) : provenanceOf(trust),
  };
  const written = await target.journal.appendAll(
    [
      { ...writer, type: STORY_EVENT_TYPES.started, payload },
      // The mode the story carries, in the same write as its start.
      ...(fast === undefined || starter.kind !== "agent"
        ? []
        : [
            {
              ...writer,
              type: FAST_TRACK_EVENT_TYPES.entered,
              payload: {
                agent,
                summary: fast.summary,
                declared: { single_reading: true, reversible: true, no_public_interface: true },
              } satisfies FastTrackEnteredPayload,
            },
          ]),
    ],
    {
      precondition: async (current: JournalListing) => {
        const latest = (await project(context, target.config, current)).state;
        const again = storyJournalView(latest, id, (context.now ?? Date.now)());
        const problem =
          journalStartProblem(id, story.depends_on, again) ??
          parallelLimitProblem(id, ceiling, again);
        if (problem !== undefined) throw problem;
      },
    },
  );
  return written[0] as EventEnvelope;
}

/** The short name of a ref the main branch was read as: `origin/dev` is `dev`, `dev` stays. */
function branchOfRef(ref: string): string {
  return ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
}

/**
 * Starts a story without a branch of its own: the creator works on the integration
 * branch itself. The story is built in the main working folder; `story.started` records that branch
 * and its commit, with the main working folder as its worktree (`.`). No hook: the commits of a
 * shared branch are not the story's alone.
 */
async function startOnBase(
  context: CommandContext,
  target: StartTarget,
  starter: Starter,
  input: {
    readonly id: string;
    readonly story: SprintStory;
    readonly main: { readonly ref: string; readonly commit: string };
    readonly root: string;
    /** The branch checked out in the main folder, when the adapter says. */
    readonly current?: string | null | undefined;
    readonly view: StoryJournalView;
    readonly ceiling: number | undefined;
    readonly fast: FastTrackEntry | undefined;
  },
): Promise<StoryStartResult | AgentPluggedError> {
  const { journal, config } = target;
  const { id, story, main, root, view, ceiling, fast } = input;
  const listing = await journal.list();
  const agent =
    starter.kind === "agent"
      ? starter.agent
      : storyBuilder(id, story.owner, view.sprint, target.agents);
  const branch = branchOfRef(main.ref);
  // The story is built in the main folder: it must be on the branch the story lands on.
  if (input.current !== undefined && input.current !== branch) {
    return notStartable(id, "base_not_checked_out", { branch, path: root });
  }
  const payload: StoryStartedPayload = {
    agent,
    branch,
    base: main.commit,
    base_ref: main.commit,
    worktree: ".",
  };
  const trust =
    starter.kind === "agent" ? await sessionTrust(context, config, listing.events) : undefined;
  const event = await writeStart(context, target, starter, {
    id,
    story,
    payload,
    agent,
    trust,
    ceiling,
    fast,
  });
  return {
    status: "started",
    story: id,
    agent,
    branch,
    base: main.commit,
    base_ref: main.commit,
    story_branch: false,
    worktree: root,
    workdir: root,
    track: fast !== undefined && starter.kind === "agent" ? "fast" : "full",
    event: { id: event.id, type: event.type, at: event.at },
  };
}

/**
 * A story already started: resumed only by the agent `story.started` names (any start through the
 * CLI), on the machine that started it; the branch (from its recorded base) and the worktree are
 * created again when missing, the hook installed again; nothing is written.
 */
async function resume(
  context: CommandContext,
  target: StartTarget,
  starter: Starter,
  view: StoryJournalView,
  id: string,
  started: StoryStarted,
  path: string | undefined,
): Promise<StoryStartResult | AgentPluggedError> {
  // A story a retired developer started is taken up by its successor.
  if (starter.kind === "agent" && starter.agent !== currentDeveloper(started.agent)) {
    return notStartable(id, "started_by_other", { agent: started.agent });
  }
  if ((await machineOf(context)) !== started.device) {
    return notStartable(id, "started_elsewhere", { device: started.device });
  }
  const storyPath = path ?? `.agentplugged/stories/${id}.md`;
  const where: StoryWorkspaceTarget = { id, branch: started.branch, path: storyPath };
  const inspection = await target.workspace.inspect(where);
  if (!inspection.repository) {
    return inspection.unsupported === undefined
      ? notARepository()
      : notStartable(id, "unsupported_repository", { why: inspection.unsupported });
  }
  // A story built without a branch of its own is worked on in the main working folder.
  if (started.worktree === ".") {
    const root = inspection.root ?? "";
    if (inspection.current !== undefined && inspection.current !== started.branch) {
      return notStartable(id, "base_not_checked_out", { branch: started.branch, path: root });
    }
    return {
      status: "resumed",
      story: id,
      agent: started.agent,
      branch: started.branch,
      base: started.base,
      base_ref: started.base_ref,
      story_branch: false,
      worktree: root,
      workdir: root,
      track: view.story?.fast_track?.status === "active" ? "fast" : "full",
    };
  }
  if (inspection.checkedOut !== null && !inspection.checkedOut.atTarget) {
    return notStartable(id, "branch_checked_out", {
      branch: started.branch,
      path: inspection.checkedOut.path,
    });
  }
  if (inspection.checkedOut === null && inspection.target.exists) {
    return notStartable(id, "worktree_path_taken", { path: inspection.target.path });
  }
  const created = await target.workspace.create(where, started.base);
  const now = (context.now ?? Date.now)();
  const approved = latestApprovedStoryBlob(view.checkpoints, storyPath, now);
  const requirements = await requirementsAt(target.workspace, approved, storyPath);
  const hook = await target.workspace.installCommitHook(
    commitHookFiles({ id, requirements }, view.traceSkips ?? []),
  );
  return {
    status: "resumed",
    story: id,
    agent: started.agent,
    branch: started.branch,
    base: started.base,
    base_ref: started.base_ref,
    worktree: created.worktree,
    workdir: workdirOf(created.worktree, inspection.prefix),
    track: view.story?.fast_track?.status === "active" ? "fast" : "full",
    hook,
  };
}

function storyArgument(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "story",
    reason: `story ${reason} (story start <epic>-<story>, story pr <epic>-<story>, story ci <epic>-<story>)`,
  });
}

/**
 * `story start <id>`: the creator, or an agent at its terminal, starts a story.
 * `story pr <id>`: opens or updates the story's pull request.
 * `story ci <id> [--forge] [--waive "<reason>"]`: reads the CI of its pull request, or the
 * creator accepts the story without one.
 */
export const storyCommand = defineCommand<
  StoryStartResult | StoryPullRequestResult | CiCheckResult | CiWaiveResult
>({
  name: "story",
  async run(context, input) {
    const { action, story, forge, waive } = input as Record<string, unknown>;
    if (action !== "start" && action !== "pr" && action !== "ci") {
      return fail(storyArgument(String(action ?? "")));
    }
    if (typeof story !== "string" || !StoryIdSchema.safeParse(story).success) {
      return fail(storyArgument(`${action} ${String(story ?? "")}`.trim()));
    }
    if (action === "ci") {
      const read = await storyCi(context, story, { forge, waive });
      return read instanceof AgentPluggedError ? fail(read) : ok(read);
    }
    try {
      const result =
        action === "pr"
          ? await openPullRequest(context, story, { kind: "system" })
          : await startStory(context, story, { kind: "system" });
      return result instanceof AgentPluggedError ? fail(result) : ok(result);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** `start_story`: an agent starts a story in its own branch and worktree. */
export const startStoryCommand = defineCommand<StoryStartResult>({
  name: "start_story",
  audience: "agent",
  description:
    "Start a story before building it: `story` is `<epic>-<story>`, `agent` your own id (or `main`). Only the story's builder starts it: its owner in the sprint in force or an agent of the sprint's capacity (without a sprint, the story's owner). The engine checks that the story may start (validated at its current content on the main branch, in the sprint in force if any, every dependency done, not started yet), creates its branch (`feat/<id>-<slug>`) from the branch the creator's workflow lands stories on (`git` in `next`) and a Git worktree of its own, records `story.started`, moves the story to in_progress and installs the commit hook. It returns `worktree` and `workdir`: work only in `workdir`. With no branch per story (`story_branch: false`), nothing is created: `workdir` is the main working folder, no hook, no pull request. Calling it again resumes a story you started here, nothing recorded twice. Refused with STORY_NOT_STARTABLE, nothing created, and a `reason` (parallel_limit: the ceiling of stories built at once is reached; started_by_other: a story never has two developers; not_on_main: the approved story is not on the main branch yet; not_recorded: created but not recorded, run it again; the others say what is missing). With `fast_track` (`summary`: the change in one sentence; `declared`: `single_reading`, `reversible` and `no_public_interface`, each true) the story starts in the fast track, for a small change only (the constitution gives the limits), entered here and nowhere else (FAST_TRACK_NOT_POSSIBLE for a story already started). The engine reads your branch's changes at every pull request and CI read and sends the story back to the full lane, with a checkpoint for the creator, when they stop fitting; you leave it yourself with `leave_fast_track`. Every commit on the story's branch cites the story id and at least one of its requirements (`feat(2-3): … (EF-12)`), or the hook refuses it. It never opens a pull request nor merges.",
  inputSchema: StartStoryFastTrackInputSchema,
  async run(context, input) {
    const parsed = StartStoryFastTrackInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("start_story", parsed.error));
    const { agent, story, fast_track } = parsed.data;
    try {
      const result = await startStory(context, story, { kind: "agent", agent }, fast_track);
      return result instanceof AgentPluggedError ? fail(result) : ok(result);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
