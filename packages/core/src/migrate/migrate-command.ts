import {
  ErrorCode,
  METHOD_EVENT_TYPES,
  METHOD_FORMAT_VERSION,
  type MethodMigratedPayload,
  type ProjectionState,
  SemverSchema,
  ULID_PATTERN,
} from "@agentplugged/protocol";
import { invalidArgument } from "../agents/create-fields.js";
import {
  type CommandContext,
  type CommandInput,
  type CommandResult,
  defineCommand,
  fail,
  ok,
} from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { reviewNotInteractive } from "../human/human-commands.js";
import { compareSemver } from "../init/engine-check.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { methodConfigInvalid } from "../init/method-config.js";
import { readMachineKey } from "../journal/key-store.js";
import type { JournalListing } from "../journal/state-store.js";
import { createUlidFactory } from "../journal/ulid.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import { computeProjection } from "../projection/compute-projection.js";
import {
  applyMigration,
  METHOD_MIGRATIONS,
  type MigrationFileOperation,
  type MigrationNote,
  migrationNotes,
  planMigration,
  planMigrationFiles,
  readFormat,
  readTopLevel,
} from "./migrations.js";

/**
 * What `migrate` found or did. `up_to_date`: nothing to do, nothing written. `planned`
 * (`--check`): what a run would do, nothing written. `migrated`: `method.yaml` written. `event`:
 * `written` (a new `method.migrated`), `already` (the journal held this very migration, recorded
 * by this machine before its `method.yaml` could be written: no second event), `no_repo` (no Git
 * repository, no event). For `planned`, what a run would do.
 */
export interface MigrateResult {
  readonly status: "up_to_date" | "planned" | "migrated";
  readonly from_format: number;
  readonly to_format: number;
  /** The engine pinned before (null when `method.yaml` pinned none). */
  readonly from_engine: string | null;
  /** The engine pinned after: the running one. */
  readonly to_engine: string;
  /** The steps applied (or to apply), in order. */
  readonly steps: readonly string[];
  readonly event?: "written" | "already" | "no_repo";
  /** The id of `method.migrated`, written now or before (`already`). */
  readonly event_id?: string;
  /** The `product_id` added to `method.yaml` (or to add), when it had none. */
  readonly product_id_added?: string;
  /**
   * What the steps changed that the creator should know: specialties and ceiling,
   * settings and customisations moved to their successor or kept aside.
   */
  readonly notes?: readonly MigrationNote[];
  /** The other files of `.agentplugged/` written or removed (or to be), in order. */
  readonly files?: readonly { readonly path: string; readonly action: "write" | "remove" }[];
}

/** `state.format` of the projection (the `method.migrated` reducer). */
interface RecordedFormat {
  readonly version: number;
  readonly engine: string;
  readonly id: string;
  readonly device: string;
}

function isNotARepository(error: unknown): boolean {
  return error instanceof AgentPluggedError && error.code === ErrorCode.NOT_A_GIT_REPO;
}

function conflict(messageKey: string, details: Record<string, unknown>): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.MIGRATION_CONFLICT, messageKey, details);
}

/** Thrown by the append's precondition: the journal already holds this machine's migration. */
class AlreadyRecorded extends Error {
  constructor(readonly eventId: string) {
    super("already recorded");
  }
}

/**
 * What the journal already says of the migration to `toEngine` at the current format:
 * `undefined` when nothing (or an older engine) is recorded; `{ id }` when this machine recorded
 * this very migration (its `method.yaml` was not written: no second event), or when this machine
 * is not known (`--check`, no keychain); else
 * `MIGRATION_CONFLICT`: another machine recorded it, or a newer engine did, and this working copy
 * has not received its `method.yaml` (`git pull`).
 */
function recordedMigration(
  state: ProjectionState,
  toEngine: string,
  machine: string | null | undefined,
): { readonly id: string; readonly device: string } | AgentPluggedError | undefined {
  const format = state.state.format as RecordedFormat | undefined;
  if (format === undefined || format.version < METHOD_FORMAT_VERSION) return undefined;
  const order = compareSemver(format.engine, toEngine);
  if (order < 0) return undefined;
  if (order === 0 && (machine === undefined || format.device === machine)) {
    return { id: format.id, device: format.device };
  }
  return conflict("error.migrate.already_recorded", {
    reason: "already_recorded",
    event_id: format.id,
    format_version: format.version,
    engine: format.engine,
    path: METHOD_CONFIG_PATH,
  });
}

