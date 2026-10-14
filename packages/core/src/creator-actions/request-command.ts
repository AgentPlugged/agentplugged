import {
  AgentContentSchema,
  CHECKPOINT_EVENT_TYPES,
  type CheckpointRisk,
  type CreatorActionRecord,
  CreatorActionSchema,
  ErrorCode,
  isSkillContent,
  isSkillOverrideContent,
  REQUIRED_CONTENT_FIELDS,
  RequestCreatorActionInputSchema,
  recommendedGitWorkflow,
  SkillContentSchema,
  SkillOverrideSchema,
} from "@agentplugged/protocol";
import { ZodError } from "zod";
import { agentEventCommand, invalidInput } from "../agent-activity/agent-commands.js";
import { branchHead } from "../ci/ci-check.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { AgentPluggedError, unavailable } from "../errors.js";
import { repositoryOnForge as onForge } from "../git/git-workflow.js";
import { skipWarning } from "../journey/journey-catalog.js";
import { skippedSteps } from "../journey/journey-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import { proofCommandsAsked, proofCommandsRecordOf } from "../proofs/proof-gesture.js";
import { actionUnchanged, currentRisk } from "./creator-action-execution.js";
import { contentProblem, dryRunFileAction, isFileAction } from "./creator-action-files.js";
import {
  actionStory,
  contentPreview,
  creatorActionCheckpoint,
  isCreatorActionKind,
  journalActionProblem,
  notReserved,
} from "./creator-action-rules.js";
import { engineUpdateRecordOf } from "./engine-update-gesture.js";
import { environmentFixRecordOf } from "./environment-fix-gesture.js";
import { forgeRecordOf } from "./forge-gestures.js";

/** What `request_creator_action` reads before the journal lock: the action as it will be recorded. */
export interface RequestPrepared {
  readonly record: CreatorActionRecord;
  readonly risk: CheckpointRisk;
  /** The risk and the lighter option of a step the creator skips, said once. */
  readonly warning?: { readonly dependents: readonly string[]; readonly sentence: string };
}

/** What `request_creator_action` returns besides the event: the checkpoint and how to answer it. */
export interface CreatorActionRequested {
  readonly id: string;
  readonly type: string;
  readonly at: string;
  readonly checkpoint: string;
  readonly kind: string;
  readonly risk: CheckpointRisk;
  readonly irreversible: boolean;
  /**
   * The definition of an agent or skill the request carries, whole: present it to
   * the creator as it is, nothing left out or reworded.
   */
  readonly preview?: string;
  /** How many declared proof commands did not fit and are asked next. */
  readonly later?: number;
  /**
   * The step the creator skips, with what rests on it and the one sentence to say,
   * once, in your question: the risk and the lightest option. Never repeated afterwards.
   */
  readonly journey?: {
    readonly step: string;
    readonly story: string | null;
    readonly dependents: readonly string[];
    readonly warning: string;
  };
}

/** `INVALID_ARGUMENTS` on a field of the action (`action.<field>`). */
export function invalidAction(error: Parameters<typeof invalidInput>[1]): AgentPluggedError {
  const refused = invalidInput("request_creator_action", error);
  const field = String(refused.details.field ?? "(root)");
  const named = field === "(root)" ? "action" : `action.${field}`;
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "request_creator_action",
    field: named,
    reason: String(refused.details.reason ?? "").replace(`: ${field}:`, `: ${named}:`),
  });
}

/**
 * What is wrong with the definition a request carries, or undefined: a creation's
 * must go with its `definition` (a skill's with `skill`), an edit's is of the kind its fields say;
 * parts left out are listed (`error.creator_action.content_required`, `missing`), any other fault
 * names its field (`action.content.<field>`).
 */
