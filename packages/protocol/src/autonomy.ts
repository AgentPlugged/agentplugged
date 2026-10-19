import { z } from "zod";
import {
  INSTALL_MODES,
  type InstallMode,
  RULE_ACTIONS,
  RULE_VALUES,
  type RuleAction,
  type RuleValue,
  VALIDATION_MODES,
  VALIDATION_POINTS,
  type ValidationMode,
  type ValidationPoint,
} from "./method-config.js";
import { type PointCandidate, pointKindOf } from "./point-kind.js";

/**
 * The autonomy dial of a product: three notches that set, in one gesture, how much the creator
 * keeps for themselves. The dial is a preset over settings the engine already has (the validation
 * level, the points the creator keeps, the installs mode, two permission rules); it adds no rule
 * of its own. Raising it never lifts a locked rule, the irreversible commands or the base guards
 * (secrets, pushes to the main branch), and never makes an agent validate for the creator:
 * the merge, the release and the publications are not touched by any notch.
 *
 * Everything here is data and pure functions: the machine writes the settings with the engine's own
 * writers, and the web view reads the same table to say what a notch changes.
 */

/** The notches, from the most careful to the most free. */
export const AUTONOMY_DIALS = ["prudent", "balanced", "wide"] as const;
export type AutonomyDial = (typeof AUTONOMY_DIALS)[number];
export const AutonomyDialSchema = z.enum(AUTONOMY_DIALS);

/** What a product's settings add up to: a notch, or `custom` (set by hand or from a terminal). */
export const AUTONOMY_DIAL_STATES = [...AUTONOMY_DIALS, "custom"] as const;
export type AutonomyDialState = (typeof AUTONOMY_DIAL_STATES)[number];
export const AutonomyDialStateSchema = z.enum(AUTONOMY_DIAL_STATES);

/** The points of validation the dial can hand to the agents (the others are never touched). */
export const AUTONOMY_POINTS = ["framing", "architecture", "breakdown"] as const;
export type AutonomyPoint = (typeof AUTONOMY_POINTS)[number];

/** The permission rules the dial moves (the others are never touched). */
export const AUTONOMY_RULES = ["install_dependency", "internet"] as const;
export type AutonomyRule = (typeof AUTONOMY_RULES)[number];

/** What a notch sets. `kept` lists the dial's points the creator keeps for themselves. */
export interface AutonomyPreset {
  readonly mode: Extract<ValidationMode, "chat" | "auto">;
  readonly installs: InstallMode;
  readonly kept: readonly AutonomyPoint[];
  readonly rules: Readonly<Record<AutonomyRule, RuleValue>>;
}

export const AUTONOMY_PRESETS: Readonly<Record<AutonomyDial, AutonomyPreset>> = {
  // What a product freshly initialised by the engine has: every document waits for the creator,
  // the installations show in the activity, the rules are the engine's calibrated defaults.
  prudent: {
    mode: "chat",
    installs: "visible",
    kept: ["framing", "architecture", "breakdown"],
    rules: { install_dependency: "allow", internet: "allow" },
  },
  // What is low risk goes by itself: points of low risk take the recommended option, and the
  // breakdown into stories is decided by the agents.
  balanced: {
    mode: "auto",
    installs: "visible",
    kept: ["framing", "architecture"],
    rules: { install_dependency: "allow", internet: "allow" },
  },
  // Everything but the irreversible: the framing documents and the architecture are decided by the
  // agents too.
  wide: {
    mode: "auto",
    installs: "visible",
    kept: [],
    rules: { install_dependency: "allow", internet: "allow" },
  },
};

/** How much an action's lock lets the creator loosen it. */
export const RULE_LOCK_LEVELS = ["none", "never_allow", "locked"] as const;
export type RuleLockLevel = (typeof RULE_LOCK_LEVELS)[number];

/**
 * - `none`: any value.
 * - `never_allow`: `ask` or `deny` only (the commands that erase data).
 * - `locked`: `deny` only (the push to the main branch, the force push, the secrets).
 */
export const RULE_LOCKS: Readonly<Record<RuleAction, RuleLockLevel>> = {
  read_files: "none",
  edit_code: "none",
  run_checks: "none",
  install_dependency: "none",
  internet: "none",
  destructive_command: "never_allow",
  push_main: "locked",
  force_push: "locked",
  read_secrets: "locked",
};

