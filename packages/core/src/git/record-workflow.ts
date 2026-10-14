import {
  type CreatorActionRecord,
  GIT_EVENT_TYPES,
  type GitReleasedPayload,
  type GitWorkflow,
  type GitWorkflowSetPayload,
  type GitWorkflowSource,
  resolveGitWorkflow,
  sameWorkflow,
} from "@agentplugged/protocol";
import { project } from "../agent-activity/agent-commands.js";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { loadMethodConfig } from "../init/method-config.js";
import { deliveryRemote, targetBranch } from "../stories/pull-request.js";
import { forgeRepositoryOf } from "../stories/story-forge.js";
import type { BranchEnsured } from "../stories/story-workspace.js";
import {
  lastRelease,
  repositoryOnForge,
  stagedStories,
  type WorkflowImplication,
  workflowImplications,
  workflowOf,
} from "./git-workflow.js";

/**
 * Recording the creator's Git workflow in the journal once `method.yaml` holds it:
 * `git.workflow_set`, the engine's own write, which the engine reads from then on. Also what the
 * change needs to land softly: the integration branch created when it is new, the pull requests
 * already open pointed at it. Called by `init` and `profile` at the terminal and by the engine
 * carrying out the creator's approved `profile` action in the chat; never by an agent.
 */

/** What recording a workflow did. */
export interface WorkflowRecorded {
  /**
   * `written`: the event is in the journal; `unchanged`: the journal already held this workflow;
   * `no_journal`: no journal here, `method.yaml` alone holds it.
   */
  readonly event: "written" | "unchanged" | "no_journal";
  readonly event_id?: string;
  /** What the change means for the work in progress, one sentence each. */
  readonly implications: readonly WorkflowImplication[];
  /** The integration branch: created, already there, or not creatable (its source is missing). */
  readonly branch?: BranchEnsured & { readonly name: string };
  /** The stories whose open pull request now targets the new branch (best effort). */
  readonly retargeted: readonly string[];
}

/** The branch a workflow lands the stories on, or undefined for the main branch. */
function integrationOf(workflow: GitWorkflow): string | undefined {
  return resolveGitWorkflow(workflow).integration;
}

/**
 * Writes `git.workflow_set` for the change from `previous` (none chosen before: undefined) to
 * `workflow`, and carries out what lets the work in progress follow. Nothing is refused: a failure
 * of the branch or of a pull request is said, never blocking (the workflow is the creator's).
 */
export async function recordGitWorkflow(
  context: CommandContext,
  change: { readonly workflow: GitWorkflow; readonly previous: GitWorkflow | undefined },
  source: GitWorkflowSource,
): Promise<WorkflowRecorded | AgentPluggedError> {
  const { workflow, previous } = change;
  const journal = context.journal;
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return loaded;
  if (journal === undefined) {
    return { event: "no_journal", implications: [], retargeted: [] };
  }
  const product = loaded.config.product_id ?? (await journal.productId());
  if (product === null) return { event: "no_journal", implications: [], retargeted: [] };

  // What the engine reads of the repository: on a forge or not, the main branch it has.
  const forge = await repositoryOnForge(context);
  const workspace = context.storyWorkspace;
  let main: string | undefined;
  try {
    const detected = await workspace?.detectWorkflow?.();
    main = detected?.repository === true ? (detected.main ?? undefined) : undefined;
  } catch {
    main = undefined;
  }

  // The integration branch exists before a story lands on it: created from the production branch.
  const integration = integrationOf(workflow);
  let branch: WorkflowRecorded["branch"];
  if (integration !== undefined && workspace?.ensureBranch !== undefined) {
    try {
      const ensured = await workspace.ensureBranch(integration, workflow.production);
      branch = { ...ensured, name: integration };
    } catch (error) {
      branch = {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
        name: integration,
      };
    }
  }

  const before = (await project(context, loaded.config, await journal.list())).state;
  const open = Object.values(
    (before.stories as Record<string, StoryLike> | undefined) ?? {},
  ).filter((story) => story.started !== undefined && story.merged === undefined).length;
  const implications = workflowImplications(
    resolveGitWorkflow(previous),
    resolveGitWorkflow(workflow),
    open,
  );

  const payload: GitWorkflowSetPayload = {
    workflow,
    previous: previous ?? null,
    source,
    forge,
    ...(main === undefined ? {} : { main }),
  };
  // The journal already says so (an edit of `method.yaml` by hand recorded again, a second run): nothing to add.
  if (sameWorkflow(workflowOf(before).workflow, workflow)) {
    return {
      event: "unchanged",
      implications: [],
      ...(branch === undefined ? {} : { branch }),
      retargeted: [],
    };
  }
  const [written] = await journal.appendAll([
    {
      type: GIT_EVENT_TYPES.workflowSet,
      actor: { kind: "system" },
      product,
      provenance: "trusted",
      payload,
    },
  ]);

  const retargeted = await retargetOpenPulls(context, loaded.config, journal).catch(() => []);
  return {
    event: "written",
    ...(written === undefined ? {} : { event_id: written.id }),
    implications,
    ...(branch === undefined ? {} : { branch }),
    retargeted,
  };
}