export function contentRequestProblem(
  action: Readonly<Record<string, unknown>>,
): AgentPluggedError | undefined {
  const raw = action.content;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return invalidAction(
      new ZodError([
        { code: "custom", path: ["content"], message: "expected an object", input: raw },
      ]),
    );
  }
  // The customisation of a skill shipped with the method has fields of its own.
  if (action.kind === "agent_edit" && isSkillOverrideContent(raw as Record<string, unknown>)) {
    const custom = SkillOverrideSchema.safeParse(raw);
    return custom.success
      ? undefined
      : invalidAction(
          new ZodError(
            custom.error.issues.map((issue) => ({ ...issue, path: ["content", ...issue.path] })),
          ),
        );
  }
  const skill = isSkillContent(raw as Record<string, unknown>);
  if (action.kind === "agent_create" && skill !== (action.definition === "skill")) {
    return invalidAction(
      new ZodError([
        {
          code: "custom",
          path: ["content"],
          message: skill
            ? "the content of a skill goes with definition: skill"
            : "the content of an agent goes with definition: agent",
          input: raw,
        },
      ]),
    );
  }
  const result = (skill ? SkillContentSchema : AgentContentSchema).safeParse(raw);
  if (result.success) return undefined;
  const required: readonly string[] = REQUIRED_CONTENT_FIELDS[skill ? "skill" : "agent"];
  const missing = result.error.issues
    .filter((issue) => issue.path.length === 1 && issue.path[0] !== undefined)
    .filter((issue) => issue.code === "invalid_type" && required.includes(String(issue.path[0])))
    .filter((issue) => (raw as Record<string, unknown>)[String(issue.path[0])] === undefined)
    .map((issue) => `content.${String(issue.path[0])}`);
  if (missing.length > 0) {
    return new AgentPluggedError(
      ErrorCode.INVALID_ARGUMENTS,
      "error.creator_action.content_required",
      {
        id: String(action.id ?? ""),
        missing: missing.join(", "),
      },
    );
  }
  return invalidAction(
    new ZodError(
      result.error.issues.map((issue) => ({ ...issue, path: ["content", ...issue.path] })),
    ),
  );
}

/**
 * The action as it will be recorded, checked like its terminal command would check it, and its
 * risk: the kind is one a request covers (`CREATOR_ACTION_NOT_RESERVED`), its arguments are valid
 * (`INVALID_ARGUMENTS`), the journal allows it (`journalActionProblem`), a CI waiver reads the
 * head of the story's branch, and a file action is tried on `DryRunFiles` by its command (its
 * errors, or `CREATOR_ACTION_UNCHANGED` when it would change nothing).
 */
