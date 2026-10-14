import type { MigrateResult } from "@agentplugged/core";
import { createTranslator } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";
import { errorMessage } from "./error-text.js";
import { formatMigrate } from "./migrate-text.js";

const PATH = ".agentplugged/method.yaml";
const base = {
  from_format: 0,
  to_format: 1,
  from_engine: "1.0.0",
  to_engine: "1.1.0",
  steps: ["step-one"],
};

describe("migrate output", () => {
  const t = createTranslator("fr");

  it("shows all a run would do, product id and journal included", () => {
    const planned: MigrateResult = {
      status: "planned",
      ...base,
      event: "written",
      product_id_added: "01JZ4444444444444444444444",
    };
    const text = formatMigrate(t, planned, PATH);
    expect(text).toContain("rien n'a été écrit");
    expect(text).toContain("product_id 01JZ4444444444444444444444 serait ajouté");
    expect(text).toContain("un événement method.migrated serait inscrit");
    const already = formatMigrate(
      t,
      { status: "planned", ...base, event: "already", event_id: "01JZ9" },
      PATH,
    );
    expect(already).toContain("contient déjà cette migration (01JZ9)");
    const noRepo = formatMigrate(t, { status: "planned", ...base, event: "no_repo" }, PATH);
    expect(noRepo).toContain("pas de dépôt Git");
  });

  it("names the event written, and the product id added", () => {
    const text = formatMigrate(
      t,
      {
        status: "migrated",
        ...base,
        event: "written",
        event_id: "01JZ7777777777777777777777",
        product_id_added: "01JZ4444444444444444444444",
      },
      PATH,
    );
    expect(text).toContain("Inscrit dans le journal (01JZ7777777777777777777777)");
    expect(text).toContain(`${PATH} nomme désormais le produit 01JZ4444444444444444444444`);
    expect(text).toContain(`puis committe ${PATH}`);
    expect(text).not.toContain("()");
  });

  it("never prints an empty event id, nor a commit without a Git repository", () => {
    const noId = formatMigrate(t, { status: "migrated", ...base, event: "written" }, PATH);
    expect(noId).not.toContain("()");
    expect(noId).toContain("Inscrit dans le journal :");
    const noRepo = formatMigrate(t, { status: "migrated", ...base, event: "no_repo" }, PATH);
    expect(noRepo).toContain("Pas de dépôt Git ici");
    expect(noRepo).not.toContain("committe");
    const already = formatMigrate(
      t,
      { status: "migrated", ...base, event: "already", event_id: "01JZ8" },
      PATH,
    );
    expect(already).toContain("contenait déjà cette migration (01JZ8)");
  });

  it("words the errors for agents and for a journal ahead, without a placeholder left", () => {
    const en = createTranslator("en");
    const agent = errorMessage(en, {
      message_key: "error.upgrade_required.agent",
      details: { install: "2.0.0", engine_version: "1.1.0", command: "get_state" },
    });
    expect(agent).toContain("npx agentplugged@2.0.0 sync");
    expect(agent).not.toContain("state.get");
    const migration = errorMessage(en, {
      message_key: "error.migration_required.agent",
      details: { path: PATH, format_version: 0, supported: 1 },
    });
    expect(migration).toContain("Ask the creator to run `npx agentplugged migrate`");
    const ahead = errorMessage(en, {
      message_key: "error.journal_format_upgrade_required",
      details: { format_version: 2, supported: 1, install: "2.0.0", command: "journal status" },
    });
    expect(ahead).toContain("npx agentplugged@2.0.0 journal status");
    expect(ahead).not.toMatch(/\{\w+\}/);
    const pulled = errorMessage(t, {
      message_key: "error.migrate.already_recorded",
      details: { event_id: "01JZ8", format_version: 1, engine: "1.1.0", path: PATH },
    });
    expect(pulled).toContain("git pull");
    const failed = errorMessage(t, {
      message_key: "error.migrate.write_failed",
      details: { event_id: "01JZ8", path: PATH, reason: "disk full" },
    });
    expect(failed).toContain("(01JZ8)");
    expect(failed).toContain("Relance `npx agentplugged migrate`");
  });
});
