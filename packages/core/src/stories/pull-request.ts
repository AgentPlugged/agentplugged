import { fromUtf8, gitBlobId, sha256Hex } from "@agentplugged/crypto";
import {
  CHECKPOINT_EVENT_TYPES,
  checkpointIdOf,
  ErrorCode,
  type ForgeId,
  type ForgeLinkReason,
  MAIN_SESSION_AGENT,
  type MethodConfig,
  type OpenPullRequestInput,
  OpenPullRequestInputSchema,
  type PullRequestFailure,
  type PullRequestReason,
  type PullRequestTestStatus,
  STORY_EVENT_TYPES,
  type StoryHeader,
  type StoryPrOpenedPayload,
} from "@agentplugged/protocol";
import {
  agentWriteContext,
  invalidInput,
  project,
  provenanceOf,
} from "../agent-activity/agent-commands.js";
import { currentDeveloper } from "../agents/agent-aliases.js";
import {
  blockingCheckpoint,
  checkpointPayload,
  truncate,
} from "../checkpoints/checkpoint-rules.js";
import { statusAt } from "../checkpoints/resolution-rules.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { commitNoticesWithStory } from "../docs/knowledge-notice.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { AgentPluggedError, unavailable } from "../errors.js";
import {
  type FastTrackOutcome,
  fastTrackEvents,
  outcomeOf,
  readFastTrack,
} from "../fast-track/fast-track-check.js";
import { workflowOf } from "../git/git-workflow.js";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { isSkipped } from "../journey/journey-rules.js";
import { storyFiles } from "../merge/story-files.js";
import type { StoryPullRequest } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { sessionTrust } from "../trust/session.js";
import {
  acceptanceCriteria,
  pullRequestTitle,
  renderPullRequestBody,
  withoutCost,
} from "./pull-request-body.js";
import {
  type ForgePullRequest,
  type ForgeRemote,
  type ForgeRepository,
  forgeCli,
  forgeRepositoryOf,
  isRepositoryPullRequest,
  type PullRequestDraft,
  type StoryForge,
} from "./story-forge.js";
import { cliTarget, latestApprovedStoryBlob, storyJournalView } from "./story-start.js";
import type { StoryWorkspace } from "./story-workspace.js";

/** What `story pr` and `open_pull_request` did. */
export interface StoryPullRequestResult {
  /**
   * `opened`: created now; `updated`: an open one whose title and text were replaced (or adopted
   * as it was); `unchanged`: the forge already holds the text rendered and the journal knows it
   * (nothing pushed, touched nor written).
   */
  readonly status: "opened" | "updated" | "unchanged";
  readonly story: string;
  readonly forge: ForgeId;
  readonly number: number;
  readonly url: string;
  readonly branch: string;
  readonly base: string;
  readonly head: string;
  readonly title: string;
  readonly criteria: { readonly checked: number; readonly total: number };
  readonly tests: PullRequestTestStatus;
  /**
   * What the engine read of a story in the fast track: whether its changes still fit
   * a small change, and whether this write sent it back to the full lane. Absent when the story is
   * not in the fast track or the engine read this commit already.
   */
  readonly fast_track?: FastTrackOutcome;
  /** The event written, only when written now. */
  readonly event?: { readonly id: string; readonly type: string; readonly at: string };
}

/** `PULL_REQUEST_NOT_OPENABLE`: why the pull request cannot open; nothing pushed nor written. */
export function notOpenable(
  story: string,
  reason: PullRequestReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.PULL_REQUEST_NOT_OPENABLE,
    `error.pull_request_not_openable.${reason}`,
    { story, reason, ...details },
  );
}

/** `FORGE_NOT_LINKED`: the forge is not linked; nothing pushed. */
export function forgeNotLinked(
  story: string,
  reason: ForgeLinkReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.FORGE_NOT_LINKED, `error.forge_not_linked.${reason}`, {
    story,
    reason,
    ...details,
  });
}