async function prepareRequest(
  input: { readonly action: Readonly<Record<string, unknown>>; readonly reason: string },
  context: CommandContext,
): Promise<RequestPrepared> {
  const kind = input.action.kind;
  if (!isCreatorActionKind(kind)) throw notReserved(String(kind), "unknown_kind");
  // A definition is checked apart, for the kind it is written for, so that the error names the
  // field (`action.content.menu.0.code`) or lists what to add, never a union.
  if ((kind === "agent_create" || kind === "agent_edit") && input.action.content !== undefined) {
    const problem = contentRequestProblem(input.action);
    if (problem !== undefined) throw problem;
  }
  const parsed = CreatorActionSchema.safeParse(input.action);
  if (!parsed.success) throw invalidAction(parsed.error);
  const action = parsed.data;
  const state = await currentState(context);
  let record: CreatorActionRecord;
  if (action.kind === "ci_waive") {
    const problem = journalActionProblem(
      { ...action, commit: "0".repeat(40), reason: input.reason },
      state,
    );
    if (problem !== undefined) throw problem;
    const workspace = context.storyWorkspace;
    if (workspace === undefined) throw unavailable("no Git workspace");
    const started = (storyIn(state, action.story) as StoryState).started as NonNullable<
      StoryState["started"]
    >;
    const head = await branchHead(workspace, action.story, started.branch);
    if (head instanceof AgentPluggedError) throw head;
    record = { ...action, commit: head, reason: input.reason };
  } else if (
    action.kind === "forge_repo_create" ||
    action.kind === "forge_push_main" ||
    action.kind === "forge_merge_ci" ||
    action.kind === "release"
  ) {
    // A gesture of the forge. The engine reads the repository (the commit, the
    // repository Git pushes to) and refuses what it does not allow; what is already so is
    // `CREATOR_ACTION_UNCHANGED`.
    const made = await forgeRecordOf(context, action, input.reason);
    if (made instanceof AgentPluggedError) throw made;
    if (made.already) throw actionUnchanged(made.record);
    record = made.record;
  } else if (action.kind === "environment_fix") {
    // The command is the engine's reading of its catalogue for this machine, never the
    // agent's; a check that is fine is `CREATOR_ACTION_UNCHANGED`, one the engine cannot repair by
    // itself `CREATOR_ACTION_NOT_RESERVED` (`not_automatic`).
    const made = await environmentFixRecordOf(context, action, input.reason);
    if (made instanceof AgentPluggedError) throw made;
    record = made;
  } else if (action.kind === "proof_commands") {
    // The lines are the engine's reading of `.agentplugged/proofs.yaml`, never the
    // agent's; nothing new or modified to accept is `CREATOR_ACTION_UNCHANGED`.
    const made = await proofCommandsRecordOf(context, action, input.reason);
    if (made instanceof AgentPluggedError) throw made;
    record = made;
  } else if (action.kind === "engine_update") {
    // The version is the engine's reading (the product's pin, or the registry's
    // announcement), never the agent's; nothing to install and no setting to change is
    // `CREATOR_ACTION_UNCHANGED`.
    const made = await engineUpdateRecordOf(context, action, input.reason);
    if (made instanceof AgentPluggedError) throw made;
    record = made;
  } else if (action.kind === "profile" && action.workflow === "recommended") {
    // « garde la recommandation ». The engine fills it in for this repository (on a forge
    // or not), so that the creator reads the choices themselves before they answer.
    const forge = await onForge(context);
    record = {
      ...action,
      workflow: recommendedGitWorkflow({ forge }),
      reason: input.reason,
    };
    const problem = journalActionProblem(record, state);
    if (problem !== undefined) throw problem;
  } else {
    record = { ...action, reason: input.reason } as CreatorActionRecord;
    const problem = journalActionProblem(record, state);
    if (problem !== undefined) throw problem;
  }
  const missing = contentProblem(record);
  if (missing !== undefined) throw missing;
  if (isFileAction(record)) {
    const outcome = await dryRunFileAction(context, record);
    if (outcome instanceof AgentPluggedError) throw outcome;
    if (!outcome.changed) throw actionUnchanged(record);
  }
  const risk = await currentRisk(context, state, record);
  if (record.kind !== "step_skip") return { record, risk };
  return { record, risk, warning: skipWarning(record.step, skippedSteps(state)) };
}

const requestEvents = agentEventCommand<typeof RequestCreatorActionInputSchema, RequestPrepared>({
  name: "request_creator_action",
  description: "",
  inputSchema: RequestCreatorActionInputSchema,
  prepare: (input, context) => prepareRequest(input, context),
  events: (_input, _state, prepared) => {
    const { record, risk } = prepared as RequestPrepared;
    return {
      events: [
        {
          type: CHECKPOINT_EVENT_TYPES.opened,
          story: actionStory(record),
          payload: {
            ...creatorActionCheckpoint(
              record,
              risk,
              (prepared as RequestPrepared).warning?.sentence,
            ),
          },
        },
      ],
    };
  },
  // The journal as it is when written: the story, the item or the deviation still allow it.
  check: (_input, state, { prepared }) =>
    journalActionProblem((prepared as RequestPrepared).record, state),
});

/** What a skip says once: the step, what rests on it, the sentence. */
function journeyOf(
  record: Extract<CreatorActionRecord, { kind: "step_skip" }>,
  state: Readonly<Record<string, unknown>>,
): NonNullable<CreatorActionRequested["journey"]> {
  const warning = skipWarning(record.step, skippedSteps(state));
  return {
    step: record.step,
    story: record.story ?? null,
    dependents: warning.dependents,
    warning: warning.sentence,
  };
}

/**
 * `request_creator_action`: an agent asks the creator for one of the actions reserved
 * to them, typed (`action.kind` and the arguments of its terminal command) with the creator's
 * reason. The engine checks it as the terminal would, then opens a `creator_action` checkpoint
 * whose risk, irreversibility, title and summary it sets itself; nothing else is written. The
 * creator answers it like any checkpoint (`answer_checkpoint`, `review`); the engine carries the
 * action out once approved, never the agent.
 */
