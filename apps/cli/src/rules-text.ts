import {
  METHOD_CONFIG_PATH,
  type RulesResult,
  type RulesWarning,
  type SyncRules,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { displayText } from "./history-text.js";

/** One warning about the permission rules, in the creator's language. */
export function formatRulesWarning(t: Translate, warning: RulesWarning): string {
  switch (warning.kind) {
    case "locked":
      return t(
        warning.where === "main"
          ? "rules.warning.locked.main"
          : "rules.warning.locked.working_copy",
        { action: warning.action, value: warning.value, applied: warning.applied },
      );
    case "working_copy_looser":
    case "working_copy_pending":
      return t(`rules.warning.${warning.kind}`, {
        action: warning.action,
        working: warning.working,
        applied: warning.applied,
        branch: displayText(warning.branch),
      });
    case "no_main_branch":
      return warning.current === undefined
        ? t("rules.warning.no_main_branch")
        : t("rules.warning.no_main_branch.current", { branch: displayText(warning.current) });
    case "main_rules_invalid":
    case "main_rules_missing":
      return t(`rules.warning.${warning.kind}`, { branch: displayText(warning.branch) });
    case "local_branch_differs":
      return t("rules.warning.local_branch_differs", {
        branch: displayText(warning.branch),
        local: displayText(warning.local),
        ahead: warning.ahead,
        behind: warning.behind,
      });
    case "repository_refused":
    case "main_unreadable":
      return t(`rules.warning.${warning.kind}`, { reason: displayText(warning.reason) });
  }
}

/**
 * The table of `rules`: action (with what it covers), rule in force, default, lock; then the
 * warnings, and what `set` or `reset` did.
 */
export function formatRules(t: Translate, result: RulesResult): string {
  const header = [
    t("rules.header.action"),
    t("rules.header.rule"),
    t("rules.header.default"),
    t("rules.header.lock"),
  ];
  const rows = result.rows.map((row) => [
    `${row.action} (${t(`rules.action.${row.action}`)})`,
    row.rule,
    row.default,
    t(`rules.lock.${row.lock}`),
  ]);
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...rows.map((row) => (row[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    `  ${cells.map((cell, i) => (i === cells.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ")}`;
  const title =
    result.source.kind === "main"
      ? t("rules.title.main", { branch: displayText(result.source.branch) })
      : t("rules.title.working_copy");
  let text = `${title}\n${line(header)}\n${rows.map(line).join("\n")}\n`;
  if (result.warnings.length > 0) {
    const warnings = result.warnings.map((warning) => `  ${formatRulesWarning(t, warning)}`);
    text += `\n${t("rules.warnings.title")}\n${warnings.join("\n")}\n`;
  }
  text += `\n${t("rules.note.guard_rails")}\n`;
  const path = METHOD_CONFIG_PATH;
  const branch = result.source.kind === "main" ? displayText(result.source.branch) : undefined;
  if (result.action === "set" && result.set !== undefined) {
    const { action, value, inForce } = result.set;
    const key = result.written === true ? "rules.set.done" : "rules.set.unchanged";
    text += `\n${t(key, { action, value, path })}\n`;
    // On a branch other than the main one, what is recorded here is not in force yet.
    if (branch !== undefined && inForce !== value) {
      text += `${t("rules.set.recorded_here", { value, branch, in_force: inForce })}\n`;
      text += `${t("rules.set.merge_hint", { branch })}\n`;
    }
  } else if (result.action === "reset") {
    text += `\n${t(result.written === true ? "rules.reset.done" : "rules.reset.unchanged", { path })}\n`;
    if (branch !== undefined && result.rows.some((row) => row.recorded !== row.rule)) {
      text += `${t("rules.set.merge_hint", { branch })}\n`;
    }
  }
  return text;
}

/** What `sync` reports about the permission rules: where they were read, then what to know. */
export function formatSyncRules(t: Translate, rules: SyncRules | undefined): string {
  if (rules === undefined) return "";
  const source =
    rules.source.kind === "main"
      ? t("rules.source.main", { branch: displayText(rules.source.branch) })
      : t("rules.source.working_copy");
  const lines = [source, ...rules.warnings.map((warning) => formatRulesWarning(t, warning))];
  if (rules.cursorAskedAsDeny.length > 0) {
    lines.push(t("rules.cursor_ask_as_deny", { actions: rules.cursorAskedAsDeny.join(", ") }));
  }
  for (const { path, count } of rules.allowAdded) {
    lines.push(t("rules.allow_added", { path, count }));
  }
  for (const { path, rule, list } of rules.conflicts) {
    lines.push(t("rules.conflict", { path, rule, list }));
  }
  return `\n${t("rules.warnings.title")}\n${lines.map((line) => `  ${line}`).join("\n")}\n`;
}