/**
 * This machine's device in the journal, from the keychain (never created here): null when this
 * machine has no key (it never wrote), undefined when unknown (no keychain given or readable).
 */
async function thisMachine(context: CommandContext): Promise<string | null | undefined> {
  const keys = context.keys;
  if (keys === undefined) return undefined;
  try {
    return (await readMachineKey(keys))?.device ?? null;
  } catch {
    return undefined;
  }
}

/**
 * `migrate [--check]`: brings `.agentplugged/` to the format this engine knows and
 * pins this engine in `method.yaml`, comments kept. The migration is recorded by a
 * `method.migrated` event signed by the machine's key, written before `method.yaml`; nothing of
 * the journal is rewritten, and a migration the journal already holds is never recorded twice.
 * A journal that needs a newer engine stops it (`UPGRADE_REQUIRED`). The creator's command, at a
 * terminal only (agents are denied it by `sync`); `--check` writes nothing and asks no terminal.
 */
export const migrateCommand = defineCommand<MigrateResult>({
  name: "migrate",
  migratesFormat: true,
  async run(context, input) {
    try {
      return await migrate(context, input);
    } catch (error) {
      // `UPGRADE_REQUIRED`, `PRODUCT_ID_MISMATCH`, `JOURNAL_BUSY`…: nothing was written.
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

async function migrate(
  context: CommandContext,
  input: CommandInput,
): Promise<CommandResult<MigrateResult>> {
  const check = input.check;
  if (check !== undefined && typeof check !== "boolean") {
    return fail(invalidArgument("error.invalid_arguments", { reason: "migrate: --check" }));
  }
  if (check !== true && context.interactive !== true) {
    return fail(reviewNotInteractive("migrate"));
  }
  const { files, journal } = context;
  if (!(await files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
  const text = await files.readText(METHOD_CONFIG_PATH);
  const from = readFormat(text);
  if (from instanceof AgentPluggedError) return fail(from);
  // A newer format is stopped before (`UPGRADE_REQUIRED`): never migrated down.
  if (from > METHOD_FORMAT_VERSION) {
    return fail(methodConfigInvalid("format_version", `format ${from} is newer than this engine`));
  }
  const pinned = readTopLevel(text, "engine_version");
  const fromEngine = SemverSchema.safeParse(pinned).success ? (pinned as string) : null;
  const toEngine = context.engineVersion;
  const steps = planMigration(from, METHOD_FORMAT_VERSION, context.migrations ?? METHOD_MIGRATIONS);
  if (steps instanceof AgentPluggedError) return fail(steps);

  // The journal: read once, to know its product, that this engine can read all of it, and what
  // it already records.
  let listing: JournalListing | undefined;
  let journalProductId: string | null = null;
  if (journal !== undefined) {
    try {
      listing = await journal.list();
      journalProductId = await journal.productId();
    } catch (error) {
      if (!isNotARepository(error)) throw error;
      listing = undefined;
    }
  }
  const own = readTopLevel(text, "product_id");
  const ownId = typeof own === "string" && ULID_PATTERN.test(own) ? own : undefined;
  const newId = context.newId ?? createUlidFactory();
  const productId = ownId ?? journalProductId ?? newId();
  const projectionOptions = {
    product: productId,
    allowTestTypes: context.allowTestTypes === true,
    engineVersion: toEngine,
  };
  const project = (current: JournalListing) =>
    computeProjection(current.events, { ...projectionOptions, problems: current.problems });
  const state = listing === undefined ? undefined : await project(listing);

  const summary = {
    from_format: from,
    to_format: METHOD_FORMAT_VERSION,
    from_engine: fromEngine,
    to_engine: toEngine,
    steps: steps.map((step) => step.id),
  };
  if (steps.length === 0 && fromEngine === toEngine) {
    return ok({ status: "up_to_date", ...summary });
  }
  const migrated = applyMigration(text, steps, { engineVersion: toEngine, productId });
  if (migrated instanceof AgentPluggedError) return fail(migrated);
  const added = ownId === undefined ? { product_id_added: productId } : {};
  // The other files of the steps, planned before anything is written: an agent of
  // the creator's that takes a new name stops everything here (`AGENT_ID_CONFLICT`).
  const filePlan = await planMigrationFiles(steps, files, context.method);
  if (filePlan instanceof AgentPluggedError) return fail(filePlan);
  const notes = [...migrationNotes(text, steps), ...filePlan.notes];
  const operations: readonly MigrationFileOperation[] = filePlan.operations;
  const changes = {
    ...(notes.length > 0 ? { notes } : {}),
    ...(operations.length > 0
      ? { files: operations.map(({ path, action }) => ({ path, action })) }
      : {}),
  };

  // `--check` opens no keychain: a migration already recorded is shown as such.
  const machine = check === true ? undefined : await thisMachine(context);
  const recorded = state === undefined ? undefined : recordedMigration(state, toEngine, machine);
  if (recorded instanceof AgentPluggedError) return fail(recorded);
  if (check === true) {
    const event =
      listing === undefined ? "no_repo" : recorded === undefined ? "written" : "already";
    return ok({
      status: "planned",
      ...summary,
      event,
      ...(recorded === undefined ? {} : { event_id: recorded.id }),
      ...added,
      ...changes,
    });
  }

  // The event first: a failure leaves `method.yaml` as it was, and `migrate` can run again.
  let event: "written" | "already" | "no_repo" = "no_repo";
  let eventId: string | undefined;
  if (recorded !== undefined) {
    event = "already";
    eventId = recorded.id;
  } else if (journal !== undefined && listing !== undefined) {
    const payload: MethodMigratedPayload = summary;
    try {
      const [written] = await journal.appendAll(
        [
          {
            type: METHOD_EVENT_TYPES.migrated,
            actor: { kind: "system" },
            product: productId,
            provenance: "trusted",
            payload,
          },
        ],
        {
          // Under the journal's lock, as it is when written: `method.yaml` unchanged since read,
          // the journal readable by this engine, and the migration not recorded meanwhile.
          precondition: async (current) => {
            if ((await files.readText(METHOD_CONFIG_PATH)) !== text) {
              throw conflict("error.migrate.config_changed", {
                reason: "config_changed",
                path: METHOD_CONFIG_PATH,
              });
            }
            const found = recordedMigration(await project(current), toEngine, machine);
            if (found instanceof AgentPluggedError) throw found;
            if (found !== undefined) throw new AlreadyRecorded(found.id);
          },
        },
      );
      event = "written";
      eventId = written?.id;
    } catch (error) {
      if (error instanceof AlreadyRecorded) {
        event = "already";
        eventId = error.eventId;
      } else if (!isNotARepository(error)) throw error;
    }
  }
  try {
    // The other files first, `method.yaml` last: stopped in between, the format stays the old one
    // and `migrate` runs again (the method's own copies are recognised, no second event).
    for (const operation of operations) {
      if (operation.action === "remove") {
        if (await files.exists(operation.path)) await files.remove(operation.path);
      } else if (typeof operation.content === "string") {
        await files.writeText(operation.path, operation.content);
      } else if (operation.content !== undefined) {
        await files.writeBytes(operation.path, operation.content);
      }
    }
    await files.writeText(METHOD_CONFIG_PATH, migrated);
  } catch (error) {
    // Recorded, not written: running `migrate` again writes it, without a second event.
    const reason = error instanceof Error ? error.message : String(error);
    return fail(
      eventId === undefined
        ? new AgentPluggedError(ErrorCode.UNEXPECTED, "error.migrate.write_failed.no_event", {
            path: METHOD_CONFIG_PATH,
            reason,
          })
        : new AgentPluggedError(ErrorCode.UNEXPECTED, "error.migrate.write_failed", {
            path: METHOD_CONFIG_PATH,
            event_id: eventId,
            reason,
          }),
    );
  }
  return ok({
    status: "migrated",
    ...summary,
    event,
    ...(eventId === undefined ? {} : { event_id: eventId }),
    ...added,
    ...changes,
  });
}