export const requestCreatorActionCommand = defineCommand<CreatorActionRequested>({
  name: "request_creator_action",
  audience: "agent",
  description:
    'Ask the creator, in this chat, for an action only the creator decides, instead of telling them to type a command. `action.kind` and its arguments: `ci_waive` {story}, `deferred_resolve` {item}, `deferred_drop` {item}, `trace_resolve` {deviation}, `profile` {profile?, validation? chat|auto|strict, installs? visible|validate, points? the points they keep among framing|architecture|breakdown|merge|release|publication ([]: none), workflow? their Git workflow, whole or `recommended`}, `agent_create` {id, definition? agent|skill, name?, title, description, domain, phase, icon?, role?, content}, `agent_edit` {id, tier?, tool?} or {id, content, layer?} (on a shipped skill, content is its customisation, layer shared|personal), `agent_enable` {id}, `agent_disable` {id}, the forge gestures, done by the engine once approved: `forge_repo_create` {forge github|gitlab, name, owner?, visibility? private|public}, `forge_push_main` {} (never forced), `forge_merge_ci` {branch}, `step_skip` / `step_resume` {step, story?} (on their word only, never yours; say `journey.warning` once), `release` {} (staging into production), `environment_fix` {check} (a `check_environment` point with `how: request`), `proof_commands` {commands? names, require? engine|any} (the lines of .agentplugged/proofs.yaml that are new or modified, or those named: the engine records them, show `preview` to the creator as it is; `later` = lines asked next; `require: engine` demands at the release proofs the engine ran or read), `scope_widen` {story, paths} (what a refused write named; a folder ends with /), `engine_update` {install?: true, check?, auto?}: the update next/get_state name (the engine reads the version); check: false stops asking the registry, auto: true installs without asking; the session moves to it at your next call. `reason`: theirs, one line, or `no reason given`. The engine checks it as the command of the same name would, then opens a `creator_action` checkpoint (G-…) whose risk, title and summary it sets itself. Then ask_creator when `validation.channels.available` holds more than chat (a click returns `executed`); otherwise, or on `answered: false` with `channel: "chat"`, present it and record the answer with answer_checkpoint (`approved`, `rejected` or `changes_requested`, quoting their whole message). Once approved, the engine carries it out and returns `executed`; never run the command yourself. Refused: nothing written (CREATOR_ACTION_NOT_RESERVED, INVALID_ARGUMENTS, CREATOR_ACTION_UNCHANGED).',
  inputSchema: RequestCreatorActionInputSchema,
  // The way out of a session older than the product's pin is the update itself.
  allowsOlderEngine: (_context, input) =>
    (input.action as { kind?: unknown } | undefined)?.kind === "engine_update",
  async run(context, input) {
    const result = await requestEvents.run(context, input);
    if (!result.ok) return fail(result.error);
    const parsed = RequestCreatorActionInputSchema.parse(input);
    // Read back from the journal: the checkpoint opened and the action as recorded.
    const state = await currentState(context);
    const checkpoint = result.value.checkpoint as string;
    const opened = (
      state.checkpoints as Record<
        string,
        { creator_action?: CreatorActionRecord; risk: CheckpointRisk }
      >
    )[checkpoint];
    const record = opened?.creator_action;
    if (record === undefined || opened === undefined) {
      throw new Error(`request_creator_action: ${checkpoint} was not applied`);
    }
    return ok({
      id: result.value.id,
      type: result.value.type,
      at: result.value.at,
      checkpoint,
      kind: String(parsed.action.kind),
      risk: opened.risk,
      irreversible: false,
      ...(contentPreview(record) === undefined ? {} : { preview: contentPreview(record) }),
      ...(record.kind === "proof_commands" ? await proofCommandsAsked(context, record) : {}),
      ...(record.kind === "step_skip" ? { journey: journeyOf(record, state) } : {}),
    });
  },
});
