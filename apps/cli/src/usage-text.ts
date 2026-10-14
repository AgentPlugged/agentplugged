import type { UsageReport } from "@agentplugged/core";
import type { MessageKey, Translate } from "@agentplugged/i18n";
import { displayText } from "./history-text.js";

/** The rows `usage` prints: the heaviest; `--json` gives them all. */
const MAX_ROWS = 10;

const number = (value: number) => value.toLocaleString("en-US").replaceAll(",", " ");
const percent = (share: number) => `${Math.round(share * 1000) / 10}`;

/** The answer of `usage --json`: the report as the engine computed it, without what an optional source provided. */
export function usageJson(report: UsageReport): string {
  const { provided: _provided, ...shown } = report;
  return `${JSON.stringify(shown, null, 2)}\n`;
}

/**
 * What `usage` shows: tokens, and for each row the origin of its name (given by the
 * tool, deduced from an interval of the journal, or unknown); the share nothing could attribute;
 * the tools that cannot be measured; and a story's estimated cost, said to be an estimate. No
 * amount of money measured here. Text read in the journal or a
 * trace goes through `displayText`.
 */
export function formatUsage(t: Translate, report: UsageReport): string {
  const scope = [
    report.story === null ? "" : t("usage.scope.story", { story: report.story }),
    report.since === null ? "" : t("usage.scope.since", { day: report.since }),
    report.until === null ? "" : t("usage.scope.until", { day: report.until }),
  ].join("");
  const lines = [t("usage.title", { axis: t(`usage.axis.${report.axis}` as MessageKey), scope })];
  if (report.unreadable) lines.push(t("usage.unreadable"));
  if (!report.measured) {
    lines.push(t("usage.none"));
  } else {
    lines.push(
      t("usage.sessions", {
        count: String(report.sessions),
        bare: String(report.sessions_without_parts),
      }),
      t("usage.tokens", {
        total: number(report.total.total),
        input: number(report.total.tokens_in),
        output: number(report.total.tokens_out),
        read: number(report.total.cache_read),
        written: number(report.total.cache_write),
      }),
    );
    for (const row of report.rows.slice(0, MAX_ROWS)) {
      lines.push(
        t("usage.row", {
          key:
            row.key === null
              ? t(`usage.unattributed.${report.axis}` as MessageKey)
              : displayText(row.key),
          share: percent(row.share),
          total: number(row.total),
          origin: t(`usage.origin.${row.origin}` as MessageKey),
        }),
      );
    }
    if (report.rows.length > MAX_ROWS) {
      lines.push(t("usage.more", { count: String(report.rows.length - MAX_ROWS) }));
    }
    if (report.axis === "step" || report.axis === "skill" || report.axis === "story") {
      lines.push(t("usage.unattributed_share", { share: percent(report.unattributed_share) }));
    }
  }
  if (report.tools.unmeasurable.length > 0) {
    lines.push(t("usage.tools.unmeasurable", { tools: report.tools.unmeasurable.join(", ") }));
  }
  if (report.tools.unread.length > 0) {
    lines.push(t("usage.tools.unread", { tools: report.tools.unread.join(", ") }));
  }
  if (report.habits !== undefined) {
    const found = report.habits.found;
    const session = displayText(report.habits.session);
    if (found === null) {
      lines.push(t("usage.habits.unavailable", { session }));
    } else if (
      found.skills_reloaded.length + found.files_reread.length + found.tools_failing.length ===
      0
    ) {
      lines.push(t("usage.habits.none", { session }));
    } else {
      lines.push(t("usage.habits.title", { session }));
      for (const item of found.skills_reloaded) {
        lines.push(
          t("usage.habits.skill", { skill: displayText(item.skill), calls: String(item.calls) }),
        );
      }
      for (const item of found.files_reread) {
        lines.push(
          t("usage.habits.file", {
            path: displayText(item.path),
            reads: String(item.reads),
            chars: number(item.chars),
          }),
        );
      }
      for (const item of found.tools_failing) {
        lines.push(
          t("usage.habits.tool", {
            tool: displayText(item.tool),
            errors: String(item.errors),
            calls: String(item.calls),
          }),
        );
      }
    }
  }
  const estimate = report.estimates.standard;
  lines.push(
    t("usage.estimate", {
      low: String(estimate.low),
      expected: String(estimate.expected),
      high: String(estimate.high),
      basis: t(`usage.estimate.${estimate.basis}` as MessageKey, {
        stories: String(estimate.stories),
      }),
    }),
  );
  return `${lines.join("\n")}\n`;
}
