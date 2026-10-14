import {
  type CheckpointOpenedPayload,
  type CheckpointRisk,
  CREATOR_ACTION_KINDS,
  CREATOR_OWNER,
  type CreatorActionKind,
  type CreatorActionNotReservedReason,
  type CreatorActionRecord,
  contentSections,
  DEFAULT_VALIDATION_MODE,
  ErrorCode,
  engineUpdateRisk,
  type GitWorkflow,
  isSkillOverrideContent,
  isStoryStep,
  proofCommandsRisk,
  resolveGitWorkflow,
  type SkillOverride,
  VALIDATION_POINTS,
  type ValidationMode,
  type ValidationPoint,
} from "@agentplugged/protocol";
import {
  LOADED_FILE_CAP,
  renderSkillCustomisation,
  SECTION_CAP,
} from "../agents/skill-overrides.js";
import { costOfDraft } from "../agents/workshop-build.js";
import type { Draft } from "../agents/workshop-rules.js";
import { confirmationFor, recipientFor, truncate } from "../checkpoints/checkpoint-rules.js";
import { journalProblem } from "../ci/ci-check.js";
import { openItem } from "../deferred/deferred-rules.js";
import { AgentPluggedError } from "../errors.js";
import { JOURNEY_CATALOG } from "../journey/journey-catalog.js";
import { isSkipped, isSkippedExactly } from "../journey/journey-rules.js";
import { proofCommandsEffect, proofCommandsTitle } from "../proofs/proof-gesture-text.js";
import { openDeviation } from "../trace/deviation-rules.js";

/**
 * The rules of the creator's actions asked from the chat, pure functions: what each
 * action risks, its checkpoint's title and summary, the terminal command it stands for, and
 * whether the journal still allows it. The engine sets them all, never the agent.
 */

const COMMAND = "npx agentplugged";

/** `CREATOR_ACTION_NOT_RESERVED`: not an action the creator decides through a request. */
export function notReserved(
  kind: string,
  reason: CreatorActionNotReservedReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_NOT_RESERVED,
    `error.creator_action_not_reserved.${reason}`,
    {
      kind,
      reason,
      ...(reason === "unknown_kind" ? { kinds: CREATOR_ACTION_KINDS.join(", ") } : {}),
      ...details,
    },
  );
}

/** `CREATOR_ACTION_UNCHANGED`: a step already skipped, or not skipped to take up. */
function skipUnchanged(record: CreatorActionRecord): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.CREATOR_ACTION_UNCHANGED,
    "error.creator_action_unchanged",
    { kind: record.kind },
  );
}

/** True for a kind of action a request may ask for. */
export function isCreatorActionKind(kind: unknown): kind is CreatorActionKind {
  return typeof kind === "string" && (CREATOR_ACTION_KINDS as readonly string[]).includes(kind);
}

/** The order of the validation levels, from the loosest to the strictest. */
const LEVELS: readonly ValidationMode[] = ["auto", "chat", "strict"];

/** What the risk of an action depends on besides the action itself. */
export interface RiskContext {
  /**
   * The action weakens security work: a `deferred_drop` of an item about security (its
   * recorder's domain, or its words), a `profile` that turns the `security` domain off, an
   * `agent_disable` of an agent of that domain. Unknown (definitions unreadable): true.
   */
  readonly security?: boolean;
  /** `profile`: the validation levels in force (main branch) and in the working copy. */
  readonly levels?: readonly ValidationMode[];
  /**
   * `profile`: the points the creator keeps, in force (main branch) and in the working copy (story
   * 3.29); absent: they keep every point. Keeping fewer than one of them is a lowering.
   */
  readonly points?: readonly (readonly ValidationPoint[])[];
  /** `profile`: the request removes a check of the merge (the CI, the review, the pull request) that is in force. */
  readonly workflowLoosened?: boolean;
}

/**
 * The risk of an action, fixed by the engine: a CI waiver is high (a story merges without its
 * CI); dropping deferred work is medium, high when it is about security; lifting a deviation is
 * medium; closing deferred work is low; a profile change is high when it lowers the validation
 * level below one in force or turns the security domain off, medium otherwise; creating an agent
 * is medium (high in the security or quality domain: a reviewer of the merge gate), disabling one
 * too (high for a security agent); completing an agent's definition is medium (it replaces files);
 * an agent's settings or enabling it is low.
 */
