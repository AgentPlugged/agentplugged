import { z } from "zod";
import { ULID_PATTERN } from "./event-envelope.js";
import { GitWorkflowSchema } from "./git-workflow.js";
import { ISSUE } from "./issues.js";
import { MODEL_TIERS, ModelOverridesSchema } from "./models.js";

/** Semantic version (semver.org 2.0.0), without a leading "v". */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const SemverSchema = z.string().regex(SEMVER);

/**
 * Current format of `.agentplugged/method.yaml`. Format 2: the team renamed, and the
 * developers chosen by specialty (`profile.specialties`) instead of counted.
 */
export const METHOD_FORMAT_VERSION = 2;

/** Domains of the method, in display order. Identifiers are stable. */
export const DOMAIN_IDS = [
  "product",
  "ux",
  "architecture",
  "code",
  "quality",
  "security",
  "delivery",
  "docs",
  "creativity",
  "marketing",
  "sales",
] as const;
export type DomainId = (typeof DOMAIN_IDS)[number];

/** Phases of the method, in order. Identifiers are stable. */
export const PHASE_IDS = ["framing", "planning", "design", "build", "delivery", "launch"] as const;
export type PhaseId = (typeof PHASE_IDS)[number];

/** Starting profiles the creator picks from. */
export const PROFILE_PRESET_IDS = [
  "new-product",
  "maintenance",
  "launch-only",
  "prototype",
] as const;
export type ProfilePresetId = (typeof PROFILE_PRESET_IDS)[number];

/**
 * Specialties of the method's developers: a field of work, never a language.
 * Identifiers are stable.
 */
export const DEVELOPER_SPECIALTIES = ["backend", "frontend", "mobile"] as const;
export type DeveloperSpecialty = (typeof DEVELOPER_SPECIALTIES)[number];

/** The highest ceiling of stories built in parallel a profile may set. */
export const MAX_PARALLEL_STORIES = 99;

/** `origin` of `method.yaml`: a new product, or one that existed before the method. */
export const PRODUCT_ORIGINS = ["new", "existing"] as const;
export type ProductOrigin = (typeof PRODUCT_ORIGINS)[number];

/** AI tools `sync` can target. Identifiers are stable. */
export const TOOL_IDS = ["claude-code", "codex", "antigravity", "cursor", "kimi"] as const;
export type ToolId = (typeof TOOL_IDS)[number];

/** Agent identifier: lowercase kebab-case (`sam`, `my-agent`). */
export const AgentIdSchema = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/**
 * Skill name (agentskills.io): 1 to 64 characters among `a-z`, `0-9` and `-`, neither starting
 * nor ending with `-`, without `--`. It must equal the name of the skill's folder. It is also the
 * identifier of every agent or skill the creator adds.
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: ISSUE.idFormat });

function selection<T extends string>(values: readonly [T, ...T[]]) {
  return z
    .array(z.enum(values))
    .min(1)
    .refine((list) => new Set(list).size === list.length, { message: ISSUE.duplicateValue });
}

/**
 * What the method does for this product: `profile` section of `method.yaml`. `specialties`: the
 * developers' specialties at work (none without the `code` domain, at least one with it);
 * `max_parallel_stories`: the optional ceiling of stories built at once, all developers together
 *.
 */
export const ProfileSchema = z
  .strictObject({
    preset: z.enum(PROFILE_PRESET_IDS),
    domains: selection(DOMAIN_IDS),
    phases: selection(PHASE_IDS),
    specialties: z
      .array(z.enum(DEVELOPER_SPECIALTIES))
      .refine((list) => new Set(list).size === list.length, { message: ISSUE.duplicateValue }),
    max_parallel_stories: z.int().min(1).max(MAX_PARALLEL_STORIES).optional(),
  })
  .superRefine((profile, context) => {
    if (!Array.isArray(profile.domains) || !Array.isArray(profile.specialties)) return;
    const code = profile.domains.includes("code");
    if (code && profile.specialties.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["specialties"],
        message: "at least 1 specialty while the code domain is active",
      });
    } else if (!code && profile.specialties.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["specialties"],
        message: "must be empty while the code domain is inactive",
      });
    }
  });

export type Profile = z.infer<typeof ProfileSchema>;

/** What a starting profile switches on: its domains, its phases and the developers' specialties. */
export interface PresetSpec {
  readonly domains: readonly (typeof DOMAIN_IDS)[number][];
  readonly phases: readonly (typeof PHASE_IDS)[number][];
  readonly specialties: readonly DeveloperSpecialty[];
}