interface StoryLike {
  readonly started?: unknown;
  readonly merged?: unknown;
}

/**
 * Points the open pull requests of the stories in progress at the branch their story now lands on
 * (the projection already aims them there). Best effort: a pull request the forge cannot change is
 * updated by the next `open_pull_request`, and the merge says so (`base_changed`).
 */
async function retargetOpenPulls(
  context: CommandContext,
  config: Parameters<typeof project>[1],
  journal: NonNullable<CommandContext["journal"]>,
): Promise<string[]> {
  const forge = context.storyForge;
  if (forge?.retarget === undefined) return [];
  const state = (await project(context, config, await journal.list())).state;
  if (workflowOf(state).resolved.merge === "direct") return [];
  const stories =
    (state.stories as
      | Record<
          string,
          {
            started?: { branch: string; base: string; base_ref: string; worktree: string };
            merged?: unknown;
            pull_request?: { number: number; url: string; forge: string; base: string };
          }
        >
      | undefined) ?? {};
  const done: string[] = [];
  for (const [id, story] of Object.entries(stories)) {
    const { started, pull_request: pull } = story;
    if (started === undefined || pull === undefined || story.merged !== undefined) continue;
    if (started.worktree === ".") continue;
    try {
      const inspection = await forge.inspect(started.branch, started.base);
      if (!inspection.repository) continue;
      const remote = deliveryRemote(inspection.remotes, started.base_ref);
      if (remote === undefined) continue;
      const located = forgeRepositoryOf(remote.url);
      if (!("forge" in located) || located.forge !== pull.forge) continue;
      const wanted = targetBranch(started.base_ref, inspection.remotes);
      if (wanted === pull.base) continue;
      if ((await forge.cli(located)) !== "ready") continue;
      const current =
        forge.pullRequest === undefined ? undefined : await forge.pullRequest(located, pull.number);
      if (current?.state !== "open" || current.base === wanted) continue;
      await forge.retarget(located, pull.number, wanted);
      done.push(id);
    } catch {
      // The forge refused or cannot be reached: the next update of the pull request retargets it.
    }
  }
  return done;
}

/** What the release did, as the gesture reports it. */
export interface ReleaseDone {
  readonly merge_commit?: string | null | undefined;
  readonly pr?: number | undefined;
  readonly url?: string | undefined;
}

/**
 * Writes `git.released` once the engine put staging into production: the stories it
 * carried (those merged since the last release), the commit, how it went in. Only after the gesture
 * succeeded; a release the journal already holds for that commit is not written twice. Noah reads it
 * to count what waits in staging again from zero.
 */
export async function recordGitRelease(
  context: CommandContext,
  checkpoint: string,
  record: Extract<CreatorActionRecord, { kind: "release" }>,
  done: ReleaseDone,
): Promise<{ readonly event_id?: string } | AgentPluggedError> {
  const journal = context.journal;
  if (journal === undefined) return {};
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const product = loaded.config.product_id ?? (await journal.productId());
  if (product === null) return {};
  const state = (await project(context, loaded.config, await journal.list())).state;
  if (lastRelease(state)?.commit === record.commit) return {};
  const payload: GitReleasedPayload = {
    from: record.from,
    to: record.to,
    commit: record.commit,
    // The forge's own word, kept only when it is a commit: the record never fails on it.
    ...(typeof done.merge_commit === "string" &&
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(done.merge_commit)
      ? { merge_commit: done.merge_commit }
      : {}),
    via: done.pr === undefined ? "direct" : "pr",
    ...(done.pr === undefined ? {} : { pr: done.pr }),
    ...(done.url === undefined ? {} : { url: done.url }),
    stories: stagedStories(state).map((entry) => entry.story),
    checkpoint,
  };
  const [written] = await journal.appendAll([
    {
      type: GIT_EVENT_TYPES.released,
      actor: { kind: "system" },
      product,
      provenance: "trusted",
      payload,
    },
  ]);
  return written === undefined ? {} : { event_id: written.id };
}
