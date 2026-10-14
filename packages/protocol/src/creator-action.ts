import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import {
  AgentContentSchema,
  isSkillContent,
  plainLine,
  SkillContentSchema,
} from "./agent-content.js";
import { canonicalStoryId, DeferredIdInputSchema } from "./deferred.js";
import { EnvironmentCheckIdSchema } from "./environment.js";
import { GitBranchSchema, GitWorkflowSchema } from "./git-workflow.js";
import { isStoryStep, JOURNEY_STEPS } from "./journey.js";
import {
  AgentIdSchema,
  DOMAIN_IDS,
  INSTALL_MODES,
  PHASE_IDS,
  ProfileSchema,
  SemverSchema,
  SkillNameSchema,
  TOOL_IDS,
  VALIDATION_MODES,
  VALIDATION_POINTS,
} from "./method-config.js";
import { MODEL_TIERS } from "./models.js";
import {
  AcceptedProofCommandSchema,
  MAX_PROOF_COMMANDS_PER_REQUEST,
  PROOF_REQUIREMENTS,
  ProofCommandNameSchema,
} from "./proof-commands.js";
import { SkillOverrideSchema } from "./skill-override.js";
import { ScopePathsSchema } from "./write-guard.js";

/**
 * The creator's decisions asked from the chat: an agent asks for one of the
 * actions reserved to the creator (`request_creator_action`), typed and checked like the terminal
 * command it stands for; the request opens a `creator_action` checkpoint the creator answers like
 * any other (`answer_checkpoint` in the chat, `review` at the terminal). Once the creator approves
 * it, the engine executes the action itself (`creator_action.executed`), never the agent.
 */

/**
 * The actions an agent may ask the creator for, each standing for a terminal command:
 * `story ci <id> --waive`, `deferred resolve|drop`, `trace resolve`, `profile`, and
 * `agent create|edit|enable|disable`. Also the three gestures of the forge the creator
 * used to type: creating the remote repository, pushing the main branch for the first time, and
 * merging the pull request of the CI (`gh`, `git push`, a merge by hand): the engine does them,
 * with the forge's tool the creator connected, once the creator approves. Also the two
 * gestures of the journey: skipping a step of the proposed path (`step_skip`) and taking it up
 * again (`step_resume`). Also the engine's update (`engine_update`): installing a newer
 * version in its own folder and moving the product to it, and the two machine settings that govern
 * it (the check of the registry, the automatic updates). Also the `workflow` of a `profile`
 * (the creator's Git workflow) and the release (`release`): putting what waits on the integration
 * branch (staging) into production, a gesture of the engine. Also the repair of the
 * machine (`environment_fix`): the engine runs the repair its catalogue gives for one check
 * (`check_environment`), once the creator has approved the exact command; the request carries the
 * check's identifier only, never a command. Also the accord to the project's proof
 * commands (`proof_commands`): the creator accepts, once, the exact lines the engine may run to
 * prove the requirements, and may demand that the proofs of a release be the engine's own.
 */
export const CREATOR_ACTION_KINDS = [
  "ci_waive",
  "deferred_resolve",
  "deferred_drop",
  "trace_resolve",
  "profile",
  "agent_create",
  "agent_edit",
  "agent_enable",
  "agent_disable",
  "forge_repo_create",
  "forge_push_main",
  "forge_merge_ci",
  "step_skip",
  "step_resume",
  "engine_update",
  "release",
  "environment_fix",
  "proof_commands",
  "scope_widen",
] as const;
export type CreatorActionKind = (typeof CREATOR_ACTION_KINDS)[number];

/** The actions that change files (`method.yaml`, `.agentplugged/agents/`), not the journal. */
export const FILE_CREATOR_ACTIONS: ReadonlySet<CreatorActionKind> = new Set([
  "profile",
  "agent_create",
  "agent_edit",
  "agent_enable",
  "agent_disable",
]);

/**
 * The gestures of the forge: carried out by the engine outside the journal, after the
 * approval is written and the projection has accepted it.
 */