/** The starting profiles. */
export const PROFILE_PRESET_SPECS: Readonly<Record<ProfilePresetId, PresetSpec>> = {
  "new-product": { domains: DOMAIN_IDS, phases: PHASE_IDS, specialties: ["backend", "frontend"] },
  maintenance: {
    domains: ["code", "quality", "security", "delivery", "docs"],
    phases: ["design", "build", "delivery"],
    specialties: ["backend", "frontend"],
  },
  "launch-only": {
    domains: ["product", "creativity", "marketing", "sales"],
    phases: ["framing", "launch"],
    specialties: [],
  },
  prototype: {
    domains: ["product", "ux", "code"],
    phases: ["framing", "build"],
    specialties: ["backend", "frontend"],
  },
};

function idList() {
  return z
    .array(SkillNameSchema)
    .refine((list) => new Set(list).size === list.length, { message: ISSUE.duplicateValue });
}

/**
 * The creator's settings of one agent (`agents.settings.<id>`, written by `agent edit`): its model
 * tier, which wins over the customisation and the definition, and its preferred AI tool, shown in
 * its description. The agent is generated for every targeted tool all the same.
 */
export const AgentSettingsSchema = z.strictObject({
  model_tier: z.enum(MODEL_TIERS).optional(),
  tool: z.enum(TOOL_IDS).optional(),
});

export type AgentSettings = z.infer<typeof AgentSettingsSchema>;

/**
 * `agents` section of `method.yaml`. `inactive` is computed from the profile; `enabled` and
 * `disabled` are the creator's choices (`agent enable`, `agent disable`), agents or skills. Active
 * agents: (catalog minus `inactive`) plus the creator's agents plus `enabled`, minus `disabled`.
 * An identifier is never in both lists. `settings` holds the creator's settings, by agent id.
 */
export const AgentsSchema = z
  .strictObject({
    inactive: z.array(AgentIdSchema).optional(),
    enabled: idList().optional(),
    disabled: idList().optional(),
    settings: z.record(SkillNameSchema, AgentSettingsSchema).optional(),
  })
  .superRefine((agents, context) => {
    if (!Array.isArray(agents.enabled) || !Array.isArray(agents.disabled)) return;
    const enabled = new Set(agents.enabled);
    const index = agents.disabled.findIndex((id) => enabled.has(id));
    if (index !== -1) {
      context.addIssue({
        code: "custom",
        path: ["disabled", index],
        message: ISSUE.alsoEnabled,
      });
    }
  });

/** `mcp` of `method.yaml`: the command and arguments that start the MCP server. */
export const McpLaunchSchema = z.strictObject({
  command: z.string().trim().min(1).max(1024),
  args: z.array(z.string().max(4096)).max(64).optional(),
});

export type McpLaunch = z.infer<typeof McpLaunchSchema>;

/**
 * Kinds of action the permission rules govern (`rules` of `method.yaml`). Identifiers
 * are stable. Defaults and locks belong to core, never to the configuration.
 */
export const RULE_ACTIONS = [
  "read_files",
  "edit_code",
  "run_checks",
  "install_dependency",
  "internet",
  "destructive_command",
  "push_main",
  "force_push",
  "read_secrets",
] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

/** What agents do for an action: on their own, after asking the creator, or never. */
export const RULE_VALUES = ["allow", "ask", "deny"] as const;
export type RuleValue = (typeof RULE_VALUES)[number];

const ruleValue = () => z.enum(RULE_VALUES).optional();

/**
 * `rules` of `method.yaml`: the creator's rule for each action, written by `rules set`. Every
 * value is accepted here, even for a locked action: core applies the locked value and reports the
 * gap (`RULE_LOCKED`), so a hand edit never makes the file unreadable.
 */
export const RulesSchema = z.strictObject({
  read_files: ruleValue(),
  edit_code: ruleValue(),
  run_checks: ruleValue(),
  install_dependency: ruleValue(),
  internet: ruleValue(),
  destructive_command: ruleValue(),
  push_main: ruleValue(),
  force_push: ruleValue(),
  read_secrets: ruleValue(),
});

export type Rules = z.infer<typeof RulesSchema>;

/** What going over a story's ceiling does: pause it behind a checkpoint, or flag it. */
export const BUDGET_EXCEED_MODES = ["block", "flag"] as const;
export type BudgetExceedMode = (typeof BUDGET_EXCEED_MODES)[number];

/** The alert ratio without a setting: 80 % of the ceiling. */
export const DEFAULT_ALERT_RATIO = 0.8;

/** What going over the ceiling does without a setting. */
export const DEFAULT_ON_EXCEED: BudgetExceedMode = "block";

/** The lowest alert ratio a product may set. */
export const MIN_ALERT_RATIO = 0.05;