/** The values an action may take, loosest first. */
export function ruleChoices(lock: RuleLockLevel): readonly RuleValue[] {
  if (lock === "locked") return ["deny"];
  if (lock === "never_allow") return ["ask", "deny"];
  return RULE_VALUES;
}

/** How free a validation level is: `strict` 0, `chat` 1, `auto` 2. */
function modeLooseness(mode: ValidationMode): number {
  return mode === "auto" ? 2 : mode === "chat" ? 1 : 0;
}

/** How free a rule value is: `deny` 0, `ask` 1, `allow` 2. */
export function ruleLooseness(value: RuleValue): number {
  return value === "allow" ? 2 : value === "ask" ? 1 : 0;
}

/** What the dial reads of a product: the settings it moves, as recorded. */
export interface AutonomyReading {
  readonly mode: ValidationMode;
  readonly installs: InstallMode;
  /** The points the creator keeps; undefined while they have not chosen (every point waits). */
  readonly points: readonly ValidationPoint[] | undefined;
  readonly rules: Readonly<Record<AutonomyRule, RuleValue>>;
}

function keptOf(reading: AutonomyReading): readonly AutonomyPoint[] {
  const points = reading.points ?? VALIDATION_POINTS;
  return AUTONOMY_POINTS.filter((point) => points.includes(point));
}

function samePreset(reading: AutonomyReading, preset: AutonomyPreset): boolean {
  const kept = keptOf(reading);
  return (
    reading.mode === preset.mode &&
    reading.installs === preset.installs &&
    // A release or a publication handed to the agents is no notch: the dial never moves them.
    (reading.points === undefined ||
      (reading.points.includes("release") && reading.points.includes("publication"))) &&
    kept.length === preset.kept.length &&
    preset.kept.every((point) => kept.includes(point)) &&
    AUTONOMY_RULES.every((rule) => reading.rules[rule] === preset.rules[rule])
  );
}

/** The notch these settings add up to, or `custom`. */
export function autonomyDialOf(reading: AutonomyReading): AutonomyDialState {
  return AUTONOMY_DIALS.find((dial) => samePreset(reading, AUTONOMY_PRESETS[dial])) ?? "custom";
}

/** One setting a notch would change. */
export type AutonomyChange =
  | { readonly kind: "mode"; readonly from: ValidationMode; readonly to: ValidationMode }
  | { readonly kind: "installs"; readonly from: InstallMode; readonly to: InstallMode }
  | {
      readonly kind: "point";
      readonly point: AutonomyPoint;
      readonly from: "kept" | "agents";
      readonly to: "kept" | "agents";
    }
  | {
      readonly kind: "rule";
      readonly action: AutonomyRule;
      readonly from: RuleValue;
      readonly to: RuleValue;
    };

/** What moving to `dial` changes, and whether any of it gives the agents more freedom. */
export function autonomyChanges(
  reading: AutonomyReading,
  dial: AutonomyDial,
): { readonly changes: readonly AutonomyChange[]; readonly raises: boolean } {
  const preset = AUTONOMY_PRESETS[dial];
  const changes: AutonomyChange[] = [];
  let raises = false;
  if (reading.mode !== preset.mode) {
    changes.push({ kind: "mode", from: reading.mode, to: preset.mode });
    if (modeLooseness(preset.mode) > modeLooseness(reading.mode)) raises = true;
  }
  if (reading.installs !== preset.installs) {
    changes.push({ kind: "installs", from: reading.installs, to: preset.installs });
    if (preset.installs === "visible") raises = true;
  }
  const kept = keptOf(reading);
  for (const point of AUTONOMY_POINTS) {
    const now = kept.includes(point);
    const next = preset.kept.includes(point);
    if (now === next) continue;
    changes.push({
      kind: "point",
      point,
      from: now ? "kept" : "agents",
      to: next ? "kept" : "agents",
    });
    if (now) raises = true;
  }
  for (const action of AUTONOMY_RULES) {
    const from = reading.rules[action];
    const to = preset.rules[action];
    if (from === to) continue;
    changes.push({ kind: "rule", action, from, to });
    if (ruleLooseness(to) > ruleLooseness(from)) raises = true;
  }
  return { changes, raises };
}