export function actionRisk(record: CreatorActionRecord, context: RiskContext = {}): CheckpointRisk {
  switch (record.kind) {
    case "ci_waive":
      return "high";
    case "deferred_drop":
      return context.security === true ? "high" : "medium";
    case "deferred_resolve":
      return "low";
    case "trace_resolve":
      return "medium";
    case "profile": {
      if (context.security === true || context.workflowLoosened === true) return "high";
      // Keeping fewer points than one in force hands more to the agents: a lowering,
      // which at the `strict` level goes to the terminal like any lowering of the level.
      const keptAsked = record.points;
      if (
        keptAsked !== undefined &&
        (context.points ?? [VALIDATION_POINTS]).some((kept) =>
          kept.some((point) => !keptAsked.includes(point)),
        )
      ) {
        return "high";
      }
      if (record.validation === undefined) return "medium";
      const asked = LEVELS.indexOf(record.validation);
      const current = (context.levels ?? [DEFAULT_VALIDATION_MODE]).map((mode) =>
        LEVELS.indexOf(mode),
      );
      return current.some((level) => asked < level) ? "high" : "medium";
    }
    case "agent_disable":
      return context.security === true ? "high" : "medium";
    case "agent_create":
      // A new agent of the security or quality domain becomes a reviewer of the merge gate.
      return record.domain === "security" || record.domain === "quality" ? "high" : "medium";
    case "agent_edit":
      // A definition replaces the body and the menu of files the creator may have written.
      return record.content === undefined ? "low" : "medium";
    case "agent_enable":
      return "low";
    // The creation of a private repository is a medium risk, a public one a high
    // one; the push and the merge reach the creator's forge and cannot be undone from here.
    case "forge_repo_create":
      return record.visibility === "public" ? "high" : "medium";
    case "forge_push_main":
    case "forge_merge_ci":
      return "high";
    // Putting staging into production reaches the public product.
    case "release":
      return "high";
    // The risk of skipping a step is the step's own; taking it up again weakens nothing.
    case "step_skip":
      return JOURNEY_CATALOG[record.step].risk;
    case "step_resume":
      return "low";
    // An installation, or the automatic updates turned on, changes the code that runs.
    case "engine_update":
      return engineUpdateRisk(record);
    // A repair installs or sets something on the creator's machine, with the command
    // they read: a medium risk, whatever the check.
    case "environment_fix":
      return "medium";
    // Accepting commands lets the engine run programs here (medium); setting only what
    // the release demands of the proofs runs nothing (low).
    case "proof_commands":
      return proofCommandsRisk(record);
    // Letting the guard pass files the story did not name changes no rule of security
    // (a secret and a decision are still refused): low for named files and folders, medium when
    // a path uses a wildcard or opens a whole top-level folder.
    case "scope_widen":
      return record.paths.some(
        (path) => /[*?]/.test(path) || !path.replace(/\/$/, "").includes("/"),
      )
        ? "medium"
        : "low";
  }
}

/** Where the creator types their own reason in a terminal command. */
const REASON = '"<reason>"';

/**
 * The terminal command an action stands for, for the creator who prefers the terminal. It never
 * holds a text the agent wrote (the reason, an agent's title or role): a shell would run what is
 * slipped into it (`"; …`, `$(…)`), whatever the quoting. The creator types the reason, and the
 * questions of `agent create` ask for the free texts; only identifiers and choices are filled in.
 */
