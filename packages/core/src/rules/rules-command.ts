import { RULE_ACTIONS, RULE_VALUES, type RuleAction, type RuleValue } from "@agentplugged/protocol";
import { isMap, parseDocument } from "yaml";
import { invalidArgument } from "../agents/create-fields.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { reviewNotInteractive } from "../human/human-commands.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { editedMethodText, loadMethodConfig, parseMethodConfig } from "../init/method-config.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import { type RulesSource, type RulesWarning, resolveRules } from "./resolve-rules.js";
import {
  allowedValues,
  DEFAULT_RULES,
  isRuleAction,
  isRuleValue,
  lockOf,
  type RuleLock,
  ruleLocked,
} from "./rule-table.js";

/** One row of the table `rules` shows. */
export interface RuleRow {
  readonly action: RuleAction;
  /** The rule in force (locks applied). */
  readonly rule: RuleValue;
  /** The working copy's rule (locks applied): differs from `rule` until merged into main. */
  readonly recorded: RuleValue;
  readonly default: RuleValue;
  readonly lock: RuleLock;
}

export interface RulesResult {
  /** `show`, `set` or `reset`. */
  readonly action: "show" | "set" | "reset";
  readonly rows: readonly RuleRow[];
  readonly source: RulesSource;
  readonly warnings: readonly RulesWarning[];
  /** `set` and `reset`: `method.yaml` was written (false when nothing changed). */
  readonly written?: boolean;
  /**
   * `set`: the action and value recorded in the working copy, and the rule in force for that
   * action (from the main branch, which may differ until the change is merged there).
   */
  readonly set?: {
    readonly action: RuleAction;
    readonly value: RuleValue;
    readonly inForce: RuleValue;
  };
}

/**
 * Writes `rules.<action>` into the text of `method.yaml`, keeping comments, other keys and line
 * endings. A value equal to the default removes the key (the default is never pinned); without
 * `action`, the whole `rules` section goes. The text is returned as is when nothing changes.
 */
export function writeRule(
  text: string,
  action: RuleAction | undefined,
  value?: RuleValue,
): string | AgentPluggedError {
  const document = parseDocument(text);
  if (action === undefined) {
    if (!document.has("rules")) return text;
    document.delete("rules");
  } else {
    const path = ["rules", action];
    if (value === DEFAULT_RULES[action]) {
      if (!document.hasIn(path)) return text;
      document.deleteIn(path);
    } else {
      if (document.getIn(path) === value) return text;
      document.setIn(path, value);
    }
  }
  const node = document.get("rules", true);
  if (isMap(node) && node.items.length === 0) document.delete("rules");
  // No refolding and no padding in flow lists: untouched lines stay as the creator wrote them.
  return editedMethodText(document, text, true);
}

function invalidRule(value: unknown, values: readonly string[], option: string) {
  return invalidArgument("error.rules.invalid_choice", {
    option,
    value: String(value),
    values: values.join(", "),
  });
}

export const rulesCommand = defineCommand<RulesResult>({
  name: "rules",
  /**
   * Shows the permission rules (`action: "show"`, the default), or, for the creator at a
   * terminal only, records one (`set`, with `rule` and `value`) or goes back to the defaults
   * (`reset`). The rules in force are read from the main branch.
   */
  async run(context, input) {
    const action = input.action ?? "show";
    if (action !== "show" && action !== "set" && action !== "reset") {
      return fail(invalidRule(action, ["show", "set", "reset"], "rules <show|set|reset>"));
    }
    let wanted: { action: RuleAction; value: RuleValue } | undefined;
    if (action === "set") {
      if (!isRuleAction(input.rule)) {
        return fail(invalidRule(input.rule, RULE_ACTIONS, "rules set <action>"));
      }
      if (!isRuleValue(input.value)) {
        return fail(invalidRule(input.value, RULE_VALUES, "rules set <action> <allow|ask|deny>"));
      }
      wanted = { action: input.rule, value: input.value };
    }
    // A locked rule is never loosened, whoever asks: refused before anything is read or written.
    if (wanted !== undefined && !allowedValues(wanted.action).includes(wanted.value)) {
      return fail(ruleLocked(wanted.action, wanted.value));
    }
    // Changing a rule is the creator's, at a terminal: refused before anything is read.
    if (action !== "show" && context.interactive !== true) {
      return fail(reviewNotInteractive(`rules ${action}`));
    }
    const { files } = context;
    if (!(await files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);

    let config = loaded.config;
    let written: boolean | undefined;
    if (action !== "show") {
      const content = writeRule(loaded.text, wanted?.action, wanted?.value);
      if (content instanceof AgentPluggedError) return fail(content);
      written = content !== loaded.text;
      if (written) {
        await files.writeText(METHOD_CONFIG_PATH, content);
        const parsed = parseMethodConfig(content);
        if (parsed instanceof AgentPluggedError) return fail(parsed);
        config = parsed;
      }
    }
    const resolved = await resolveRules(config, context.mainBranch);
    const rows = RULE_ACTIONS.map((rule) => ({
      action: rule,
      rule: resolved.rules[rule],
      recorded: resolved.working[rule],
      default: DEFAULT_RULES[rule],
      lock: lockOf(rule),
    }));
    return ok({
      action,
      rows,
      source: resolved.source,
      warnings: resolved.warnings,
      ...(written === undefined ? {} : { written }),
      ...(wanted === undefined
        ? {}
        : { set: { ...wanted, inForce: resolved.rules[wanted.action] } }),
    });
  },
});
