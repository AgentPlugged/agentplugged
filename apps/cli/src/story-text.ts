import {
  CHAINED_HOOK_NAME,
  COMMIT_HOOK_LINE,
  type FastTrackOutcome,
  type StoryPullRequestResult,
  type StoryStartResult,
} from "@agentplugged/core";
import { isMessageKey, type Translate } from "@agentplugged/i18n";
import { CREATOR_OWNER } from "@agentplugged/protocol";
import { displayText } from "./history-text.js";

/** The commit hook's line: active, chained, or the line the creator adds by hand. */
function hookLine(t: Translate, result: StoryStartResult): string | undefined {
  const { hook } = result;
  // A story without a branch of its own has no hook to install.
  if (hook === undefined) return undefined;
  if (hook.status === "manual") {
    return t(
      hook.reason === "hooks_path" ? "story.start.hook.hooks_path" : "story.start.hook.taken",
      {
        path: hook.path,
        chained: CHAINED_HOOK_NAME,
        line: COMMIT_HOOK_LINE,
      },
    );
  }
  if (hook.status === "chained") {
    return t("story.start.hook.chained", { path: hook.path, chained: CHAINED_HOOK_NAME });
  }
  return t("story.start.hook", { path: hook.path, story: result.story });
}

/** The reasons a story left the fast track, in words. */
export function fastTrackReasons(t: Translate, reasons: readonly string[]): string {
  return reasons
    .map((reason) => {
      const key = `fast_track.reason.${reason}`;
      return isMessageKey(key) ? t(key) : displayText(reason);
    })
    .join(", ");
}

/**
 * What the engine read of a story in the fast track: still a small change, or the way
 * back to the full lane with its reasons. Empty when the story is not in the fast track.
 */
export function fastTrackLines(t: Translate, outcome: FastTrackOutcome | undefined): string[] {
  if (outcome === undefined) return [];
  if (outcome.ok) return [`  ${t("story.fast_track.ok", { count: outcome.count })}`];
  return [
    `  ${t("story.fast_track.left", {
      reasons: fastTrackReasons(t, outcome.reasons),
      count: outcome.count,
    })}`,
  ];
}

/**
 * What `story start` did: the story started or resumed with its branch and base, the
 * working copy, the commit hook, then where to work.
 */
export function formatStoryStart(t: Translate, result: StoryStartResult): string {
  const values = {
    story: result.story,
    branch: result.branch,
    base_ref: result.base_ref,
    base: result.base.slice(0, 7),
  };
  // Built on the branch it lands on, with no branch of its own.
  const direct = result.story_branch === false;
  const hook = hookLine(t, result);
  const lines = [
    direct
      ? t(result.status === "started" ? "story.start.direct" : "story.start.resumed.direct", values)
      : t(result.status === "started" ? "story.start.started" : "story.start.resumed", values),
    `  ${t(direct ? "story.start.direct.workdir" : "story.start.workdir", { path: result.workdir })}`,
    ...(hook === undefined ? [] : [`  ${hook}`]),
    result.agent === CREATOR_OWNER
      ? t("story.start.next.creator")
      : t("story.start.next.agent", { agent: result.agent }),
    ...(result.track === "fast" ? [t("story.start.track.fast")] : []),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * What `story pr` did: the pull request opened, updated or already up to date with its
 * address, the branch pushed, then what its text says: criteria checked and tests.
 */
export function formatStoryPullRequest(t: Translate, result: StoryPullRequestResult): string {
  const lines = [
    t(`story.pr.${result.status}`, { story: result.story, url: result.url }),
    `  ${t("story.pr.branch", { branch: result.branch, base: result.base, head: result.head.slice(0, 7) })}`,
    `  ${t("story.pr.criteria", { checked: result.criteria.checked, total: result.criteria.total })}`,
    `  ${t(`story.pr.tests.${result.tests}`)}`,
  ];
  lines.push(...fastTrackLines(t, result.fast_track));
  return `${lines.join("\n")}\n`;
}