export function terminalCommand(record: CreatorActionRecord): string {
  switch (record.kind) {
    case "ci_waive":
      return `${COMMAND} story ci ${record.story} --waive ${REASON}`;
    case "deferred_resolve":
      return `${COMMAND} deferred resolve ${record.item} ${REASON}`;
    case "deferred_drop":
      return `${COMMAND} deferred drop ${record.item} ${REASON}`;
    case "trace_resolve":
      return `${COMMAND} trace resolve ${record.deviation} ${REASON}`;
    case "profile": {
      // A custom profile is chosen by the questions of `profile`; the level and the installs mode
      // by their options.
      const options = [
        ...(record.validation === undefined ? [] : [` --validation ${record.validation}`]),
        ...(record.installs === undefined ? [] : [` --installs ${record.installs}`]),
        ...(record.points === undefined
          ? []
          : [` --points ${record.points.length === 0 ? "none" : record.points.join(",")}`]),
        ...(record.workflow === undefined ? [] : workflowOptions(record.workflow)),
      ].join("");
      return `${COMMAND} profile${options}`;
    }
    // The terminal's `agent create` writes a template to fill: a definition is approved in the
    // chat, the form or `review`, which shows it whole.
    case "agent_create":
    case "agent_edit":
      if (record.content !== undefined) return `${COMMAND} review`;
      return record.kind === "agent_create" ? createCommand(record) : editCommand(record);
    case "agent_enable":
      return `${COMMAND} agent enable ${record.id}`;
    case "agent_disable":
      return `${COMMAND} agent disable ${record.id}`;
    // The gestures of the forge are done by the engine, never by a command typed here: at the
    // terminal, `review` answers the request, and the engine carries it out the same way.
    case "forge_repo_create":
    case "forge_push_main":
    case "forge_merge_ci":
    case "release":
      return `${COMMAND} review`;
    // A step of the journey is skipped by an answer, in the chat or at `review`; no command of its own.
    case "step_skip":
    case "step_resume":
      return `${COMMAND} review`;
    // The engine's update is done by the engine once approved, never by a command typed here.
    case "engine_update":
      return `${COMMAND} review`;
    // A repair of the machine: the terminal has `doctor`, which shows the command and runs it.
    case "environment_fix":
      return `${COMMAND} doctor`;
    // The accord is given by an answer, in the chat or at `review`; no command of its own.
    case "proof_commands":
      return `${COMMAND} review`;
    // The scope is widened by an answer, in the chat or at `review`; no command of its own.
    case "scope_widen":
      return `${COMMAND} review`;
  }
}

function createCommand(record: Extract<CreatorActionRecord, { kind: "agent_create" }>): string {
  const options = (["domain", "phase"] as const)
    .filter((field) => record[field] !== undefined)
    .map((field) => ` --${field} ${record[field]}`)
    .join("");
  const skill = record.definition === "skill" ? " --skill" : "";
  return `${COMMAND} agent create ${record.id}${skill}${options}`;
}

function editCommand(record: Extract<CreatorActionRecord, { kind: "agent_edit" }>): string {
  const tier = record.tier === undefined ? "" : ` --tier ${record.tier}`;
  const tool = record.tool === undefined ? "" : ` --tool ${record.tool}`;
  return `${COMMAND} agent edit ${record.id}${tier}${tool}`;
}

/** The points the creator keeps, in words. */
function pointsText(points: readonly ValidationPoint[] | undefined): string {
  return points === undefined || points.length === 0 ? "none" : points.join(", ");
}

function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The options of `profile` that say a workflow, identifiers and choices only. */
function workflowOptions(workflow: GitWorkflow): string[] {
  const flow = resolveGitWorkflow(workflow);
  return [
    ` --branches ${flow.integration === undefined ? "main" : `${flow.production ?? "main"}+${flow.integration}`}`,
    ` --story-branches ${flow.story_branches ? "yes" : "no"}`,
    ` --ci ${flow.ci}`,
    ` --merge ${flow.merge}`,
    ` --review ${flow.review ? "yes" : "no"}`,
  ];
}

