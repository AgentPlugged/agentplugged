import type { HistoryEntry, HistoryResult, IgnoredValidation } from "@agentplugged/core";
import { isMessageKey, type MessageKey, type Translate } from "@agentplugged/i18n";
import type { IgnoredReason } from "@agentplugged/protocol";

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** True for a C0 or C1 control character (ESC included), DEL, or a bidi embedding or isolate. */
function unsafe(code: number): boolean {
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}

/**
 * A counted list in a text: its title with the count and one entry per item (a line, or several),
 * or the line that says there is none.
 */
export function pushList<T>(
  lines: string[],
  t: Translate,
  items: readonly T[],
  keys: { readonly none: MessageKey; readonly title: MessageKey },
  entry: (item: T) => string | readonly string[],
): void {
  if (items.length === 0) {
    lines.push(t(keys.none));
    return;
  }
  lines.push(t(keys.title, { count: items.length }));
  for (const item of items) lines.push(...[entry(item)].flat());
}

/**
 * A text written by an agent (or anyone with the journal), safe on one terminal line: each
 * control character (line breaks, ANSI escapes, DEL, C1) and each bidi override is a space, so no
 * field can fake another line, move the cursor or hide a warning.
 */
export function displayText(text: string): string {
  let out = "";
  for (const char of text) out += unsafe(char.codePointAt(0) ?? 0) ? " " : char;
  return out;
}

/** `2026-10-03 14:05:09 +02:00`: the date in this machine's time zone, with its offset. */
export function localDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return displayText(iso);
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function label(t: Translate, key: string, fallback: string): string {
  return isMessageKey(key) ? t(key) : displayText(fallback);
}

function author(t: Translate, entry: HistoryEntry): string {
  const device = displayText(entry.author);
  if (entry.author_trust === "root") return t("history.author.root", { device });
  if (entry.author_trust === "endorsed") {
    return entry.author_endorsed_at === null
      ? t("history.author.endorsed_undated", { device })
      : t("history.author.endorsed", { device, date: localDateTime(entry.author_endorsed_at) });
  }
  return device;
}

function checkpointText(t: Translate, entry: HistoryEntry): string {
  const id = displayText(entry.checkpoint);
  if (entry.checkpoint_type === null || entry.checkpoint_risk === null) {
    return t("history.checkpoint_unknown", { id });
  }
  const type =
    entry.checkpoint_type === "phase_end" && entry.checkpoint_phase !== null
      ? t("checkpoint.type.phase_end_of", {
          phase: label(t, `next.phase.${entry.checkpoint_phase}`, entry.checkpoint_phase),
        })
      : label(t, `checkpoint.type.${entry.checkpoint_type}`, entry.checkpoint_type);
  const risk = label(t, `checkpoint.risk.${entry.checkpoint_risk}`, entry.checkpoint_risk);
  const title = entry.checkpoint_title === null ? "" : displayText(entry.checkpoint_title).trim();
  return title === ""
    ? t("history.checkpoint_untitled", { id, type, risk })
    : t("history.checkpoint", { id, type, risk, title });
}

/**
 * One validation on one line: date in this machine's time zone, author (root key, or endorsed on…), source
 * (terminal, « via le chat », « appliqué automatiquement »), decision and its option or waiver
 * deadline, assurance (`locale` and « non vérifiée » always said), checkpoint (id, type, risk,
 * title), story, the creator's words quoted from the chat and who relayed them, and the warning
 * of a `high` risk answered in `locale`. Every text from the journal goes through `displayText`.
 */
export function formatHistoryLine(t: Translate, entry: HistoryEntry): string {
  const decision = label(t, `review.decision.${entry.decision}`, entry.decision);
  const detail =
    entry.option !== null
      ? ` (${t("history.option", { option: displayText(entry.option) })})`
      : entry.waiver_until !== null
        ? ` (${t("history.waiver_until", { date: localDateTime(entry.waiver_until) })})`
        : "";
  const parts = [
    localDateTime(entry.at),
    author(t, entry),
    // Chosen in the AI tool's form, named by its channel.
    // Or in the AI tool's question window (the creator's click, proved by its hook).
    entry.source === "elicitation"
      ? t(
          entry.via === "question_tool"
            ? "history.source.question_tool"
            : "history.source.elicitation",
          {
            channel: displayText(entry.channel ?? "-"),
          },
        )
      : label(t, `history.source.${entry.source}`, entry.source),
    `${decision}${detail}`,
    t("history.assurance", {
      assurance: label(t, `assurance.${entry.assurance}`, entry.assurance),
    }),
    checkpointText(t, entry),
    entry.story === null
      ? t("history.no_story")
      : t("history.story", { story: displayText(entry.story) }),
    // The creator's words relayed from the chat, and by whom.
    ...(entry.quote === null ? [] : [t("history.quote", { quote: displayText(entry.quote) })]),
    ...(entry.relayed_by === null
      ? []
      : [
          t(entry.source === "elicitation" ? "history.asked_by" : "history.relayed_by", {
            agent: displayText(entry.relayed_by),
          }),
        ]),
    // Answered with other points of a stack, in one message or one form.
    ...(entry.stack === null ? [] : [t("history.stack", { stack: displayText(entry.stack) })]),
    ...(entry.locale_on_high_risk ? [t("history.warning.locale_on_high_risk")] : []),
  ];
  return parts.join(" · ");
}

/** One ignored answer: id, local date, author, checkpoint, decision, then the reason. */
export function formatIgnoredLine(t: Translate, item: IgnoredValidation): string {
  const reasonKey = `journal.ignored.${item.reason satisfies IgnoredReason}`;
  return t("history.ignored.line", {
    id: displayText(item.event),
    at: localDateTime(item.at),
    author: item.author === null ? "-" : displayText(item.author),
    checkpoint: item.checkpoint === null ? "-" : displayText(item.checkpoint),
    decision:
      item.decision === null ? "-" : label(t, `review.decision.${item.decision}`, item.decision),
    reason: label(t, reasonKey, item.reason),
  });
}

/**
 * What `history` shows: the validations, most recent first (or « no validation »), then with
 * `--all` the answers the journal ignored, with their reason. With `--export`, what was written.
 */
export function formatValidationHistory(t: Translate, result: HistoryResult): string {
  const lines: string[] = [];
  if (result.export !== null) {
    const { format, count, replaced, ignored } = result.export;
    const path = displayText(result.export.path);
    const key: MessageKey = replaced ? "history.export.replaced" : "history.export.written";
    lines.push(t(key, { path, format: format.toUpperCase(), count }));
    if (count === 0) lines.push(t("history.none"));
    if (ignored !== null) lines.push(t("history.export.ignored", { ignored }));
    return `${lines.join("\n")}\n`;
  }
  pushList(
    lines,
    t,
    result.entries,
    { none: "history.none", title: "history.title" },
    (entry) => `  ${formatHistoryLine(t, entry)}`,
  );
  if (result.ignored !== null) {
    lines.push("");
    pushList(
      lines,
      t,
      result.ignored,
      { none: "history.ignored.none", title: "history.ignored.title" },
      (item) => `  ${formatIgnoredLine(t, item)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
