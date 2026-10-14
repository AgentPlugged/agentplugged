import type { CiCheckResult, CiSetupResult, CiWaiveResult } from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { displayText } from "./history-text.js";
import { fastTrackLines } from "./story-text.js";

/**
 * What `story ci` read: the CI's status on the story's branch, the failed checks,
 * then who to relaunch on a failure (or the block to lift first), and the pull request. With
 * `--waive`: the creator's acceptance of the story without its CI, for one commit.
 */
export function formatStoryCi(t: Translate, result: CiCheckResult | CiWaiveResult): string {
  if ("waived" in result) {
    return `${t("story.ci.waived", {
      story: result.story,
      commit: result.commit.slice(0, 7),
      reason: displayText(result.reason),
    })}\n`;
  }
  const values = {
    story: result.story,
    branch: displayText(result.branch),
    checks: result.checks,
    failed: result.failed.map(displayText).join(", "),
    agent: displayText(result.agent),
  };
  const lines = [t(`story.ci.${result.status}`, values)];
  if (result.status === "fail") {
    const next =
      result.story_status === "blocked"
        ? "story.ci.blocked"
        : result.reopened
          ? "story.ci.reopened"
          : "story.ci.relaunch";
    lines.push(t(next, values));
  }
  if (result.url !== undefined) {
    lines.push(`  ${t("story.ci.url", { url: displayText(result.url) })}`);
  }
  lines.push(...fastTrackLines(t, result.fast_track));
  return `${lines.join("\n")}\n`;
}

/** What `ci setup` did: the workflow written and what is left to fill, or the CI found. */
export function formatCiSetup(t: Translate, result: CiSetupResult): string {
  if (result.status === "not_wanted")
    return `${t("ci.setup.not_wanted")}
`;
  if (result.status === "exists") {
    return `${[
      t("ci.setup.exists", { files: result.existing.map(displayText).join(", ") }),
      // The tests an existing CI does not run.
      ...result.todo.map((todo) => `  ${t("ci.setup.gap", { todo: displayText(todo) })}`),
    ].join("\n")}\n`;
  }
  const lines = [
    t("ci.setup.created", {
      path: result.path ?? "",
      forge: result.forge ?? "",
      stack: result.stack ?? "",
    }),
    ...result.todo.map((todo) => `  ${t("ci.setup.todo", { todo: displayText(todo) })}`),
    t("ci.setup.next"),
  ];
  return `${lines.join("\n")}\n`;
}