/** A workflow in words, in English (the journal's language): where the work lands and how. */
export function workflowText(workflow: GitWorkflow): string {
  const flow = resolveGitWorkflow(workflow);
  const branches =
    flow.integration === undefined
      ? "the work lands on the main branch, which is also production"
      : `stories land on ${flow.integration} (staging) and ${flow.production ?? "the main branch"} is production, which a release feeds from ${flow.integration}`;
  const ci =
    flow.ci === "none"
      ? "no CI (a merge never waits for one)"
      : flow.ci === "local"
        ? "a CI on your own machine (a self-hosted runner, read through the forge; without a forge, the developers run the checks and the merge does not wait for a CI)"
        : "a CI on the forge's servers, read before every merge";
  return [
    branches,
    flow.story_branches
      ? "one branch and one working copy per story"
      : "no branch per story (the work is done on the branch it lands on)",
    ci,
    flow.merge === "pr"
      ? "stories merge through a pull request"
      : "stories are merged by the engine, without a pull request",
    flow.review ? "a review before every merge" : "no review before a merge",
  ].join("; ");
}

/** The checkpoint's title, in English (the journal's language): what the creator decides. */
function titleOf(record: CreatorActionRecord): string {
  const title = baseTitleOf(record);
  if (record.kind !== "profile" || record.workflow === undefined) return title;
  // The Git workflow alone has a title of its own; with other settings it is added to theirs.
  const alone =
    record.profile === undefined &&
    record.validation === undefined &&
    record.installs === undefined &&
    record.points === undefined;
  return alone ? "Choose the Git workflow" : `${title}, and the Git workflow`;
}

function baseTitleOf(record: CreatorActionRecord): string {
  switch (record.kind) {
    case "ci_waive":
      return `Accept story ${record.story} without its CI`;
    case "deferred_resolve":
      return `Mark deferred work ${record.item} as done`;
    case "deferred_drop":
      return `Drop deferred work ${record.item}`;
    case "trace_resolve":
      return `Lift deviation ${record.deviation}`;
    case "profile": {
      const kept = pointsText(record.points);
      if (record.profile === undefined) {
        if (record.validation === undefined && record.installs === undefined) {
          return `Choose the points of validation: ${kept}`;
        }
        const alone =
          record.validation === undefined
            ? `Set the installs mode to ${record.installs}`
            : record.installs === undefined
              ? `Set the validation level to ${record.validation}`
              : `Set the validation level to ${record.validation} and the installs mode to ${record.installs}`;
        return record.points === undefined
          ? alone
          : `${alone}, and the points of validation: ${kept}`;
      }
      const base =
        record.validation === undefined
          ? `Change the product's profile to ${record.profile.preset}`
          : `Change the profile to ${record.profile.preset} and the validation level to ${record.validation}`;
      const withInstalls =
        record.installs === undefined
          ? base
          : `${base}, and the installs mode to ${record.installs}`;
      return record.points === undefined
        ? withInstalls
        : `${withInstalls}, and the points of validation: ${kept}`;
    }
    case "agent_create":
      return `Create the ${record.definition ?? "agent"} ${record.id}`;
    case "agent_edit":
      return record.content === undefined
        ? `Change the settings of agent ${record.id}`
        : isSkillOverrideContent(record.content)
          ? `Customise the skill ${record.id}${record.layer === "personal" ? " (your own layer)" : ""}`
          : `Complete the definition of ${record.id}`;
    case "agent_enable":
      return `Enable ${record.id}`;
    case "agent_disable":
      return `Disable ${record.id}`;
    case "forge_repo_create":
      return `Create the ${record.visibility ?? "private"} ${record.forge === "github" ? "GitHub" : "GitLab"} repository ${record.owner === undefined ? "" : `${record.owner}/`}${record.name}`;
    case "forge_push_main":
      return `Push the main branch (${record.branch}) to ${record.target}`;
    case "forge_merge_ci":
      return `Merge the CI pull request of ${record.branch} into ${record.base} on ${record.target}`;
    case "release":
      return `Put into production: merge ${record.from} into ${record.to}${record.stories === undefined ? "" : ` (${record.stories} stories)`}`;
    case "step_skip":
      return `Skip ${JOURNEY_CATALOG[record.step].label}${record.story === undefined ? "" : ` for story ${record.story}`}`;
    case "step_resume":
      return `Take up ${JOURNEY_CATALOG[record.step].label} again${record.story === undefined ? "" : ` for story ${record.story}`}`;
    case "engine_update": {
      const settings = [
        ...(record.check === undefined
          ? []
          : [`${record.check ? "check" : "stop checking"} the registry for engine updates`]),
        ...(record.auto === undefined
          ? []
          : [`${record.auto ? "turn on" : "turn off"} the automatic engine updates`]),
      ];
      if (record.install !== true) return capitalized(settings.join(" and "));
      const install = `Update the engine to ${record.version}`;
      return settings.length === 0 ? install : `${install}, and ${settings.join(" and ")}`;
    }
    case "environment_fix":
      return `Repair ${record.check} on this machine: run ${record.command}`;
    case "proof_commands":
      return proofCommandsTitle(record);
    case "scope_widen":
      return `Let story ${record.story} write ${record.paths.length === 1 ? record.paths[0] : `${record.paths.length} more places`}`;
  }
}