/** The number of validations without a change after which a notch is proposed, and its bounds. */
export const AUTONOMY_THRESHOLD_DEFAULT = 10;
export const AUTONOMY_THRESHOLD_MIN = 3;
export const AUTONOMY_THRESHOLD_MAX = 50;

const ThresholdSchema = z.int().min(AUTONOMY_THRESHOLD_MIN).max(AUTONOMY_THRESHOLD_MAX);

/** Rule values by action: every action has one. */
export const RuleTableSchema = z.strictObject({
  read_files: z.enum(RULE_VALUES),
  edit_code: z.enum(RULE_VALUES),
  run_checks: z.enum(RULE_VALUES),
  install_dependency: z.enum(RULE_VALUES),
  internet: z.enum(RULE_VALUES),
  destructive_command: z.enum(RULE_VALUES),
  push_main: z.enum(RULE_VALUES),
  force_push: z.enum(RULE_VALUES),
  read_secrets: z.enum(RULE_VALUES),
});
export type RuleTable = z.infer<typeof RuleTableSchema>;

/**
 * What a machine says of the autonomy of a product it serves. `dial`, `mode`, `installs`, `kept`
 * and `rules` are what the product's `method.yaml` records now. The engine reads these settings on
 * the main branch: when what is recorded is not in force yet, `in_force` says what is (the notch
 * and the rules that differ), and the web view does not pretend otherwise.
 */
export const ProductAutonomySchema = z.strictObject({
  dial: AutonomyDialStateSchema,
  mode: z.enum(VALIDATION_MODES),
  installs: z.enum(INSTALL_MODES),
  kept: z.array(z.enum(VALIDATION_POINTS)).max(VALIDATION_POINTS.length),
  rules: RuleTableSchema,
  in_force: z
    .strictObject({
      dial: AutonomyDialStateSchema,
      rules: z.partialRecord(z.enum(RULE_ACTIONS), z.enum(RULE_VALUES)),
    })
    .optional(),
  /** Validations without a change after which a notch is proposed. */
  threshold: ThresholdSchema,
  /** Per kind of point, when the creator said « not now » to the proposal. */
  snoozed: z.partialRecord(z.enum(AUTONOMY_POINTS), z.iso.datetime()).optional(),
});
export type ProductAutonomy = z.infer<typeof ProductAutonomySchema>;

/** The settings the dial reads, from what a machine reported. */
export function readingOfAutonomy(autonomy: ProductAutonomy): AutonomyReading {
  return {
    mode: autonomy.mode,
    installs: autonomy.installs,
    points: autonomy.kept,
    rules: {
      install_dependency: autonomy.rules.install_dependency,
      internet: autonomy.rules.internet,
    },
  };
}

export const ORDER_TYPE_SET_AUTONOMY = "product.set_autonomy";
export const ORDER_TYPE_SET_RULE = "product.set_rule";
export const ORDER_TYPE_AUTONOMY_HINT = "product.autonomy_hint";

/** The creator moves the dial to a notch. */
export const SetAutonomyParamsSchema = z.strictObject({ dial: AutonomyDialSchema });
export type SetAutonomyParams = z.infer<typeof SetAutonomyParamsSchema>;

/** The creator sets the rule of one kind of action. A locked action only takes its locked value. */
export const SetRuleParamsSchema = z.strictObject({
  action: z.enum(RULE_ACTIONS),
  value: z.enum(RULE_VALUES),
});
export type SetRuleParams = z.infer<typeof SetRuleParamsSchema>;

/**
 * The marks of the proposal that the machine keeps: « not now » for a kind of point (the next
 * proposal needs new validations), and the number of validations after which one is made.
 */
export const AutonomyHintParamsSchema = z
  .strictObject({
    snooze: z.enum(AUTONOMY_POINTS).optional(),
    threshold: ThresholdSchema.optional(),
  })
  .refine((params) => params.snooze !== undefined || params.threshold !== undefined, {
    message: "a kind of point to put off, or a threshold",
  });
export type AutonomyHintParams = z.infer<typeof AutonomyHintParamsSchema>;

