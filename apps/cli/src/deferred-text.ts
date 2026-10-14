import type { DeferredItem, DeferredResult } from "@agentplugged/core";
import { isMessageKey, type Translate } from "@agentplugged/i18n";
import { displayText, localDateTime } from "./history-text.js";

/** Where an item comes from, who treats it, what it locks and when: one indented line. */
function detailLine(t: Translate, item: DeferredItem): string {
  const story = item.story === null ? null : displayText(item.story);
  const parts = [
    item.origin === "review"
      ? t("deferred.item.origin.review", { story: story ?? "" })
      : story === null
        ? t("deferred.item.origin.deliberate")
        : t("deferred.item.origin.deliberate_story", { story }),
    item.owner === "creator"
      ? t("deferred.item.owner_creator")
      : t("deferred.item.owner", { owner: displayText(item.owner) }),
  ];
  if (item.locks.length > 0) {
    parts.push(t("deferred.item.locks", { stories: item.locks.map(displayText).join(", ") }));
  }
  if (item.phase !== null) {
    const key = `next.phase.${item.phase}`;
    parts.push(t("deferred.item.phase", { phase: isMessageKey(key) ? t(key) : item.phase }));
  }
  return `    ${parts.join(" · ")}`;
}

/** How a closed item was closed: when, by whom, why. */
function closedLine(t: Translate, item: DeferredItem): string[] {
  const closed = item.closed;
  if (closed === null) return [];
  const key =
    closed.outcome === "dropped" ? "deferred.item.closed.dropped" : "deferred.item.closed.done";
  return [
    t(key, {
      at: localDateTime(closed.at),
      by: displayText(closed.by),
      reason: displayText(closed.reason),
    }),
  ];
}

/** An item on two lines (three when closed): its id and title, then where it stands. */
function itemLines(t: Translate, item: DeferredItem): string[] {
  return [
    t("deferred.item", { id: item.id, title: displayText(item.title) }),
    detailLine(t, item),
    ...closedLine(t, item),
  ];
}

/**
 * What `deferred` shows: the open items in recording order (with `--all`, the closed
 * ones after them, with when, by whom and why), the closed counts and how to close one; one item
 * with `show`; or the closing written. Every text from the journal goes through `displayText`.
 */
export function formatDeferred(t: Translate, result: DeferredResult): string {
  if (result.action === "show") {
    const { item } = result;
    const lines = [
      ...itemLines(t, item),
      t(`deferred.show.status.${item.status}`),
      t("deferred.show.recorded", {
        at: localDateTime(item.recorded_at),
        by: displayText(item.recorded_by),
      }),
    ];
    if (item.detail !== null) {
      lines.push(t("deferred.show.detail"));
      for (const line of item.detail.split(/\r?\n/)) lines.push(`    ${displayText(line)}`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (result.action !== "list") {
    const key = result.outcome === "dropped" ? "deferred.dropped" : "deferred.resolved";
    return `${t(key, { id: result.item, title: displayText(result.title) })}\n`;
  }
  const story = result.story === null ? null : displayText(result.story);
  const lines: string[] = [];
  if (result.open.length === 0) {
    lines.push(
      story === null ? t("deferred.list.empty") : t("deferred.list.empty_story", { story }),
    );
  } else {
    const count = result.open.length;
    lines.push(
      story === null
        ? t("deferred.list.title", { count })
        : t("deferred.list.title_story", { story, count }),
    );
    for (const item of result.open) lines.push(...itemLines(t, item));
  }
  if (result.closed !== null && result.closed.length > 0) {
    lines.push(t("deferred.list.closed_title", { count: result.closed.length }));
    for (const item of result.closed) lines.push(...itemLines(t, item));
  }
  lines.push(t("deferred.list.closed", { done: result.done, dropped: result.dropped }));
  if (result.open.length > 0) lines.push(t("deferred.list.hint"));
  return `${lines.join("\n")}\n`;
}

/** `deferred --json` (`list` and `show`): the result as data, values exact. */
export function deferredJson(result: DeferredResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