/** What carrying the action out does, in English. */
function effectOf(record: CreatorActionRecord): string {
  switch (record.kind) {
    case "ci_waive":
      return `The story's merge no longer waits for its CI, for commit ${record.commit.slice(0, 12)} only (a newer commit is not covered). It cannot be undone.`;
    case "deferred_resolve":
      return "The item is closed as done; the stories it locks may start and merge again.";
    case "deferred_drop":
      return "The item is dropped: nobody will treat it, and the stories it locks may start and merge again.";
    case "trace_resolve":
      return "The deviation is lifted: the story's merge no longer waits for it.";
    case "profile": {
      const parts = [
        ...(record.profile === undefined
          ? []
          : [
              `profile ${record.profile.preset} (domains ${record.profile.domains.join(", ")}; phases ${record.profile.phases.join(", ")}; developer specialties ${record.profile.specialties.join(", ") || "none"})`,
            ]),
        ...(record.validation === undefined ? [] : [`validation level ${record.validation}`]),
        ...(record.points === undefined
          ? []
          : [
              `points of validation kept for the creator: ${pointsText(record.points)} (every other point is decided by the agent responsible for it, with its reason in the journal, and the creator can reopen it at any time)`,
            ]),
        ...(record.workflow === undefined
          ? []
          : [
              `Git workflow (${workflowText(record.workflow)}); the stories in progress follow it without losing any work: their branch stays, only the branch they land on changes, and the engine records the choice in the journal`,
            ]),
        ...(record.installs === undefined
          ? []
          : [
              record.installs === "visible"
                ? "installs mode visible (an installation the approved architecture declares goes through without a validation and shows in the activity; any other still needs one; only Claude Code can do it, in another AI tool every installation keeps its validation)"
                : "installs mode validate (every installation is validated, one by one)",
            ]),
      ];
      return `.agentplugged/method.yaml records ${parts.join(" and ")}, then the AI tools' files are generated again (sync). The validation level applies once merged into the main branch.`;
    }
    case "agent_create": {
      const folder = `.agentplugged/${record.definition === "skill" ? "skills" : "agents"}/${record.id}/`;
      return record.content === undefined
        ? "Refused when approved: a request must carry the complete definition, so nothing will be written (the terminal's `agent create` writes a template to fill)."
        : `Its files are written in ${folder} with exactly the definition recorded in this request (no template text), then the AI tools' files are generated again (sync).${
            record.definition !== "skill" &&
            (record.domain === "security" || record.domain === "quality")
              ? ` Its domain is ${record.domain}: it counts among the reviewers of the merge gate.`
              : ""
          }`;
    }
    case "agent_edit":
      if (record.content !== undefined && isSkillOverrideContent(record.content)) {
        const file = `.agentplugged/overrides/skills/${record.id}${record.layer === "personal" ? ".local" : ""}.yaml`;
        return `${file} is written with exactly the customisation recorded in this request, replacing what it holds now; the method's own ${record.id} is never changed, and the customisation lifts none of its rules. ${record.layer === "personal" ? "The file is ignored by Git: it is yours alone, and read when the skill runs." : "Then the AI tools' files are generated again (sync): every tool gets it."}`;
      }
      if (record.content !== undefined) {
        return `In the files of ${record.id} under .agentplugged/, the WHOLE body of SKILL.md is replaced by the definition recorded in this request and, for an agent, so are the principles and the whole menu of agent.yaml (and its identity, communication style and persistent facts when the definition gives them): whatever is written there now is lost. The rest stays. Then the AI tools' files are generated again (sync).`;
      }
      return `.agentplugged/method.yaml records${record.tier === undefined ? "" : ` model tier ${record.tier}`}${record.tier !== undefined && record.tool !== undefined ? " and" : ""}${record.tool === undefined ? "" : ` preferred tool ${record.tool}`}, then the AI tools' files are generated again (sync).`;
    case "agent_enable":
      return "It becomes callable in the AI tools (method.yaml, then sync). A developer whose specialty is off also turns that specialty on in the profile.";
    case "agent_disable":
      return "It is no longer callable in the AI tools: sync removes its generated files.";
    case "forge_repo_create":
      return `The engine creates the ${record.visibility ?? "private"} repository ${record.owner === undefined ? "" : `${record.owner}/`}${record.name} on ${record.forge === "github" ? "GitHub" : "GitLab"} with the forge's tool you connected (${record.forge === "github" ? "gh" : "glab"}), and adds it as the remote origin of this repository. When origin already is a public repository, it is instead a private one added as the remote agentplugged-journal, where the engine saves the product's journal (the journal never goes to a public repository). Nothing is pushed. It cannot be undone from here: a repository is deleted at the forge.`;
    case "forge_push_main":
      return `The engine pushes commit ${record.commit.slice(0, 12)} of branch ${record.branch} to ${record.target}, as its branch ${record.branch} (git push, never forced: only while that branch is empty or behind, with no divergence), and does it only if origin still points to ${record.target}. It cannot be undone from here.`;
    case "forge_merge_ci":
      return `The engine opens the pull request of branch ${record.branch} on ${record.target} when there is none (its title and text are fixed by the engine), then merges it into ${record.base} on commit ${record.commit.slice(0, 12)} only (the forge checks it), without deleting the branch nor bypassing the forge's protections. The pull request changes only these files, read by the engine: ${record.files === undefined ? "(not recorded)" : record.files.join(", ")}. It cannot be undone from here.`;
    case "release":
      return `The engine puts commit ${record.commit.slice(0, 12)} of ${record.from} into ${record.to}, which is production${record.target === undefined ? "" : `: it opens the pull request from ${record.from} into ${record.to} on ${record.target} when there is none (its title and text are fixed by the engine), then merges it on that commit only (the forge checks it), without bypassing the forge's protections`}. Without a pull request (your workflow merges directly) it merges ${record.from} into ${record.to} itself, in your repository, and does not push. Any automatic deployment of ${record.to} then follows. ${record.stories === undefined ? "" : `${record.stories} merged stories were waiting in staging. `}It is undone by a revert.`;
    case "step_skip": {
      const info = JOURNEY_CATALOG[record.step];
      const scope =
        record.story !== undefined
          ? ` for story ${record.story}`
          : isStoryStep(record.step)
            ? " for every story"
            : "";
      return `The engine no longer ${info.effect}${scope}: the step is shown as skipped, never as an error, and the checks of that step become warnings. Nothing else changes; you can take it up again at any time.`;
    }
    case "step_resume":
      return `The step is proposed again: the engine asks for it as before. Nothing already done is undone.`;
    case "engine_update": {
      const parts = [
        ...(record.install === true
          ? [
              `The engine installs version ${record.version} of the package agentplugged from the npm registry, in its own folder (the version running now is never replaced), then pins it in .agentplugged/method.yaml and refreshes the method and the AI tools' files with it. This session moves to it at its next call, without reconnecting.`,
            ]
          : []),
        ...(record.check === undefined
          ? []
          : [
              record.check
                ? "The engine asks the registry at most twice a day whether a version is out (one request, nothing of the project is sent)."
                : "The engine never asks the registry whether a version is out.",
            ]),
        ...(record.auto === undefined
          ? []
          : [
              record.auto
                ? "A version the registry announces is installed without a question (recorded, and said once)."
                : "A version the registry announces is only proposed, never installed without your yes.",
            ]),
      ];
      return parts.join(" ");
    }
    case "environment_fix":
      return `The engine runs this command on this machine, exactly as written, and nothing else: ${record.command}. It may install a program or change a setting through your system's own package manager (which may ask for your password). It then looks at the check again and tells you what it finds. It reads and writes no login token. If the command fails, nothing else is done.`;
    case "proof_commands":
      return proofCommandsEffect(record);
    case "scope_widen":
      return `The guard before a write lets story ${record.story} write ${record.paths.join(", ")} from now on (a folder ending with / and everything under it). It still refuses a secret and a decision of the architecture it contradicts. Recorded in the journal; nothing else changes.`;
  }
}

