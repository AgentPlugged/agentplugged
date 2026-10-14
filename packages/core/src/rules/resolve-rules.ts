import {
  type MethodConfig,
  RULE_ACTIONS,
  type RuleAction,
  RulesSchema,
  type RuleValue,
} from "@agentplugged/protocol";

import { METHOD_CONFIG_PATH } from "../init/layout.js";
import type { MainBranchRead, MainBranchReader } from "./main-branch.js";
import { methodSection } from "./method-section.js";
import { lockedValue, looseness, withDefaults } from "./rule-table.js";

/** Where the rules in force come from. */
export type RulesSource =
  | { readonly kind: "main"; readonly branch: string }
  | { readonly kind: "working_copy" };

/**
 * - `locked`: `method.yaml` (of the main branch, or of the working copy) loosens a locked action;
 *   the locked value applies (`RULE_LOCKED`).
 * - `working_copy_looser`: the working copy loosens a rule of the main branch, whose rule applies.
 * - `working_copy_pending`: the working copy tightens a rule; it applies once on the main branch.
 * - `no_main_branch`: no main branch was found, the rules of the current branch apply.
 * - `main_rules_invalid`: the `rules` of the main branch's `method.yaml` cannot be read; the
 *   defaults apply.
 * - `main_rules_missing`: the main branch has no `method.yaml` (not merged yet); the defaults apply.
 * - `local_branch_differs`: the local branch of the main branch's name has other commits than the
 *   remote-tracking one, which is read (`ahead`: local commits the remote lacks).
 * - `repository_refused`: Git refuses the folder (dubious ownership, not a work tree); the working
 *   copy's rules apply.
 * - `main_unreadable`: reading the main branch failed (a timeout, a damaged repository); the
 *   working copy's rules apply.
 */
export type RulesWarning =
  | {
      readonly kind: "locked";
      readonly action: RuleAction;
      readonly value: RuleValue;
      readonly applied: RuleValue;
      readonly where: "main" | "working_copy";
    }
  | {
      readonly kind: "working_copy_looser" | "working_copy_pending";
      readonly action: RuleAction;
      readonly working: RuleValue;
      readonly applied: RuleValue;
      readonly branch: string;
    }
  | { readonly kind: "no_main_branch"; readonly current?: string }
  | { readonly kind: "main_rules_invalid" | "main_rules_missing"; readonly branch: string }
  | {
      readonly kind: "local_branch_differs";
      /** The remote-tracking branch read (`origin/main`). */
      readonly branch: string;
      /** The local branch (`main`). */
      readonly local: string;
      readonly ahead: number;
      readonly behind: number;
    }
  | { readonly kind: "repository_refused" | "main_unreadable"; readonly reason: string };

export interface ResolvedRules {
  /** The rule in force for every action, locks applied. */
  readonly rules: Readonly<Record<RuleAction, RuleValue>>;
  /** The working copy's rules, locks applied: what `rules set` recorded here. */
  readonly working: Readonly<Record<RuleAction, RuleValue>>;
  readonly source: RulesSource;
  readonly warnings: readonly RulesWarning[];
  /** The main branch's short name (`main`), when one was found: `push_main` names it. */
  readonly mainBranch?: string;
}

/**
 * The `rules` section of a `method.yaml` text: undefined when the file has none, `"invalid"` when
 * the text or the section cannot be read.
 */
const rulesOf = (text: string) => methodSection(text, "rules", RulesSchema);

/** `origin/main` → `main`. */
function shortName(branch: string): string {
  return branch.startsWith("origin/") ? branch.slice("origin/".length) : branch;
}

/** A table with the locks applied, each locked value reported as a warning. */
function applyLocks(
  table: Readonly<Record<RuleAction, RuleValue>>,
  where: "main" | "working_copy",
  warnings: RulesWarning[] | undefined,
): Record<RuleAction, RuleValue> {
  const rules = {} as Record<RuleAction, RuleValue>;
  for (const action of RULE_ACTIONS) {
    const value = table[action];
    const applied = lockedValue(action, value);
    rules[action] = applied;
    if (applied !== value) warnings?.push({ kind: "locked", action, value, applied, where });
  }
  return rules;
}

/** The reader's answer; a failure (a timeout, a damaged repository) becomes `unreadable`. */
async function readMain(
  reader: MainBranchReader | undefined,
): Promise<MainBranchRead | { readonly unreadable: string } | undefined> {
  if (reader === undefined) return undefined;
  try {
    return await reader.read(METHOD_CONFIG_PATH);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { unreadable: reason.split(/\r?\n/)[0] ?? reason };
  }
}

/**
 * The rules in force: those of `method.yaml` on the main branch, locks applied. The
 * working copy's `rules` (`working`) never apply while a main branch exists: a looser one is
 * reported, a stricter one too (it applies once merged). Without a main branch, when Git refuses
 * the folder or cannot be read (or without a reader), the working copy's rules apply, with a
 * warning except outside any repository.
 */
export async function resolveRules(
  working: MethodConfig,
  reader: MainBranchReader | undefined,
): Promise<ResolvedRules> {
  const warnings: RulesWarning[] = [];
  const read = await readMain(reader);
  const workingTable = withDefaults(working.rules);
  if (read === undefined || "unreadable" in read || !read.found) {
    if (read !== undefined && "unreadable" in read) {
      warnings.push({ kind: "main_unreadable", reason: read.unreadable });
    } else if (read?.reason === "no_main_branch") {
      warnings.push(
        read.current === undefined
          ? { kind: "no_main_branch" }
          : { kind: "no_main_branch", current: read.current },
      );
    } else if (read?.refused !== undefined) {
      warnings.push({ kind: "repository_refused", reason: read.refused });
    }
    const rules = applyLocks(workingTable, "working_copy", warnings);
    return { rules, working: rules, source: { kind: "working_copy" }, warnings };
  }
  const { branch } = read;
  if (read.local !== undefined) {
    const { branch: local, ahead, behind } = read.local;
    warnings.push({ kind: "local_branch_differs", branch, local, ahead, behind });
  }
  const parsed = read.text === undefined ? undefined : rulesOf(read.text);
  if (read.text === undefined) warnings.push({ kind: "main_rules_missing", branch });
  if (parsed === "invalid") warnings.push({ kind: "main_rules_invalid", branch });
  const mainTable = withDefaults(parsed === "invalid" ? undefined : parsed);
  const rules = applyLocks(mainTable, "main", warnings);
  const workingApplied = applyLocks(workingTable, "working_copy", undefined);
  for (const action of RULE_ACTIONS) {
    const wanted = workingTable[action];
    if (wanted === mainTable[action]) continue;
    const wantedApplied = workingApplied[action];
    if (wantedApplied !== wanted) {
      warnings.push({
        kind: "locked",
        action,
        value: wanted,
        applied: wantedApplied,
        where: "working_copy",
      });
    }
    const applied = rules[action];
    if (wantedApplied === applied) continue;
    const kind =
      looseness(wantedApplied) > looseness(applied)
        ? "working_copy_looser"
        : "working_copy_pending";
    warnings.push({ kind, action, working: wantedApplied, applied, branch });
  }
  return {
    rules,
    working: workingApplied,
    source: { kind: "main", branch },
    warnings,
    mainBranch: shortName(branch),
  };
}