/** `budgets` of `method.yaml`: the alert ratio, and what going over the ceiling does. */
export const BudgetSettingsSchema = z.strictObject({
  alert_ratio: z.number().finite().min(MIN_ALERT_RATIO).max(1).optional(),
  on_exceed: z.enum(BUDGET_EXCEED_MODES).optional(),
});
export type BudgetSettings = z.infer<typeof BudgetSettingsSchema>;

/** `pr` of `method.yaml`. `show_cost` is accepted and ignored: no pull request shows a cost. */
export const PullRequestSettingsSchema = z.strictObject({
  show_cost: z.boolean().optional(),
  /** How the engine merges an approved story: `merge` (default), `squash`, `rebase`. */
  merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
});
export type PullRequestSettings = z.infer<typeof PullRequestSettingsSchema>;

/**
 * How the creator validates checkpoints when no other surface is linked: `chat`
 * (the default), `auto` (a low-risk checkpoint takes its recommended option on its own) or
 * `strict` (a high-risk checkpoint needs the terminal and the creator's key).
 */
export const VALIDATION_MODES = ["chat", "auto", "strict"] as const;
export type ValidationMode = (typeof VALIDATION_MODES)[number];

/** The level without a setting. */
export const DEFAULT_VALIDATION_MODE: ValidationMode = "chat";

/**
 * The points of validation the creator may keep for themselves: the kinds of
 * checkpoint that wait for their answer. Any other point is decided by the agent responsible for
 * it, with its reason in the journal, and the creator can reopen it. Identifiers are stable.
 * `framing`: the documents of the framing and planning phases (brief, PRD, UX specification) and
 * the end of those phases; `architecture`: the architecture and the end of the design phase;
 * `breakdown`: the epics, stories and sprints; `merge`: the merge of a story; `release`: a
 * deployment and the end of the delivery phase; `publication`: a deliverable of the launch.
 */
export const VALIDATION_POINTS = [
  "framing",
  "architecture",
  "breakdown",
  "merge",
  "release",
  "publication",
] as const;
export type ValidationPoint = (typeof VALIDATION_POINTS)[number];

/** The points proposed to the creator when they choose (`init`, `profile`, the chat). */
export const DEFAULT_VALIDATION_POINTS: readonly ValidationPoint[] = [
  "framing",
  "architecture",
  "release",
  "publication",
];

/** `validation` of `method.yaml`: read on the main branch, like the rules. */
export const ValidationSettingsSchema = z.strictObject({
  mode: z.enum(VALIDATION_MODES).optional(),
  /**
   * The points that wait for the creator. Absent: the creator has not chosen yet and
   * every point waits for them, as before. Present (even empty): any other point is decided by
   * its responsible agent.
   */
  points: z
    .array(z.enum(VALIDATION_POINTS))
    .refine((list) => new Set(list).size === list.length, { message: ISSUE.duplicateValue })
    .optional(),
});
export type ValidationSettings = z.infer<typeof ValidationSettingsSchema>;

/**
 * How the installations of dependencies are handled: `visible` (no
 * validation; the installation shows in the product's activity and is written to the journal) or
 * `validate` (one validation per installation, which a stack may group). The default is
 * `visible`: what counts is the trace, and the creator goes back to `validate`
 * whenever they wish (`profile`, or `installs.mode` of `method.yaml`).
 */
export const INSTALL_MODES = ["visible", "validate"] as const;
export type InstallMode = (typeof INSTALL_MODES)[number];

/** The installation mode without a setting. */
export const DEFAULT_INSTALL_MODE: InstallMode = "visible";

/** `installs` of `method.yaml`: read on the main branch, like the rules. */
export const InstallSettingsSchema = z.strictObject({
  mode: z.enum(INSTALL_MODES).optional(),
});
export type InstallSettings = z.infer<typeof InstallSettingsSchema>;

/**
 * What the AI tool asks before it acts. `protected` (the default, and the only mode
 * `sync` knew until then): the tool keeps asking, and the mode that removes its questions
 * (`bypassPermissions` of Claude Code) is turned off in the project. `free`: `sync` no longer turns
 * that mode off, so the creator may use it in their tool; the engine never switches it on, and the
 * deny rules, the hooks and the journal stay. Written by `init` and `profile`, never by an agent.
 */