const SECTION_LABELS: Readonly<Record<string, string>> = {
  overview: "Overview",
  produces: "Produces",
  works: "How it works",
  never: "Never does",
  principles: "Principles",
  menu: "Menu",
  identity: "Identity",
  communication_style: "Communication style",
  persistent_facts: "Persistent facts",
  facts: "Facts",
  steps: "Steps",
  steps_before: "Before the first step",
  steps_after: "After the last step",
  checks: "Also verified before it ends",
  when_done: "When done",
  output_model: "Model of the output",
  reviewers: "Reviewers of this product",
  outputs: "Outputs",
  rules: "Rules",
  references: "References (files of detail, read only when a step needs them)",
};

/**
 * The definition a request carries, as the engine rewrites it for the agent to show the creator:
 * every section, whole, one line per entry. It is the same text the form and `review` show. Undefined
 * for an action without a definition.
 */
export function contentPreview(record: CreatorActionRecord): string | undefined {
  if (
    (record.kind !== "agent_create" && record.kind !== "agent_edit") ||
    record.content === undefined
  ) {
    return undefined;
  }
  // The identity the files carry besides the definition: what is written is all shown, and the
  // domain says which reviews the agent may take part in.
  const lines: string[] = [];
  if (record.kind === "agent_create") {
    const identity: Array<readonly [string, string | undefined]> = [
      ["Creates", `${record.definition ?? "agent"} ${record.id}`],
      ["Name", record.name],
      ["Title", record.title],
      ["Description", record.description],
      ["Domain", record.domain],
      ["Phase", record.phase],
      ["Icon", record.icon],
      ["Role", record.role],
    ];
    for (const [label, value] of identity) {
      if (value !== undefined) lines.push(`${label}: ${value}`);
    }
  } else if (isSkillOverrideContent(record.content)) {
    const layer =
      record.layer === "personal" ? "your own layer, ignored by Git" : "the product's layer";
    lines.push(
      `Customises: the skill ${record.id}, ${layer} (replaces the whole file; the skill itself and its rules stay)`,
    );
    const chars = renderSkillCustomisation(record.id, record.content as SkillOverride).length;
    const custom = record.content as SkillOverride;
    const loads =
      custom.output_model !== undefined || (custom.facts ?? []).some((f) => f.startsWith("file:"));
    lines.push(
      `Cost: nothing added to every request; about ${Math.ceil(chars / 4)} tokens each time the skill runs (at most ${Math.ceil(SECTION_CAP / 4)})${loads ? ", plus the files it names, loaded whole (at most ${Math.ceil(LOADED_FILE_CAP / 4)} tokens each)" : ""}.`,
    );
  } else {
    lines.push(
      `Completes: ${record.id} (replaces the whole body of its SKILL.md and, for an agent, its principles and menu)`,
    );
  }
  if (record.kind === "agent_create") {
    // What the addition adds to every request, said before the creator answers.
    const draft: Draft = {
      kind: record.definition === "skill" ? "skill" : "agent",
      id: record.id,
      name: record.name,
      title: record.title,
      description: record.description,
      domain: record.domain,
      phase: record.phase,
      icon: record.icon,
      role: record.role,
      content: record.content,
    };
    const cost = costOfDraft(draft);
    if (cost !== undefined) {
      lines.push(
        `Cost: about ${cost.loaded_tokens} tokens added to every request (its name and description are listed in each session), and about ${cost.body_tokens} tokens each time it runs.`,
      );
    }
  }
  for (const { key, items } of contentSections(record.content)) {
    lines.push(`${SECTION_LABELS[key] ?? key}:`);
    for (const item of items) lines.push(`  ${items.length === 1 ? "" : "- "}${item}`.trimEnd());
  }
  return lines.join("\n");
}