export const FORGE_CREATOR_ACTIONS: ReadonlySet<CreatorActionKind> = new Set([
  "forge_repo_create",
  "forge_push_main",
  "forge_merge_ci",
  "release",
]);

/**
 * The repairs of the machine: carried out by the engine outside the journal, after the
 * approval is written and the projection has accepted it, like the gestures of the forge.
 */
export const ENVIRONMENT_CREATOR_ACTIONS: ReadonlySet<CreatorActionKind> = new Set([
  "environment_fix",
]);

/**
/** `V-` then 10 characters (the trace's deviation id), as typed. */
const DeviationIdInputSchema = z
  .string()
  .trim()
  .toUpperCase()
  .pipe(
    z.string().regex(/^V-[0-9A-HJKMNP-TV-Z]{10}$/, {
      message: "expected V- then 10 characters, for example V-7M2K9QX4TB",
    }),
  );

/** A Git commit (SHA-1 or SHA-256), in lowercase hexadecimal. */
const CommitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, {
  message: "expected 40 or 64 lowercase hexadecimal characters",
});

/** A repository name on a forge: letters, digits, `.`, `_`, `-`, never ending with `.git`. */
const RepositoryNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, { message: "expected a repository name" })
  .refine((name) => !name.toLowerCase().endsWith(".git"), { message: "without .git" });

/** An account or group on a forge (GitLab groups may nest): `ada`, `team/sub`. */
const RepositoryOwnerSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*){0,4}$/, {
    message: "expected an account or group name",
  })
  .max(200);

/** The branch of the CI an agent delivers: `ci/` then a name (`ci/base-workflows`). */
const CiBranchSchema = z.string().regex(/^ci\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/, {
  message: "expected a branch of the CI: ci/ then a name, for example ci/base-workflows",
});

/** A Git branch name of the main branch (`main`, `master`, another default). */
const MainBranchNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/, { message: "expected a branch name" })
  .refine((name) => !name.includes("..") && !name.includes("//") && !name.endsWith("/"), {
    message: "expected a branch name",
  })
  .refine((name) => !name.endsWith(".lock"), { message: "expected a branch name" });

/**
 * The repository a gesture targets, as the engine read it from the address Git pushes to (never
 * from a text of the agent): `<host>/<path>`, in lower case (`github.com/ada/shop`).
 */
const RepositoryTargetSchema = z
  .string()
  .regex(/^[a-z0-9.-]+\/[\w.-]+(?:\/[\w.-]+)+$/, { message: "expected <host>/<owner>/<name>" });

/** A single line of 1 to `max` characters that shows what it says (see `plainLine`). */
const line = plainLine;

/**
 * Why the creator wants it, as the agent heard it: 1 to 500 characters on one line. It is the
 * reason recorded by a CI waiver, a closing of deferred work and a deviation lifted.
 */
export const CreatorActionReasonSchema = line(500);

const reason = CreatorActionReasonSchema;

const story = StoryIdSchema.overwrite(canonicalStoryId);

