import type { PublicationExported, PublicationShown } from "@agentplugged/core";
import { isMessageKey, type Translate } from "@agentplugged/i18n";
import { SHORT_VERSION_TARGET_SECONDS } from "@agentplugged/protocol";
import { displayText } from "./history-text.js";

/**
 * A text written by an agent, line by line: every control character (ESC included) and bidi
 * override is a space, so that a deliverable can neither move the cursor nor fake a line of the
 * engine. Tabs and line breaks stay: this is the text to copy.
 */
export function bodyText(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.split("\t").map(displayText).join("\t"))
    .join("\n");
}

/** What `publication` prints: the presentation on standard error, the text on standard output. */
export interface PublicationOutput {
  readonly out: string;
  readonly err: string;
}

function stateOf(t: Translate, shown: PublicationShown): string {
  const key = `publication.state.${shown.decision ?? "open"}`;
  return isMessageKey(key) ? t(key) : displayText(shown.decision ?? "");
}

/**
 * The full text of a deliverable: the text alone, copyable, on standard output (several files,
 * each preceded by its path); the title, angle, audience, short version and size on standard error.
 */
export function formatPublicationShown(t: Translate, shown: PublicationShown): PublicationOutput {
  const err = [
    t("publication.header", {
      title: displayText(shown.title),
      checkpoint: shown.checkpoint,
      state: stateOf(t, shown),
    }),
  ];
  const presentation = shown.publication;
  if (presentation === null) err.push(t("publication.no_presentation"));
  else {
    err.push(
      t("publication.angle", { angle: displayText(presentation.angle) }),
      t("publication.audience", { audience: displayText(presentation.audience) }),
      t("publication.short", { short: displayText(presentation.short_version) }),
    );
  }
  if (shown.assurance !== null) {
    err.push(t("publication.assurance", { assurance: displayText(shown.assurance) }));
  }
  err.push(
    t("publication.size", { files: shown.total_files, words: shown.total_words }),
    ...(shown.files.length < shown.total_files
      ? [t("publication.partial", { shown: shown.files.length, total: shown.total_files })]
      : []),
  );
  const body = (text: string) => `${bodyText(text).replace(/\n+$/, "")}\n`;
  const out =
    shown.files.length === 1
      ? body(shown.raw ? (shown.files[0]?.raw ?? "") : (shown.files[0]?.text ?? ""))
      : shown.files
          .map(
            (file) =>
              `${t("publication.file", { path: displayText(file.path) })}\n\n${body(shown.raw ? file.raw : file.text)}`,
          )
          .join("\n");
  return { out, err: `${err.join("\n")}\n` };
}

/** What an export wrote, and the reminder that the creator publishes. */
export function formatPublicationExported(t: Translate, exported: PublicationExported): string {
  const lines = [
    t("publication.export.done", {
      title: displayText(exported.title),
      count: exported.files.length,
      directory: exported.directory,
    }),
    ...exported.files.map((file) =>
      t("publication.export.file", {
        status: t(`publication.export.${file.status}`),
        path: displayText(file.path),
      }),
    ),
    t("publication.export.sheet", { path: exported.sheet }),
  ];
  if (exported.reservations !== null) {
    lines.push(t("publication.export.reservations", { note: displayText(exported.reservations) }));
  }
  lines.push(t("publication.export.reminder"));
  return `${lines.join("\n")}\n`;
}

/** The seconds the short version is read in, as the engine and the agents state them. */
export const SHORT_VERSION_SECONDS = SHORT_VERSION_TARGET_SECONDS;
