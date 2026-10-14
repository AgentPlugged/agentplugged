import type { MigrateResult } from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";

type Note = NonNullable<MigrateResult["notes"]>[number];

/** One change of a step the creator should know, on one line. */
function noteLine(t: Translate, note: Note): string {
  switch (note.kind) {
    case "specialties":
      return note.developers === 0
        ? t("migrate.note.specialties.none")
        : t("migrate.note.specialties", {
            count: note.developers,
            list: note.specialties.join(", "),
            ceiling: note.max_parallel_stories ?? note.developers,
          });
    case "setting_moved":
      return t("migrate.note.setting_moved", { from: note.from, to: note.to });
    case "override_moved":
      return t("migrate.note.override_moved", { from: note.from, to: note.to });
    case "setting_dropped":
      return t("migrate.note.setting_dropped", { from: note.from });
    case "list_dropped":
      return t("migrate.note.list_dropped", { from: note.from });
    case "override_retired":
      return t("migrate.note.override_retired", { from: note.from, path: note.path });
  }
}

/** The step's changes: notes, then the count of files written and removed. */
function changeLines(t: Translate, result: MigrateResult): string[] {
  const lines = (result.notes ?? []).map((note) => `  ${noteLine(t, note)}`);
  const files = result.files ?? [];
  const written = files.filter((file) => file.action === "write").length;
  const removed = files.length - written;
  if (files.length > 0) lines.push(`  ${t("migrate.files", { written, removed })}`);
  if ((result.notes ?? []).some((note) => note.kind === "specialties")) {
    lines.push(`  ${t("migrate.note.adjust")}`);
  }
  return lines;
}

/** What `migrate` found, would do (`--check`) or did, in the creator's language. */
export function formatMigrate(t: Translate, result: MigrateResult, path: string): string {
  if (result.status === "up_to_date") {
    return `${t("migrate.up_to_date", { format: result.to_format, engine: result.to_engine, path })}\n`;
  }
  const lines = [
    t(result.status === "planned" ? "migrate.planned.title" : "migrate.done.title"),
    t("migrate.format", { from: result.from_format, to: result.to_format }),
    t("migrate.engine", {
      from: result.from_engine ?? t("migrate.engine.none"),
      to: result.to_engine,
    }),
    result.steps.length === 0
      ? t("migrate.steps.none")
      : t("migrate.steps", { list: result.steps.join(", ") }),
    ...changeLines(t, result),
  ];
  if (result.status === "planned") {
    if (result.product_id_added !== undefined) {
      lines.push(t("migrate.planned.product_id", { path, product_id: result.product_id_added }));
    }
    if (result.event === "already" && result.event_id !== undefined) {
      lines.push(t("migrate.planned.event.already", { id: result.event_id }));
    } else if (result.event === "no_repo") {
      lines.push(t("migrate.planned.event.no_repo"));
    } else lines.push(t("migrate.planned.event.written"));
    lines.push("", t("migrate.check.next"));
    return `${lines.join("\n")}\n`;
  }
  lines.push("");
  if (result.product_id_added !== undefined) {
    lines.push(t("migrate.product_id_added", { path, product_id: result.product_id_added }));
  }
  const id = result.event_id;
  if (result.event === "no_repo") lines.push(t("migrate.event.no_repo", { path }));
  else if (result.event === "already" && id !== undefined) {
    lines.push(t("migrate.event.already", { id, path }));
  } else if (id !== undefined) lines.push(t("migrate.event.written", { id }));
  else lines.push(t("migrate.event.written.no_id"));
  // Without a Git repository, there is nothing to commit.
  lines.push(
    result.event === "no_repo" ? t("migrate.next_step.no_repo") : t("migrate.next_step", { path }),
  );
  return `${lines.join("\n")}\n`;
}