/** One action per kind, as an agent asks for it: the arguments of its terminal command. */
const actionShapes = {
  ci_waive: { kind: z.literal("ci_waive"), story },
  deferred_resolve: { kind: z.literal("deferred_resolve"), item: DeferredIdInputSchema },
  deferred_drop: { kind: z.literal("deferred_drop"), item: DeferredIdInputSchema },
  trace_resolve: { kind: z.literal("trace_resolve"), deviation: DeviationIdInputSchema },
  profile: {
    kind: z.literal("profile"),
    profile: ProfileSchema.optional(),
    validation: z.enum(VALIDATION_MODES).optional(),
    /** How the installations the approved architecture declares are handled. */
    installs: z.enum(INSTALL_MODES).optional(),
    /**
     * The points that wait for the creator: the others are decided by the agent
     * responsible for them. An empty list: the creator keeps none.
     */
    points: z
      .array(z.enum(VALIDATION_POINTS))
      .refine((list) => new Set(list).size === list.length, { message: "each point once" })
      .optional(),
    /**
     * The creator's Git workflow: the branches the work lands on, a branch per story or
     * not, the CI, the way a story is merged, the review. Whole: it replaces the one recorded.
     * `recommended`: « garde la recommandation », the engine fills in the recommendation for this
     * repository (a record always holds the workflow itself).
     */
    workflow: z.union([GitWorkflowSchema, z.literal("recommended")]).optional(),
  },
  agent_create: {
    kind: z.literal("agent_create"),
    id: SkillNameSchema,
    /** An agent (the default) or a skill. */
    definition: z.enum(["agent", "skill"]).optional(),
    name: line(64).optional(),
    title: line(200).optional(),
    description: line(1024).optional(),
    domain: z.enum(DOMAIN_IDS).optional(),
    phase: z.enum(PHASE_IDS).optional(),
    icon: line(8).optional(),
    role: line(500).optional(),
    /**
     * The complete definition: written as approved, no template. A request without it
     * is refused by the engine, which says what to add.
     */
    content: z.union([AgentContentSchema, SkillContentSchema]).optional(),
  },
  agent_edit: {
    kind: z.literal("agent_edit"),
    id: SkillNameSchema,
    /** A model tier, or `default` (the agent's own tier again). */
    tier: z.enum([...MODEL_TIERS, "default"]).optional(),
    /** A preferred AI tool, or `none`. */
    tool: z.enum([...TOOL_IDS, "none"]).optional(),
    /**
     * The complete definition of an agent or skill of the creator's, to complete a skeleton
     *; or the whole customisation of a skill shipped with the method,
     * which replaces the file of its `layer`. Not with `tier` or `tool`.
     */
    content: z.union([AgentContentSchema, SkillContentSchema, SkillOverrideSchema]).optional(),
    /**
     * With a customisation, the file it replaces: the product's (`shared`, the
     * default, in Git) or the person's own (`personal`, ignored by Git).
     */
    layer: z.enum(["shared", "personal"]).optional(),
  },
  agent_enable: { kind: z.literal("agent_enable"), id: SkillNameSchema },
  agent_disable: { kind: z.literal("agent_disable"), id: SkillNameSchema },
  /**
   * The remote repository, private unless the creator asks for a public one. The
   * remote `origin` is added to the local repository.
   */
  forge_repo_create: {
    kind: z.literal("forge_repo_create"),
    forge: z.enum(["github", "gitlab"]),
    name: RepositoryNameSchema,
    owner: RepositoryOwnerSchema.optional(),
    visibility: z.enum(["private", "public"]).optional(),
  },
  /** The first push of the main branch to `origin`, never forced. */
  forge_push_main: { kind: z.literal("forge_push_main") },
  /** The pull request of the CI's branch, opened when there is none, then merged. */
  forge_merge_ci: { kind: z.literal("forge_merge_ci"), branch: CiBranchSchema },
  /**
   * Skip a step of the journey, for every story or for one (`story`, steps of a story
   * only). The creator's own choice: the engine records it, warns once, never refuses.
   */
  step_skip: {
    kind: z.literal("step_skip"),
    step: z.enum(JOURNEY_STEPS),
    story: story.optional(),
  },
  /** Take a skipped step up again (the same `step` and `story` as the skip). */
  step_resume: {
    kind: z.literal("step_resume"),
    step: z.enum(JOURNEY_STEPS),
    story: story.optional(),
  },
  /**
   * Install the newer engine the engine itself announced (`update_available`, or the
   * version the product pins) and move the product to it (`install`), and/or change the machine's
   * settings: `check` (ask the registry whether a version is out) and `auto` (install it without
   * asking). The version is never the agent's: the engine reads it and records it (`version`).
   */
  engine_update: {
    kind: z.literal("engine_update"),
    install: z.literal(true).optional(),
    check: z.boolean().optional(),
    auto: z.boolean().optional(),
  },
  /**
   * The release. With `main` + `dev`, what waits on `dev` (staging) goes to `main`
   * (production): a pull request merged on the forge, or a merge by the engine, as the creator's
   * workflow says. The engine reads the branches and the commit, never the agent.
   */
  release: { kind: z.literal("release") },
  /**
   * Repair a point of the machine's environment. Only the identifier of the check
   * (`check_environment` lists them): the engine reads its catalogue for the command, shows it in
   * the request and runs exactly that after the approval. Never a command from the agent.
   */
  environment_fix: { kind: z.literal("environment_fix"), check: EnvironmentCheckIdSchema },
  /**
   * The accord to the project's proof commands. The request names the commands to
   * accept (default: every one that is new or modified and not refused) and/or what the creator
   * demands of the proofs at the release (`engine`: only those the engine ran or read; `any`).
   * Never a command line from the agent: the engine reads `.agentplugged/proofs.yaml` and records
   * the exact lines the creator reads.
   */
  proof_commands: {
    kind: z.literal("proof_commands"),
    commands: z
      .array(ProofCommandNameSchema)
      .min(1)
      .max(MAX_PROOF_COMMANDS_PER_REQUEST)
      .refine((names) => new Set(names).size === names.length, { message: "names must differ" })
      .optional(),
    require: z.enum(PROOF_REQUIREMENTS).optional(),
  },
  /**
   * Add files or folders to the scope of a story, so the guard before a write lets
   * them through. The creator's own choice; the paths are the ones the guard refused.
   */
  scope_widen: { kind: z.literal("scope_widen"), story, paths: ScopePathsSchema },
} as const;