/** Known token formats of GitHub and GitLab, and authorization headers. */
const TOKENS = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|glpat-[A-Za-z0-9_-]{8,}|gl(?:oas|dt|rt|cbt|ptt|ft|imt|agent|soat)-[A-Za-z0-9_-]{8,})/g,
  /\b(authorization|private-token|job-token|x-gitlab-token)\s*[:=]\s*[^\s,;]+(?:\s+[^\s,;]+)?/gi,
  /\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * A message on one line, at most 300 characters, without an address's credentials nor a token
 * (`ghp_…`, `gho_…`, `github_pat_…`, `glpat-…`, `Authorization: …`): masked as `***`.
 */
export function oneLine(message: string): string {
  let flat = message.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@/\s]*@/gi, "$1");
  const [plain, header, scheme] = TOKENS as [RegExp, RegExp, RegExp];
  flat = flat
    .replace(plain, "***")
    .replace(header, (_match, name: string) => `${name}: ***`)
    .replace(scheme, (_match, name: string) => `${name} ***`)
    .replace(/\s+/g, " ")
    .trim();
  return truncate(flat === "" ? "no message" : flat, 300);
}

/** `PULL_REQUEST_FAILED`: the push or the forge failed, or the pull request was not recorded. */
export function pullRequestFailed(
  story: string,
  reason: PullRequestFailure,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.PULL_REQUEST_FAILED,
    `error.pull_request_failed.${reason}`,
    { story, reason, message: oneLine(message), ...details },
  );
}

/**
 * Who opens the pull request: the story's agent through the MCP server, with its report of the
 * criteria and the tests, or the CLI (the engine, `system`).
 */
type Opener =
  | {
      readonly kind: "agent";
      readonly agent: string;
      readonly report: Pick<OpenPullRequestInput, "criteria" | "tests">;
    }
  | { readonly kind: "system" };

interface OpenTarget {
  readonly product: string;
  readonly journal: StateStore;
  readonly config: MethodConfig;
  readonly workspace: StoryWorkspace;
  readonly forge: StoryForge;
}

async function openTarget(
  context: CommandContext,
  opener: Opener,
): Promise<OpenTarget | AgentPluggedError> {
  const base =
    opener.kind === "system"
      ? await cliTarget(context)
      : await agentWriteContext(context, opener.agent);
  if (base instanceof AgentPluggedError) return base;
  const workspace = context.storyWorkspace;
  if (workspace === undefined) return unavailable("no Git workspace");
  const forge = context.storyForge;
  if (forge === undefined) return unavailable("no forge");
  return { product: base.product, journal: base.journal, config: base.config, workspace, forge };
}