export const PERMISSION_MODES = ["protected", "free"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The permission mode without a setting. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "protected";

/** `permissions` of `method.yaml`. */
export const PermissionSettingsSchema = z.strictObject({
  mode: z.enum(PERMISSION_MODES).optional(),
});
export type PermissionSettings = z.infer<typeof PermissionSettingsSchema>;

/** The forges whose CI the engine reads and writes. */
export const CI_FORGE_IDS = ["github", "gitlab"] as const;

/**
 * The CI settings of the product: `forge` forces the forge of `story ci`, `check_ci`
 * and `ci setup` (GitHub or GitLab hosted under another name); absent, the `origin` remote's.
 */
export const CiSettingsSchema = z.strictObject({
  forge: z.enum(CI_FORGE_IDS).optional(),
});
export type CiSettings = z.infer<typeof CiSettingsSchema>;

/** A test file longer than this is refused (`oversize`); the creator may set another in `tests.max_lines`. */
export const TEST_FILE_MAX_LINES = 1000;
/** The lowest `tests.max_lines`: under it the guard would refuse ordinary files. */
export const TEST_FILE_MAX_LINES_FLOOR = 200;

/**
 * The tests settings of the product: `max_lines` is the length from which the guard
 * before a write refuses a test file as too large (1 000 by default, 200 at least).
 */
export const TestSettingsSchema = z.strictObject({
  max_lines: z.number().int().min(TEST_FILE_MAX_LINES_FLOOR).max(100_000).optional(),
});
export type TestSettings = z.infer<typeof TestSettingsSchema>;

/** `.agentplugged/method.yaml`: validated before any use. */
export const MethodConfigSchema = z.strictObject({
  format_version: z.literal(METHOD_FORMAT_VERSION),
  engine_version: SemverSchema,
  /**
   * The product's identifier, a ULID created by `init`, carried by every event of its journal
   * (`product`). Absent in files written before the journal: a command that needs it adds it.
   */
  product_id: z.string().regex(ULID_PATTERN, { message: ISSUE.ulid }).optional(),
  profile: ProfileSchema.optional(),
  agents: AgentsSchema.optional(),
  /**
   * AI tools `sync` generates files for. Absent in files written before tools could be chosen:
   * the detected tools are used then.
   */
  tools: selection(TOOL_IDS).optional(),
  /**
   * The creator's models, tool by tool and tier by tier: they win over the table shipped with the
   * method (`.agentplugged/models.yaml`).
   */
  models: ModelOverridesSchema.optional(),
  /**
   * The creator's own launch of the `agentplugged` MCP server (for example a local build while the
   * pinned engine is not on npm): replaces the default declaration (`npx -y
   * agentplugged@<engine_version> mcp`) in every tool's configuration.
   */
  mcp: McpLaunchSchema.optional(),
  /** The creator's permission rules, by action (`npx agentplugged rules`); absent: the defaults. */
  rules: RulesSchema.optional(),
  /**
   * Where the product stood when the method arrived: `existing` when `init` found
   * the product's files already there. `new`, set by the creator, says otherwise. Absent: unknown
   * (the `maintenance` profile then counts as an existing product).
   */
  origin: z.enum(PRODUCT_ORIGINS).optional(),
  /**
   * The creator's budget settings: the alert ratio (0.8 by default) and what going
   * over a story's ceiling does (`block` by default, or `flag`). Read on the main branch, like
   * the rules; absent: the defaults.
   */
  budgets: BudgetSettingsSchema.optional(),
  /**
   * The creator's pull request settings: `merge_method` says how an approved story is
   * merged. `show_cost` is accepted and ignored (no pull request shows a cost). Read on
   * the main branch, like the rules; absent: the defaults.
   */
  pr: PullRequestSettingsSchema.optional(),
  /** The CI settings: the forge, when the `origin` remote does not say it. */
  ci: CiSettingsSchema.optional(),
  /** The tests settings: the length from which a test file is too large. */
  tests: TestSettingsSchema.optional(),
  /**
   * The creator's validation level: `chat` by default, `auto` or `strict`. Read on
   * the main branch, like the rules; written by `profile` and `init`, never by an agent.
   */
  validation: ValidationSettingsSchema.optional(),
  /**
   * How the installations the approved architecture declares are handled: `visible`
   * or `validate` (the default). Read on the main branch, like the rules; written by `init`,
   * `profile` and the creator's `profile` action, never by an agent.
   */
  installs: InstallSettingsSchema.optional(),
  /**
   * What the AI tool asks before it acts: `protected` (the default) or `free`. Written
   * by `init` and `profile`, never by an agent; `sync` reads it.
   */
  permissions: PermissionSettingsSchema.optional(),
  /**
   * The creator's Git workflow: the branches the work lands on, a branch per story or
   * not, the CI, the way a story is merged and whether a review comes first. Written by `init`,
   * `profile` and the creator's `profile` action, never by an agent; absent: nothing chosen, the
   * recommendation applies.
   */
  git: GitWorkflowSchema.optional(),
});

export type MethodConfig = z.infer<typeof MethodConfigSchema>;