/**
 * What the engine adds to the gestures it carries out, read when the request is made and checked
 * again at the approval: the commit (the head of the main branch, or of the CI's branch), the
 * repository the gesture targets (the address Git pushes to), and the main branch. A newer commit,
 * or another repository, is not covered.
 */
const forgeFacts = {
  push_main: {
    branch: MainBranchNameSchema,
    commit: CommitSchema,
    target: RepositoryTargetSchema,
  },
  merge_ci: {
    base: MainBranchNameSchema,
    commit: CommitSchema,
    target: RepositoryTargetSchema,
    /** The files the pull request changes (the engine read them): what the creator confirms. */
    files: z.array(z.string().min(1).max(500)).min(1).max(20).optional(),
  },
  release: {
    /** The integration branch (staging) and the production branch, and the commit moved. */
    from: GitBranchSchema,
    to: GitBranchSchema,
    commit: CommitSchema,
    /** The repository on the forge, when the release goes through a pull request. */
    target: RepositoryTargetSchema.optional(),
    /** How many stories wait in staging: what the creator approves. */
    stories: z.int().min(0).max(100_000).optional(),
  },
} as const;

/** The rules across fields: a profile change or an agent's settings change something. */
function checkAction(
  value: { kind: string } & Record<string, unknown>,
  context: z.RefinementCtx,
): void {
  if (
    value.kind === "profile" &&
    value.profile === undefined &&
    value.validation === undefined &&
    value.installs === undefined &&
    value.points === undefined &&
    value.workflow === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["profile"],
      message:
        "give a profile, a validation level, an installs mode, the points, the Git workflow, or several",
    });
  }
  if (value.kind === "engine_update") {
    if (value.install === undefined && value.check === undefined && value.auto === undefined) {
      context.addIssue({
        code: "custom",
        path: ["install"],
        message: "give install, check, auto, or several",
      });
    }
    // A record of an installation carries the version the engine read; nothing else does.
    if (value.version !== undefined && value.install !== true) {
      context.addIssue({
        code: "custom",
        path: ["version"],
        message: "only an installation records a version",
      });
    }
  }
  // A request with neither field is read by the engine (the commands that wait); a record holds one.
  if (
    value.kind === "proof_commands" &&
    value.reason !== undefined &&
    value.commands === undefined &&
    value.require === undefined
  ) {
    context.addIssue({
      code: "custom",
      path: ["commands"],
      message: "give the commands accepted, the demand on the proofs, or both",
    });
  }
  if (value.kind === "step_skip" || value.kind === "step_resume") {
    const step = value.step as (typeof JOURNEY_STEPS)[number];
    if (value.story !== undefined && !isStoryStep(step)) {
      context.addIssue({
        code: "custom",
        path: ["story"],
        message: "a story goes with the steps of a story only",
      });
    }
  }
  if (value.kind === "agent_create" && value.content !== undefined) {
    const skill = isSkillContent(value.content as Record<string, unknown>);
    if (skill !== (value.definition === "skill")) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: skill
          ? "the content of a skill goes with definition: skill"
          : "the content of an agent goes with definition: agent",
      });
    }
  }
  if (value.kind === "agent_edit") {
    const settings = value.tier !== undefined || value.tool !== undefined;
    if (!settings && value.content === undefined) {
      context.addIssue({
        code: "custom",
        path: ["tier"],
        message: "give a tier, a tool, or both; or the content",
      });
    }
    if (value.layer !== undefined && value.content === undefined) {
      context.addIssue({
        code: "custom",
        path: ["layer"],
        message: "a layer goes with the customisation of a skill (content)",
      });
    }
    if (settings && value.content !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message: "give the content in a request of its own, apart from a tier or a tool",
      });
    }
  }
}