/** The codes a refused order of this family answers with. */
export const AUTONOMY_ORDER_CODES = {
  /** The machine does not serve this product. */
  notServed: "PRODUCT_NOT_SERVED",
  /** The engine refused the setting (a locked rule, an unreadable `method.yaml`). */
  refused: "AUTONOMY_REFUSED",
  /** The rule is locked on this value. */
  locked: "AUTONOMY_RULE_LOCKED",
  /** The mark of the proposal could not be kept. */
  notSaved: "AUTONOMY_NOT_SAVED",
  /** Raising or lowering needs the machine on: nothing waits in a queue for it. */
  needsMachine: "AUTONOMY_NEEDS_MACHINE",
} as const;

/** The creator's answers that count as « validated without a change ». */
const CREATOR_SOURCES: ReadonlySet<string> = new Set([
  "terminal",
  "chat",
  "elicitation",
  "web",
  "mobile",
]);

type Rec = Readonly<Record<string, unknown>>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A proposal to move the dial up, with the proof: the kind of point and how many in a row. */
export interface AutonomySuggestion {
  readonly point: AutonomyPoint;
  readonly count: number;
  readonly to: AutonomyDial;
}

/** The points the next notch hands to the agents: the proposal is about those. */
function released(dial: AutonomyDial): readonly AutonomyPoint[] {
  const next = AUTONOMY_DIALS[AUTONOMY_DIALS.indexOf(dial) + 1];
  if (next === undefined) return [];
  return AUTONOMY_PRESETS[dial].kept.filter(
    (point) => !AUTONOMY_PRESETS[next].kept.includes(point),
  );
}

/**
 * The proposal to move the dial up one notch: for a kind of point the next notch hands to the
 * agents, the creator's last `threshold` answers (since they last said « not now ») all approved
 * the point as it was, with no note and no change asked. An answer given by an agent or applied
 * by the engine is not the creator's and does not count; any other answer breaks the run. Pure:
 * it reads the checkpoints the machine published, and nothing else.
 */
export function autonomySuggestion(input: {
  readonly checkpoints: unknown;
  readonly dial: AutonomyDialState;
  readonly threshold: number;
  readonly snoozed?: Readonly<Partial<Record<AutonomyPoint, string>>> | undefined;
}): AutonomySuggestion | undefined {
  const { dial } = input;
  if (dial !== "prudent" && dial !== "balanced") return undefined;
  if (!isRec(input.checkpoints)) return undefined;
  const wanted = released(dial);
  const answers = new Map<AutonomyPoint, { at: number; clean: boolean }[]>();
  for (const point of wanted) answers.set(point, []);
  for (const value of Object.values(input.checkpoints)) {
    if (!isRec(value) || !isRec(value.resolution)) continue;
    const resolution = value.resolution;
    if (typeof value.type !== "string" || typeof value.risk !== "string") continue;
    const kind = pointKindOf(value as unknown as PointCandidate);
    const list = kind === undefined ? undefined : answers.get(kind as AutonomyPoint);
    if (list === undefined) continue;
    const source = typeof resolution.source === "string" ? resolution.source : "";
    if (!CREATOR_SOURCES.has(source)) continue;
    const at = typeof resolution.at === "string" ? Date.parse(resolution.at) : Number.NaN;
    if (Number.isNaN(at)) continue;
    const note = resolution.note;
    list.push({
      at,
      clean:
        resolution.decision === "approved" && (note === null || note === undefined || note === ""),
    });
  }
  let best: AutonomySuggestion | undefined;
  for (const point of wanted) {
    const since = input.snoozed?.[point];
    const after = since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(since);
    const list = (answers.get(point) ?? [])
      .filter((answer) => Number.isNaN(after) || answer.at > after)
      .sort((a, b) => b.at - a.at);
    let count = 0;
    for (const answer of list) {
      if (!answer.clean) break;
      count += 1;
    }
    const to = AUTONOMY_DIALS[AUTONOMY_DIALS.indexOf(dial) + 1];
    if (
      to !== undefined &&
      count >= input.threshold &&
      (best === undefined || count > best.count)
    ) {
      best = { point, count, to };
    }
  }
  return best;
}
