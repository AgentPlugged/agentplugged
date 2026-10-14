import {
  type GitCiMode,
  type GitMergeMode,
  type GitWorkflow,
  GitWorkflowSchema,
  type GitWorkflowSource,
  type ResolvedGitWorkflow,
  resolveGitWorkflow,
  sameWorkflow,
} from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import {
  editedMethodText,
  methodConfigInvalid,
  openMethodDocument,
} from "../init/method-config.js";
import type { StoryState } from "../projection/agent-reducers.js";

/**
 * The creator's Git workflow as the engine reads it, pure. The journal is the
 * authority (`state.git_workflow`, written by `git.workflow_set`): the creator's choice, never an
 * agent's edit of a file; `method.yaml` (`git`) holds the same choice where the creator can read
 * and change it. Nothing chosen: the recommendation for a solo creator applies, which is what the
 * engine did before the creator could choose. No rule of the engine supposes a workflow of its
 * own: every guard (merge, CI, review) reads this.
 */

type State = Readonly<Record<string, unknown>>;

/** `state.git_workflow`: the last choice, as the reducer keeps it. */
export interface WorkflowRecord {
  readonly workflow: GitWorkflow;
  /** The repository was on GitHub or GitLab when it was chosen. */
  readonly forge: boolean;
  readonly source: GitWorkflowSource;
  readonly at: string;
  readonly event: string;
  /** How many stories were merged when it was chosen: what waits in staging starts after them. */
  readonly merges: number;
}

/** `state.git_release`: the last release (`main` + `dev`), as the reducer keeps it. */
export interface ReleaseRecord {
  readonly from: string;
  readonly to: string;
  readonly commit: string;
  readonly merge_commit: string | null;
  readonly via: "pr" | "direct";
  readonly pr: number | null;
  readonly url: string | null;
  readonly stories: readonly string[];
  readonly checkpoint: string;
  readonly at: string;
  readonly event: string;
  /** How many stories were merged when it was released: those after wait in staging again. */
  readonly merges: number;
}

/** What the projection says of the workflow. */
export interface WorkflowView {
  /** The creator chose a workflow (else the recommendation applies). */
  readonly chosen: boolean;
  /** What was chosen, whole; undefined when nothing was. */
  readonly workflow: GitWorkflow | undefined;
  /** The choices with their defaults applied: every field has a value. */
  readonly resolved: ResolvedGitWorkflow;
  /** The repository was on a forge when it was chosen; undefined when nothing was chosen. */
  readonly forge: boolean | undefined;
  readonly record: WorkflowRecord | undefined;
}

/** The workflow in force in a projection's state. */
export function workflowOf(state: State): WorkflowView {
  const record = state.git_workflow as WorkflowRecord | undefined;
  return {
    chosen: record !== undefined,
    workflow: record?.workflow,
    resolved: resolveGitWorkflow(record?.workflow),
    forge: record?.forge,
    record,
  };
}

/** The last release in a projection's state, if any. */
export function lastRelease(state: State): ReleaseRecord | undefined {
  return state.git_release as ReleaseRecord | undefined;
}

/** A story merged and not yet released: it waits in staging. */
export interface StagedStory {
  readonly story: string;
  readonly at: string;
  readonly seq: number;
}

/**
 * The stories that wait in staging (`main` + `dev`): merged since the workflow was chosen and since
 * the last release, oldest first. Empty without an integration branch: a story is in production
 * as soon as it is merged.
 */
export function stagedStories(state: State): StagedStory[] {
  const view = workflowOf(state);
  if (!view.resolved.staged || view.record === undefined) return [];
  const since = Math.max(view.record.merges, lastRelease(state)?.merges ?? 0);
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  return Object.entries(stories)
    .flatMap(([story, entry]) =>
      entry.merged === undefined || entry.merged.seq <= since
        ? []
        : [{ story, at: entry.merged.at, seq: entry.merged.seq }],
    )
    .sort((a, b) => a.seq - b.seq);
}

/** Validates a workflow given by a caller; the error points at `git.<field>`. */
export function validateGitWorkflow(value: unknown): GitWorkflow | AgentPluggedError {
  const result = GitWorkflowSchema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const path = ["git", ...(issue?.path ?? []).map(String)];
  return methodConfigInvalid(path.join("."), issue?.message ?? "invalid");
}

/**
 * Writes the workflow (`git`) into the text of `method.yaml`, replacing the section
 * whole. Comments and other keys are kept; the result is validated before being returned.
 */
export function writeGitWorkflow(text: string, workflow: GitWorkflow): string | AgentPluggedError {
  const document = openMethodDocument(text);
  if (document instanceof AgentPluggedError) return document;
  document.setIn(["git"], document.createNode(workflow));
  return editedMethodText(document, text);
}

/** True when the repository is on GitHub or GitLab (what the recommendation of a workflow depends on). */
export async function repositoryOnForge(
  context: Pick<CommandContext, "ciReader">,
): Promise<boolean> {
  try {
    return (await context.ciReader?.repository())?.forge != null;
  } catch {
    return false;
  }
}

/** What a change of workflow means for the work in progress, one sentence each. */
export type WorkflowImplication =
  | { readonly code: "integration"; readonly branch: string; readonly stories: number }
  | { readonly code: "production"; readonly branch: string }
  | { readonly code: "story_branches"; readonly on: boolean; readonly stories: number }
  | { readonly code: "ci"; readonly mode: GitCiMode }
  | { readonly code: "merge"; readonly mode: GitMergeMode }
  | { readonly code: "review"; readonly on: boolean };

/**
 * What the change from `previous` to `next` means, so that the creator hears it once with the
 * answer: the stories open now aim at the new integration branch, the merges no longer wait for a
 * CI or a review, and so on. `open` is how many stories are started and not merged.
 */
export function workflowImplications(
  previous: ResolvedGitWorkflow,
  next: ResolvedGitWorkflow,
  open: number,
): WorkflowImplication[] {
  const found: WorkflowImplication[] = [];
  if (previous.integration !== next.integration) {
    found.push(
      next.integration === undefined
        ? { code: "production", branch: next.production ?? "main" }
        : { code: "integration", branch: next.integration, stories: open },
    );
  }
  if (previous.story_branches !== next.story_branches) {
    found.push({ code: "story_branches", on: next.story_branches, stories: open });
  }
  if (previous.ci !== next.ci) found.push({ code: "ci", mode: next.ci });
  if (previous.merge !== next.merge) found.push({ code: "merge", mode: next.merge });
  if (previous.review !== next.review) found.push({ code: "review", on: next.review });
  return found;
}

/** True when two workflows (or none) say the same. */
export const sameGitWorkflow = sameWorkflow;