/**
 * The risk of the engine's update, fixed by the engine and checked again by the projection: an
 * installation, or turning the automatic updates on, changes the code that runs here (medium);
 * the other settings change nothing that runs (low).
 */
export function engineUpdateRisk(action: {
  readonly install?: true | undefined;
  readonly auto?: boolean | undefined;
}): "low" | "medium" {
  return action.install === true || action.auto === true ? "medium" : "low";
}

/**
 * The risk of an accord to proof commands, fixed by the engine and checked again by the projection:
 * accepting commands lets the engine run programs on the creator's machine (medium); only setting
 * what the release demands of the proofs changes nothing that runs (low).
 */
export function proofCommandsRisk(action: {
  readonly commands?: readonly unknown[] | undefined;
}): "low" | "medium" {
  return action.commands !== undefined && action.commands.length > 0 ? "medium" : "low";
}

/** An action as an agent asks for it (`request_creator_action`). */
export const CreatorActionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject(actionShapes.ci_waive),
    z.strictObject(actionShapes.deferred_resolve),
    z.strictObject(actionShapes.deferred_drop),
    z.strictObject(actionShapes.trace_resolve),
    z.strictObject(actionShapes.profile),
    z.strictObject(actionShapes.agent_create),
    z.strictObject(actionShapes.agent_edit),
    z.strictObject(actionShapes.agent_enable),
    z.strictObject(actionShapes.agent_disable),
    z.strictObject(actionShapes.forge_repo_create),
    z.strictObject(actionShapes.forge_push_main),
    z.strictObject(actionShapes.forge_merge_ci),
    z.strictObject(actionShapes.step_skip),
    z.strictObject(actionShapes.step_resume),
    z.strictObject(actionShapes.engine_update),
    z.strictObject(actionShapes.release),
    z.strictObject(actionShapes.environment_fix),
    z.strictObject(actionShapes.proof_commands),
    z.strictObject(actionShapes.scope_widen),
  ])
  .superRefine(checkAction);
export type CreatorAction = z.infer<typeof CreatorActionSchema>;

/**
 * An action as the request recorded it, in the `checkpoint.opened` of its checkpoint and in the
 * `creator_action.executed` that carries it out: the action, the reason, and for a CI waiver the
 * head of the story's branch the engine read when it was asked (`commit`): a newer commit is not
 * covered.
 */