/** The summary of a request's checkpoint, whole: the reason, the effect and a warning. */
export function creatorActionSummary(record: CreatorActionRecord, warning?: string): string {
  return [
    `Reason: ${record.reason}`,
    `Effect: ${effectOf(record)}`,
    ...(warning === undefined ? [] : [`Warning: ${warning}`]),
  ].join("\n");
}

/** The longest summary a checkpoint holds: a longer one is cut, so a request that must be read whole checks. */
export const MAX_CHECKPOINT_SUMMARY = 2000;

/**
 * The `payload` of the `checkpoint.opened` a request writes: a `creator_action` checkpoint at the
 * risk the engine fixed, for the creator, that blocks nothing, titled and summarised by the
 * engine (the reason, the effect and the terminal command).
 */
export function creatorActionCheckpoint(
  record: CreatorActionRecord,
  risk: CheckpointRisk,
  /** What the creator hears once about a step they skip: the risk, the lighter option. */
  warning?: string,
): CheckpointOpenedPayload {
  const summary = creatorActionSummary(record, warning);
  return {
    type: "creator_action",
    risk,
    // No action of the creator is irreversible (a CI waiver, a repository, a push or a
    // merge are undone by the creator themselves): the question says its effect, and the creator's
    // one answer is their agreement.
    irreversible: false,
    recipient_role: recipientFor("creator_action", risk),
    confirmation: confirmationFor(risk),
    title: truncate(titleOf(record), 120),
    summary: truncate(summary, MAX_CHECKPOINT_SUMMARY),
    documents: [],
    blocks: [],
    creator_action: record,
  };
}