/** The remote `baseRef` names (`<remote>/<branch>`): the longest remote name that prefixes it. */
function remoteOfRef(remotes: readonly ForgeRemote[], baseRef: string): ForgeRemote | undefined {
  return remotes
    .filter((remote) => baseRef.startsWith(`${remote.name}/`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/**
 * The remote a story delivers to: the one its main branch was read from (`origin/main` →
 * `origin`; the longest remote name when several prefix it), else `origin` (that remote was
 * removed since), else the only remote.
 */
export function deliveryRemote(
  remotes: readonly ForgeRemote[],
  baseRef: string,
): ForgeRemote | undefined {
  const named = remoteOfRef(remotes, baseRef);
  if (named !== undefined) return named;
  const origin = remotes.find((remote) => remote.name === "origin");
  if (origin !== undefined) return origin;
  return remotes.length === 1 ? remotes[0] : undefined;
}

/**
 * The branch a pull request targets: the main branch's name, without its remote. A base read from
 * a remote removed since (`upstream/main`) loses its first segment too: `story.started` reads the
 * main branch locally (`main`) or from a remote (`<remote>/main`), never a local name with `/`.
 */
export function targetBranch(baseRef: string, remotes: readonly ForgeRemote[]): string {
  const remote = remoteOfRef(remotes, baseRef);
  if (remote !== undefined) return baseRef.slice(remote.name.length + 1);
  const slash = baseRef.indexOf("/");
  return slash === -1 ? baseRef : baseRef.slice(slash + 1);
}

/** How to link the forge, in English like every payload: the summary of the checkpoint. */
export function linkInstructions(
  reason: ForgeLinkReason,
  details: { readonly forge?: ForgeId; readonly host?: string; readonly remote?: string },
): string {
  const host = details.host ?? "github.com";
  const cli = details.forge === undefined ? undefined : forgeCli(details.forge);
  const steps: Record<ForgeLinkReason, string> = {
    no_remote:
      "The repository has no remote. Create the repository on GitHub or GitLab, then add it: `git remote add origin <address>`.",
    unknown_forge: `Git pushes the remote \`${details.remote ?? "origin"}\` to ${host}, which is neither GitHub nor GitLab: the engine opens pull requests only with \`gh\` (GitHub) or \`glab\` (GitLab). Point \`origin\` (and its push address) at a GitHub or GitLab repository.`,
    cli_missing:
      cli === "glab"
        ? "Install the GitLab CLI (`glab`, https://gitlab.com/gitlab-org/cli), then log in once: `glab auth login --hostname " +
          `${host}\`.`
        : "Install the GitHub CLI (`gh`, https://cli.github.com), then log in once: `gh auth login --hostname " +
          `${host}\`.`,
    not_logged_in:
      cli === "glab"
        ? `Log in the GitLab CLI once, at your terminal: \`glab auth login --hostname ${host}\`.`
        : `Log in the GitHub CLI once, at your terminal: \`gh auth login --hostname ${host}\`.`,
  };
  return `${steps[reason]} Nothing was pushed. Once it is linked, approve this checkpoint and ask the agent to open the pull request again. The token stays with the tool: agents never read it.`;
}

/** The open checkpoint that says how to link the forge for the story, the first opened. */
function openLinkCheckpoint(
  checkpoints: Iterable<CheckpointState>,
  id: string,
  now: number,
): CheckpointState | undefined {
  return [...checkpoints]
    .filter(
      (checkpoint) =>
        checkpoint.source === "forge_unlinked" &&
        checkpoint.story === id &&
        statusAt(checkpoint, now) === "open",
    )
    .sort((a, b) => (a.opened_event < b.opened_event ? -1 : 1))[0];
}

/** Thrown under the journal's lock: another call opened the checkpoint meanwhile. */
class LinkCheckpointOpened extends Error {
  constructor(readonly checkpoint: string) {
    super("forge checkpoint already open");
  }
}

/**
 * The checkpoint that tells the creator how to link the forge (MCP only): an open one of the same
 * kind for the story is reused, also when another call opened it meanwhile (checked again under
 * the journal's lock), else one is opened (`permission`, `low`, no block,
 * `source: forge_unlinked`). Returns its id.
 */
async function linkCheckpoint(
  context: CommandContext,
  target: OpenTarget,
  agent: string,
  id: string,
  reason: ForgeLinkReason,
  details: { readonly forge?: ForgeId; readonly host?: string; readonly remote?: string },
): Promise<string> {
  const listing = await target.journal.list();
  const state = (await project(context, target.config, listing)).state;
  const now = (context.now ?? Date.now)();
  const open = openLinkCheckpoint(Object.values(checkpointsOf(state)), id, now);
  if (open !== undefined) return open.id;
  const trust = await sessionTrust(context, target.config, listing.events);
  // A `permission`: approving a `story` checkpoint would mark the story done.
  const payload = {
    ...checkpointPayload({
      type: "permission",
      risk: "low",
      title: truncate(`Link the forge to deliver story ${id}`, 120),
      summary: truncate(linkInstructions(reason, details), 2000),
    }),
    source: "forge_unlinked" as const,
  };
  try {
    const [event] = await target.journal.appendAll(
      [
        {
          type: CHECKPOINT_EVENT_TYPES.opened,
          actor: { kind: "agent", agent },
          product: target.product,
          story: id,
          provenance: provenanceOf(trust),
          payload,
        },
      ],
      {
        precondition: async (current: JournalListing) => {
          const latest = (await project(context, target.config, current)).state;
          const already = openLinkCheckpoint(
            Object.values(checkpointsOf(latest)),
            id,
            (context.now ?? Date.now)(),
          );
          if (already !== undefined) throw new LinkCheckpointOpened(already.id);
        },
      },
    );
    if (event === undefined) throw new Error("open_pull_request: no checkpoint was written");
    return checkpointIdOf(event.id);
  } catch (error) {
    if (error instanceof LinkCheckpointOpened) return error.checkpoint;
    throw error;
  }
}

/** `CHECKPOINT_OPEN`: an open checkpoint blocks the story's review, which a pull request asks. */
function checkpointOpen(checkpoint: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.CHECKPOINT_OPEN, "error.checkpoint_open", {
    checkpoint,
    action: "story.review",
  });
}

/**
 * The checks and the criteria of the CLI: the last pull request's, when they are about the same
 * commit and the same criteria; else everything unchecked and the tests not reported (never
 * « passed » for code nobody tested).
 */
function recordedReport(
  last: StoryPullRequest | undefined,
  total: number,
  head: string,
): { criteria: boolean[]; tests: PullRequestTestStatus; summary: string | undefined } {
  if (last === undefined || last.criteria.length !== total || last.head !== head) {
    return {
      criteria: Array.from({ length: total }, () => false),
      tests: "not_reported",
      summary: undefined,
    };
  }
  return {
    criteria: [...last.criteria],
    tests: last.tests as PullRequestTestStatus,
    summary: last.tests_summary ?? undefined,
  };
}

/** A text as compared with the forge's: line endings and trailing blank lines ignored. */
function comparable(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

/**
 * Opens or updates a story's pull request: checks the story (started, by this agent,
 * not done, its approved version readable, the agent's report), the blocks, the branch, then the
 * forge (the remote Git pushes to, tool, login: else `FORGE_NOT_LINKED`, with a checkpoint for an
 * agent); renders the fixed text, looks for the branch's pull request (`unchanged` when the forge
 * already holds it: nothing pushed), pushes the branch (never the target branch, never forced),
 * creates or updates it, and writes `story.pr_opened`.
 */
export async function openPullRequest(
  context: CommandContext,
  id: string,
  opener: Opener,
): Promise<StoryPullRequestResult | AgentPluggedError> {
  const target = await openTarget(context, opener);
  if (target instanceof AgentPluggedError) return target;
  const { journal, config, workspace, forge } = target;
  const now = (context.now ?? Date.now)();
  const listing = await journal.list();
  const state = (await project(context, config, listing)).state;
  const view = storyJournalView(state, id, now);
  const document = (await readSprintStories(context.files)).get(id);

  if (document === undefined) return notOpenable(id, "unknown_story");
  const started = view.story?.started;
  if (started === undefined) return notOpenable(id, "not_started");
  if (
    opener.kind === "agent" &&
    opener.agent !== currentDeveloper(started.agent) &&
    opener.agent !== MAIN_SESSION_AGENT
  ) {
    return notOpenable(id, "not_builder", { agent: opener.agent, builder: started.agent });
  }
  if (view.done(id)) return notOpenable(id, "done");
  // The creator's workflow has no pull request: nothing to open, the story goes to its
  // review and its merge as it is.
  const flow = workflowOf(state).resolved;
  if (flow.merge === "direct" || started.worktree === ".") {
    return notOpenable(id, "not_wanted", { merge: flow.merge });
  }
  // A skipped contract reads the story's file as it is, even if it was approved once.
  const validated =
    view.skips?.contract === true
      ? undefined
      : latestApprovedStoryBlob(view.checkpoints, document.path, now);
  // A story the creator never validated, whose contract they skipped, is read as it is.
  const unvalidatedByChoice = validated === undefined && view.skips?.contract === true;
  if (validated === undefined && !unvalidatedByChoice) {
    return notOpenable(id, "not_validated", { path: document.path });
  }
  const approved = validated ?? gitBlobId(document.bytes);
  const text =
    validated === undefined ? fromUtf8(document.bytes) : await workspace.readBlob(validated);
  const parsed = text === undefined ? undefined : parseDocumentFile(document.path, text);
  const header = parsed?.header as StoryHeader | undefined;
  if (parsed === undefined || header === undefined) {
    return notOpenable(id, "unreadable", { path: document.path, blob: approved });
  }
  const criteria = acceptanceCriteria(parsed);
  if (opener.kind === "agent") {
    const { report } = opener;
    // The creator skipped the contract (criteria) or the CI (tests): not refusals.
    if (report.criteria.length !== criteria.length && view.skips?.contract !== true) {
      return notOpenable(id, "criteria_count", {
        expected: criteria.length,
        given: report.criteria.length,
      });
    }
    if (report.tests.status !== "passed" && !isSkipped(state, "story_ci", id)) {
      return notOpenable(id, "tests_not_passed", { status: report.tests.status });
    }
  }
  const blocking = blockingCheckpoint(view.checkpoints, "story.review", id, now);
  if (blocking !== undefined) return checkpointOpen(blocking.id);

  let inspection = await forge.inspect(started.branch, started.base);
  if (!inspection.repository) {
    return new AgentPluggedError(ErrorCode.NOT_A_GIT_REPO, "error.not_a_git_repo", { path: "." });
  }
  if (inspection.head === null) {
    return notOpenable(id, "branch_missing", { branch: started.branch });
  }
  // The pages this story puts behind get their late notice in a commit of the engine
  // on the story's own branch (its worktree stays clean), so it reaches the main branch with the
  // merge of the pull request. The branch's head moves, so it is read again.
  if (inspection.commits !== 0) {
    const reviewed = inspection.head;
    const noticed = await commitNoticesWithStory(
      {
        files: context.files,
        storyWorkspace: workspace,
        ...(context.now ? { now: context.now } : {}),
      },
      state,
      { id, files: async () => (await storyFiles(context, started, reviewed)).files },
      started.branch,
    );
    if (noticed) {
      const again = await forge.inspect(started.branch, started.base);
      if (again.repository && again.head !== null) inspection = again;
    }
  }
  if (!inspection.repository || inspection.head === null) {
    return notOpenable(id, "branch_missing", { branch: started.branch });
  }
  const head = inspection.head;
  if (inspection.commits === 0 || (inspection.commits === null && head === started.base)) {
    return notOpenable(id, "no_commits", { branch: started.branch });
  }

  // A story in the fast track: the engine reads the head's changes against its criteria.
  const reading = await readFastTrack(context, view.story, head);

  // The forge: the remote Git pushes to, on GitHub or GitLab, its tool installed and logged in.
  // Else nothing is pushed, and an agent leaves a checkpoint that says how to link it.
  const unlinked = async (
    reason: ForgeLinkReason,
    details: { forge?: ForgeId; host?: string; remote?: string; cli?: string },
  ) => {
    const checkpoint =
      opener.kind === "agent"
        ? await linkCheckpoint(context, target, opener.agent, id, reason, details)
        : undefined;
    return forgeNotLinked(id, reason, {
      ...details,
      ...(checkpoint === undefined ? {} : { checkpoint }),
    });
  };
  const remote = deliveryRemote(inspection.remotes, started.base_ref);
  if (remote === undefined) return unlinked("no_remote", {});
  const located = forgeRepositoryOf(remote.url);
  if (!("forge" in located)) {
    // A local path names no host: said as such, never the address (it may hold credentials).
    return unlinked("unknown_forge", { remote: remote.name, host: located.host ?? "local" });
  }
  const repository: ForgeRepository = located;
  const forgeCall = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof AgentPluggedError) throw error;
      throw pullRequestFailed(
        id,
        "forge_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const cli = await forgeCall(() => forge.cli(repository));
  if (cli !== "ready") {
    return unlinked(cli === "missing" ? "cli_missing" : "not_logged_in", {
      forge: repository.forge,
      host: repository.host,
      cli: forgeCli(repository.forge),
    });
  }

  // The branch's pull requests on the repository itself (never a fork's): the open one recorded
  // in the journal first, else the first open one.
  // The branch the creator's workflow lands the stories on (`started.base_ref` follows
  // their choice, also for a story started before it: nothing is lost, its pull request is
  // retargeted here).
  const base = targetBranch(started.base_ref, inspection.remotes);
  // The integration branch (`dev`) must be at the remote for a pull request to target it: published
  // once, from where this repository holds it, never forced.
  if (flow.integration !== undefined && forge.remoteBranch !== undefined) {
    const landing = await forgeCall(() => forge.inspect(base, started.base));
    const tip = landing.repository ? landing.head : null;
    if (tip !== null) {
      const there = await forgeCall(() =>
        (forge.remoteBranch as NonNullable<typeof forge.remoteBranch>)(remote.name, base, tip),
      );
      if (there.state === "missing" && forge.pushMain !== undefined) {
        const published = await forgeCall(() =>
          (forge.pushMain as NonNullable<typeof forge.pushMain>)(remote.name, base, tip),
        );
        if (!published.ok) return pullRequestFailed(id, published.reason, published.message);
      }
    }
  }
  const last = view.story?.pull_request;
  const existing = (await forgeCall(() => forge.pullRequests(repository, started.branch))).filter(
    (entry) => isRepositoryPullRequest(repository, entry.url, entry.number),
  );
  const opened = existing.filter((entry) => entry.state === "open");
  const open: ForgePullRequest | undefined =
    opened.find((entry) => entry.number === last?.number) ?? opened[0];
  const merged = existing.find((entry) => entry.state === "merged");
  if (open === undefined && merged !== undefined) {
    return notOpenable(id, "already_merged", { url: merged.url });
  }

  // The fixed text, from the approved story and the projection.
  const report =
    opener.kind === "agent"
      ? {
          criteria: [...opener.report.criteria],
          tests: opener.report.tests.status as PullRequestTestStatus,
          summary: opener.report.tests.summary,
        }
      : recordedReport(last, criteria.length, head);
  const title = pullRequestTitle(id, header.title);
  const body = renderPullRequestBody({
    story: {
      id,
      title: header.title,
      path: `${inspection.prefix}${document.path}`,
      blob: approved,
      requirements: header.requirements,
    },
    repository,
    branch: started.branch,
    base,
    head,
    criteria: criteria.map((criterion, index) => ({
      text: criterion,
      checked: report.criteria[index] === true,
    })),
    tests: { status: report.tests, summary: report.summary },
  });
  // The digest ignores the cost section older pull requests carry: it matches what was recorded.
  const digest = sha256Hex(`${title}\n${withoutCost(body)}`);
  const draft: PullRequestDraft = { base, branch: started.branch, title, body };
  const result = {
    story: id,
    forge: repository.forge,
    branch: started.branch,
    base,
    head,
    title,
    criteria: {
      checked: report.criteria.filter((checked) => checked).length,
      total: criteria.length,
    },
    tests: report.tests,
  };

  // The forge already holds this very text: nothing to push nor to edit.
  const same =
    open !== undefined && open.title === title && comparable(open.body) === comparable(body);
  const known = open !== undefined && last?.number === open.number && last.body_sha256 === digest;
  if (same && known && open !== undefined) {
    // Nothing to push, but the engine may still owe the reading of this commit.
    if (reading !== undefined) {
      const trust =
        opener.kind === "agent" ? await sessionTrust(context, config, listing.events) : undefined;
      await journal.appendAll(
        fastTrackEvents(reading, {
          id,
          checkpoints: view.checkpoints,
          writer: {
            actor:
              opener.kind === "agent" ? { kind: "agent", agent: opener.agent } : { kind: "system" },
            product: target.product,
            provenance: trust === undefined ? "trusted" : provenanceOf(trust),
          },
        }),
      );
    }
    return {
      status: "unchanged",
      ...result,
      number: open.number,
      url: open.url,
      ...(reading === undefined ? {} : { fast_track: outcomeOf(reading) }),
    };
  }

  if (!same) {
    const pushed = await forge.push(remote.name, started.branch, base);
    if (!pushed.ok) return pullRequestFailed(id, pushed.reason, pushed.message);
  }
  let action: "opened" | "updated";
  let pullRequest: { number: number; url: string };
  if (open !== undefined) {
    if (!same) await forgeCall(() => forge.update(repository, open.number, draft));
    action = "updated";
    pullRequest = { number: open.number, url: open.url };
  } else {
    pullRequest = await forgeCall(() => forge.create(repository, draft));
    if (!isRepositoryPullRequest(repository, pullRequest.url, pullRequest.number)) {
      return pullRequestFailed(
        id,
        "forge_failed",
        `the pull request created (${pullRequest.url}) is not on ${repository.host}/${repository.path}`,
      );
    }
    action = "opened";
  }

  const payload: StoryPrOpenedPayload = {
    forge: repository.forge,
    number: pullRequest.number,
    url: pullRequest.url,
    action,
    branch: started.branch,
    base,
    head,
    criteria: report.criteria,
    tests: report.tests,
    ...(report.summary === undefined ? {} : { tests_summary: truncate(report.summary, 1000) }),
    body_sha256: digest,
  };
  const trust =
    opener.kind === "agent" ? await sessionTrust(context, config, listing.events) : undefined;
  let event: { id: string; type: string; at: string } | undefined;
  const writer = {
    actor:
      opener.kind === "agent"
        ? { kind: "agent" as const, agent: opener.agent }
        : { kind: "system" as const },
    product: target.product,
    provenance: trust === undefined ? ("trusted" as const) : provenanceOf(trust),
  };
  try {
    [event] = await journal.appendAll([
      { type: STORY_EVENT_TYPES.prOpened, ...writer, story: id, payload },
      // The engine's reading of the commit, in the same write.
      ...(reading === undefined
        ? []
        : fastTrackEvents(reading, { id, checkpoints: view.checkpoints, writer })),
    ]);
  } catch (error) {
    // The pull request exists on the forge: the next call finds it and records it.
    return pullRequestFailed(
      id,
      "not_recorded",
      error instanceof AgentPluggedError ? error.code : String(error),
      { url: pullRequest.url },
    );
  }
  if (event === undefined) throw new Error("story pr: nothing was written");
  return {
    status: action,
    ...result,
    number: pullRequest.number,
    url: pullRequest.url,
    ...(reading === undefined ? {} : { fast_track: outcomeOf(reading) }),
    event: { id: event.id, type: event.type, at: event.at },
  };
}

/** `open_pull_request`: the agent that builds a story delivers it. */
export const openPullRequestCommand = defineCommand<StoryPullRequestResult>({
  name: "open_pull_request",
  audience: "agent",
  description:
    "Deliver a story you built as a pull request with the fixed template: `story` is `<epic>-<story>`, `agent` your own id (the agent that started it, or `main`). Give `criteria`, one boolean per acceptance criterion of the approved story in its order (true when met), and `tests` (`status`: passed, failed or not_run; `summary`: what ran and the result); only `passed` delivers. The engine renders the text itself (story, requirements, acceptance criteria as checkboxes, tests), pushes the story's branch (never the main branch, never forced), then opens or updates the pull request with the forge's command-line tool the creator logged in (`gh` for GitHub, `glab` for GitLab), and records `story.pr_opened`. Calling it again updates the same pull request (`updated`), or touches nothing when the forge already holds its text (`unchanged`). Never run `gh` or `glab` yourself: creating, editing, commenting, reviewing, closing, merging, reading the token and calling the API are denied. Refused with PULL_REQUEST_NOT_OPENABLE, nothing pushed (unknown_story, not_started, not_builder, done, not_validated, unreadable, criteria_count, tests_not_passed, branch_missing, no_commits: commit first, already_merged, not_wanted: the creator's workflow has no pull request, the engine merges the branch itself or the story has no branch of its own: send the story to review); CHECKPOINT_OPEN while a checkpoint blocks the story's review; FORGE_NOT_LINKED when there is no remote, Git pushes somewhere that is neither GitHub nor GitLab, or the tool is missing or not logged in: nothing is pushed and a checkpoint (`details.checkpoint`) tells the creator how to link it; wait for it, then call again. PULL_REQUEST_FAILED when the push is refused (push_rejected: fetch and rebase your branch, never force; push_failed: a remote hook or a protected branch), the forge fails, or the pull request was opened but not recorded (not_recorded: call again). It never merges, reviews nor runs CI.",
  inputSchema: OpenPullRequestInputSchema,
  async run(context, input) {
    const parsed = OpenPullRequestInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("open_pull_request", parsed.error));
    const { agent, story, criteria, tests } = parsed.data;
    try {
      const result = await openPullRequest(context, story, {
        kind: "agent",
        agent,
        report: { criteria, tests },
      });
      return result instanceof AgentPluggedError ? fail(result) : ok(result);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});
