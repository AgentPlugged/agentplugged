import {
  ErrorCode,
  RULE_ACTIONS,
  RULE_VALUES,
  type RuleAction,
  type Rules,
  type RuleValue,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";

/**
 * The permission rules, calibrated: what counts is the trace in
 * the journal, so only the gestures that destroy or give away something are refused (a force push, a
 * push to the main branch, a mass deletion outside the repository, a secret read), and the creator
 * adds whatever else they want to ask or deny (`rules set`). The defaults and the locks are written
 * here, in core, never in the configuration: `method.yaml` holds only the creator's choices.
 */
export const DEFAULT_RULES: Readonly<Record<RuleAction, RuleValue>> = {
  read_files: "allow",
  edit_code: "allow",
  run_checks: "allow",
  install_dependency: "allow",
  internet: "allow",
  destructive_command: "deny",
  push_main: "deny",
  force_push: "deny",
  read_secrets: "deny",
};

/**
 * - `none`: any value.
 * - `never_allow`: `ask` or `deny` only (`destructive_command`).
 * - `locked`: `deny` only (`push_main`, `force_push`, `read_secrets`).
 */
export type RuleLock = "none" | "never_allow" | "locked";

const LOCKS: Readonly<Record<RuleAction, RuleLock>> = {
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

export function lockOf(action: RuleAction): RuleLock {
  return LOCKS[action];
}

/** The values an action may take, loosest first. */
export function allowedValues(action: RuleAction): readonly RuleValue[] {
  const lock = LOCKS[action];
  if (lock === "locked") return ["deny"];
  if (lock === "never_allow") return ["ask", "deny"];
  return RULE_VALUES;
}

/** How permissive a value is: `allow` 2, `ask` 1, `deny` 0. */
export function looseness(value: RuleValue): number {
  return value === "allow" ? 2 : value === "ask" ? 1 : 0;
}

/** The value applied for a wanted one: itself, or the loosest the lock permits. */
export function lockedValue(action: RuleAction, value: RuleValue): RuleValue {
  const allowed = allowedValues(action);
  if (allowed.includes(value)) return value;
  return allowed[0] ?? "deny";
}

export function isRuleAction(value: unknown): value is RuleAction {
  return typeof value === "string" && (RULE_ACTIONS as readonly string[]).includes(value);
}

export function isRuleValue(value: unknown): value is RuleValue {
  return typeof value === "string" && (RULE_VALUES as readonly string[]).includes(value);
}

/** A rule for every action: the creator's `rules`, the defaults elsewhere (no lock applied). */
export function withDefaults(rules: Rules | undefined): Record<RuleAction, RuleValue> {
  const table = { ...DEFAULT_RULES };
  for (const action of RULE_ACTIONS) {
    const value = rules?.[action];
    if (value !== undefined) table[action] = value;
  }
  return table;
}

/** `RULE_LOCKED`: `value` loosens the locked `action`. */
export function ruleLocked(action: RuleAction, value: RuleValue): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.RULE_LOCKED, "error.rule_locked", {
    action,
    value,
    allowed: allowedValues(action).join(", "),
  });
}