export const CreatorActionRecordSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ ...actionShapes.ci_waive, commit: CommitSchema, reason }),
    z.strictObject({ ...actionShapes.deferred_resolve, reason }),
    z.strictObject({ ...actionShapes.deferred_drop, reason }),
    z.strictObject({ ...actionShapes.trace_resolve, reason }),
    z.strictObject({ ...actionShapes.profile, workflow: GitWorkflowSchema.optional(), reason }),
    z.strictObject({ ...actionShapes.agent_create, reason }),
    z.strictObject({ ...actionShapes.agent_edit, reason }),
    z.strictObject({ ...actionShapes.agent_enable, reason }),
    z.strictObject({ ...actionShapes.agent_disable, reason }),
    z.strictObject({ ...actionShapes.forge_repo_create, reason }),
    z.strictObject({ ...actionShapes.forge_push_main, ...forgeFacts.push_main, reason }),
    z.strictObject({ ...actionShapes.forge_merge_ci, ...forgeFacts.merge_ci, reason }),
    z.strictObject({ ...actionShapes.step_skip, reason }),
    z.strictObject({ ...actionShapes.step_resume, reason }),
    z.strictObject({ ...actionShapes.engine_update, version: SemverSchema.optional(), reason }),
    z.strictObject({ ...actionShapes.release, ...forgeFacts.release, reason }),
    // The exact command the engine will run, as the creator saw it in the request.
    z.strictObject({ ...actionShapes.environment_fix, command: line(500), reason }),
    // The exact lines the creator accepted (name, line, folder, limit, requirements, fingerprint).
    z.strictObject({
      ...actionShapes.proof_commands,
      commands: z
        .array(AcceptedProofCommandSchema)
        .min(1)
        .max(MAX_PROOF_COMMANDS_PER_REQUEST)
        .optional(),
      reason,
    }),
    z.strictObject({ ...actionShapes.scope_widen, reason }),
  ])
  .superRefine(checkAction);
export type CreatorActionRecord = z.infer<typeof CreatorActionRecordSchema>;

/**
 * Input of `request_creator_action`: the action, typed (`kind` and its arguments), and why the
 * creator wants it. The engine sets the risk, whether it is irreversible, the title and the
 * summary of the checkpoint it opens: never the agent.
 */
export const RequestCreatorActionInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  action: z.looseObject({ kind: z.string() }),
  reason: CreatorActionReasonSchema,
});
export type RequestCreatorActionInput = z.infer<typeof RequestCreatorActionInputSchema>;

/** Event types of the creator's actions (`creator_action.executed` at version 2). */
export const CREATOR_ACTION_EVENT_TYPES = {
  /** The action carried out by the engine, once the creator approved its request. */
  executed: "creator_action.executed",
} as const;

/**
 * Where the approval of an executed action was given: the chat, the terminal, or the AI tool's
 * form the engine asked for (`elicitation`).
 */
export const CREATOR_ACTION_SOURCES = ["chat", "terminal", "elicitation"] as const;
export type CreatorActionSource = (typeof CREATOR_ACTION_SOURCES)[number];

/** Why `request_creator_action` refuses an action as not the creator's to decide. */
export const CREATOR_ACTION_NOT_RESERVED_REASONS = [
  /** An action no request covers (`rules set`, `sync`, a waiver of a checkpoint…). */
  "unknown_kind",
  /** An item of deferred work the creator does not own: its owner closes it. */
  "not_creator_owned",
  /**
   * A repair of the environment the engine cannot run by itself (it needs the
   * terminal, a browser or a password): the steps are given instead.
   */
  "not_automatic",
] as const;
export type CreatorActionNotReservedReason = (typeof CREATOR_ACTION_NOT_RESERVED_REASONS)[number];

/**
 * Why an approved gesture of the forge cannot be carried out (`FORGE_GESTURE_FAILED`):
 * the repository, the forge tool or the remote does not allow it. Nothing was done.
 */
export const FORGE_GESTURE_REASONS = [
  "no_repository",
  "not_repository_root",
  "cli_missing",
  "not_logged_in",
  "remote_exists",
  "name_taken",
  "no_remote",
  "unknown_forge",
  "no_main_branch",
  "remote_ahead",
  "remote_diverged",
  "remote_unreadable",
  "branch_not_pushed",
  "main_not_pushed",
  "not_ci_change",
  "diff_unreadable",
  "pull_request_closed",
  "head_moved",
  "not_mergeable",
  "forge_failed",
  "not_available",
  // The workflow has no integration branch (`not_staged`), a branch is not
  // here (`branch_missing`), the production branch is checked out with changes not committed
  // (`base_dirty`), the two branches conflict (`conflict`), Git refused (`merge_failed`).
  "not_staged",
  "branch_missing",
  "base_dirty",
  "conflict",
  "merge_failed",
] as const;
export type ForgeGestureReason = (typeof FORGE_GESTURE_REASONS)[number];