/** The story an action concerns, recorded on its checkpoint: a CI waiver's, else none. */
export function actionStory(record: CreatorActionRecord): string | undefined {
  if (record.kind === "ci_waive" || record.kind === "scope_widen") return record.story;
  // A step of one story is recorded on that story.
  return record.kind === "step_skip" || record.kind === "step_resume" ? record.story : undefined;
}

/**
 * Why the journal does not allow the action now, or undefined: a CI waiver needs its story
 * started and not done (`CI_UNAVAILABLE`); a closing, an open item (`DEFERRED_NOT_FOUND`,
 * `DEFERRED_NOT_OPEN`) the creator owns when it is closed as done (`CREATOR_ACTION_NOT_RESERVED`:
 * its owner closes it; only the creator drops one, whoever owns it); a deviation lifted,
 * an open one (`DEVIATION_NOT_FOUND`, `DEVIATION_NOT_OPEN`). The files' actions are checked by
 * their command.
 */
export function journalActionProblem(
  record: CreatorActionRecord,
  state: Readonly<Record<string, unknown>>,
): AgentPluggedError | undefined {
  switch (record.kind) {
    case "ci_waive":
    case "scope_widen":
      return journalProblem(state, record.story);
    case "deferred_resolve":
    case "deferred_drop": {
      const item = openItem(state, record.item);
      if (item instanceof AgentPluggedError) return item;
      // Only the creator drops an item, whoever owns it; an agent's item is closed by its owner.
      if (record.kind === "deferred_resolve" && item.owner !== CREATOR_OWNER) {
        return notReserved(record.kind, "not_creator_owned", {
          item: record.item,
          owner: item.owner,
        });
      }
      return undefined;
    }
    case "trace_resolve": {
      const deviation = openDeviation(state, record.deviation);
      return deviation instanceof AgentPluggedError ? deviation : undefined;
    }
    // Nothing to skip twice (a step already skipped for every story covers one
    // story), nothing to take up that is not skipped.
    case "step_skip":
      return isSkipped(state, record.step, record.story) ? skipUnchanged(record) : undefined;
    case "step_resume":
      return isSkippedExactly(state, record.step, record.story) ? undefined : skipUnchanged(record);
    default:
      return undefined;
  }
}
