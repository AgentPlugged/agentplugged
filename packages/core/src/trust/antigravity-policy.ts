import { RULE_ACTIONS, type RuleAction, type RuleValue } from "@agentplugged/protocol";
import { isRecord, isStrings } from "../values.js";

/**
 * The rules `sync` writes for Antigravity CLI's plugin hook, and how the engine reads
 * them back (`antigravity-guard.ts`). Apart from the guard so that `sync` writes them without
 * loading the engine's commands.
 */

/** What `sync` writes in `policy.json`: the rules in force and the lists of the tool's permissions. */
export interface AntigravityPolicy {
  readonly version: 1;
  /** The permission rules in force when `sync` ran: they decide which commands are gated. */
  readonly rules: Readonly<Record<RuleAction, RuleValue>>;
  /** The main branch's name, when one was found (`push_main` names it). */
  readonly main_branch?: string;
  /** Claude Code's `deny` and `ask` lists, as `sync` writes them (`Bash(…)`, `Edit(…)`, `Read(…)`…). */
  readonly deny: readonly string[];
  readonly ask: readonly string[];
}

/** The text of `policy.json`. */
export function renderPolicy(policy: AntigravityPolicy): string {
  return `${JSON.stringify(policy, null, 2)}\n`;
}

/** The policy `sync` wrote, or undefined when the text is not one (never guessed). */
export function parsePolicy(text: string): AntigravityPolicy | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.rules)) return undefined;
  if (!isStrings(value.deny) || !isStrings(value.ask)) return undefined;
  const rules = {} as Record<RuleAction, RuleValue>;
  for (const action of RULE_ACTIONS) {
    const rule = value.rules[action];
    if (rule !== "allow" && rule !== "ask" && rule !== "deny") return undefined;
    rules[action] = rule;
  }
  const main = value.main_branch;
  return {
    version: 1,
    rules,
    ...(typeof main === "string" && main !== "" ? { main_branch: main } : {}),
    deny: value.deny,
    ask: value.ask,
  };
}
