import {
  encryptedFileKeyId,
  encryptFile,
  exportedKeyInfo,
  exportProductKey,
  importProductKey,
  productKeyProof,
} from "@agentplugged/crypto";
import {
  ErrorCode,
  MIN_PASSPHRASE_LENGTH,
  PRODUCT_KEY_EVENT_TYPES,
  SENSITIVE_AREAS,
  type SensitiveArea,
} from "@agentplugged/protocol";
import { explicitConfirmed } from "../checkpoints/resolution-rules.js";
import type { CommandContext, CommandResult, HumanAccess } from "../command.js";
import { fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH, METHOD_DIR } from "../init/layout.js";
import { loadMethodConfig, productOf } from "../init/method-config.js";
import {
  type AnnouncedKey,
  announcedKey,
  backupProductKey,
  checkAnnounced,
  createProductKey,
  forgetProductKey,
  type ProductKey,
  productKeyMismatch,
  productKeyMissing,
  productKeyOf,
  readHeldProductKey,
  readProductKey,
  storeProductKey,
} from "../journal/product-key.js";
import type { JournalListing, StateStore } from "../journal/state-store.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import { checkSensitivePath, fileBinding } from "../sensitive/sensitive-files.js";

/**
 * The product key at `init`, and the creator's `key export`, `key import` and `key seal` (story
 * 2.13). The key itself is never shown, logged nor returned: only its `key_id`, and its export
 * under a passphrase (`apk1:…`), which is useless without that passphrase.
 */

function reasonOf(error: unknown): string {
  if (error instanceof AgentPluggedError) return String(error.details.reason ?? error.code);
  return error instanceof Error ? error.message : String(error);
}

// --- init -------------------------------------------------------------------------------------

/** What `init` did with the product key. */
export interface InitProductKey {
  /**
   * `created`: created now on this machine; `ready`: held already; `missing`: the journal names a
   * key this machine does not hold (import it); `mismatch`: this machine holds another key than
   * the journal's; `sync_first`: the remote's journal is not here yet (or the remote did not
   * answer): `journal sync`, then `init`; `failed`: the journal could not be read, no key created;
   * `keychain_unavailable`: the system keychain could not be used; `keychain_full`: it refused
   * the new key, being full (`KEYCHAIN_FULL`).
   */
  readonly status:
    | "created"
    | "ready"
    | "missing"
    | "mismatch"
    | "sync_first"
    | "failed"
    | "keychain_unavailable"
    | "keychain_full";
  /** The key this machine holds, when it holds one. */
  readonly key_id?: string;
  /** The key the journal announces, when it announces one. */
  readonly journal_key_id?: string;
  /** The remote `sync_first` names. */
  readonly remote?: string;
  /**
   * `written`: `product.key_created` was written now; `already`: the journal announces it;
   * `no_repo`: no Git repository yet (written by a later `init`); `failed`: the journal could not
   * be written (`publishReason`).
   */
  readonly published?: "written" | "already" | "no_repo" | "failed";
  readonly publishReason?: string;
}

/** Thrown by the precondition: another process announced a key meanwhile. */
class AlreadyAnnounced extends Error {
  constructor(readonly keyId: string) {
    super("the journal announces a product key already");
  }
}

/**
 * The product key at `init`: on the product's first `init`, 32 random bytes created under the
 * lock of key creation, stored in the keychain, and announced in the journal by
 * `product.key_created` (`{ key_id, proof }`), signed by the machine key. None is created when
 * the journal cannot be read (`failed`), when it announces a key (`missing`, `mismatch`), or when
 * the remote's journal is not here yet or the remote does not answer (`sync_first`). Never fails
 * `init`.
 */
export async function installProductKey(
  context: CommandContext,
  product: string,
): Promise<InitProductKey | undefined> {
  const keys = context.keys ?? context.human?.keys;
  if (keys === undefined) return undefined;
  const journal = context.journal;
  let listing: JournalListing | undefined;
  let stored: ProductKey | undefined;
  try {
    stored = await readProductKey(keys, product);
  } catch (error) {
    return { status: "keychain_unavailable", publishReason: reasonOf(error) };
  }
  try {
    let announced: AnnouncedKey | null = null;
    let repository = journal !== undefined;
    if (journal !== undefined) {
      try {
        listing = await journal.list();
      } catch (error) {
        if (!(error instanceof AgentPluggedError && error.code === ErrorCode.NOT_A_GIT_REPO)) {
          return { status: "failed", publishReason: reasonOf(error) };
        }
        repository = false;
      }
      if (listing !== undefined) {
        announced = await announcedKey(listing.events, {
          product,
          problems: listing.problems,
          allowTestTypes: context.allowTestTypes === true,
          ...(stored === undefined ? {} : { productKey: stored }),
        });
      }
    }
    if (announced !== null) {
      if (stored === undefined) return { status: "missing", journal_key_id: announced.key_id };
      if (stored.keyId !== announced.key_id) {
        return { status: "mismatch", key_id: stored.keyId, journal_key_id: announced.key_id };
      }
      return { status: "ready", key_id: stored.keyId, published: "already" };
    }
    // A clone that has not synced the remote's journal yet would create a second key.
    if (repository && journal?.remoteJournalStatus !== undefined) {
      const remote = await journal.remoteJournalStatus();
      if (remote.kind === "behind" || remote.kind === "unreachable") {
        return {
          status: "sync_first",
          remote: remote.remote,
          ...(stored === undefined ? {} : { key_id: stored.keyId }),
        };
      }
    }
    let key: ProductKey;
    let created: boolean;
    try {
      const lock = context.human?.lock;
      ({ key, created } = await createProductKey(
        keys,
        product,
        lock === undefined ? {} : { lock },
      ));
    } catch (error) {
      const full = error instanceof AgentPluggedError && error.code === ErrorCode.KEYCHAIN_FULL;
      return {
        status: full ? "keychain_full" : "keychain_unavailable",
        publishReason: reasonOf(error),
      };
    }
    const status = created ? "created" : "ready";
    if (journal === undefined || !repository) {
      await forgetProductKey(key);
      return { status, key_id: key.keyId, published: "no_repo" };
    }
    try {
      await journal.appendAll(
        [
          {
            type: PRODUCT_KEY_EVENT_TYPES.keyCreated,
            actor: { kind: "system" },
            product,
            provenance: "trusted",
            payload: { key_id: key.keyId, proof: await productKeyProof(key.key, product) },
          },
        ],
        {
          // Announced once: another process (or machine, after a sync) may have done it meanwhile.
          precondition: async (current) => {
            const other = await announcedKey(current.events, {
              product,
              problems: current.problems,
              productKey: key,
              allowTestTypes: context.allowTestTypes === true,
            });
            if (other !== null) throw new AlreadyAnnounced(other.key_id);
          },
        },
      );
      return { status, key_id: key.keyId, published: "written" };
    } catch (error) {
      if (error instanceof AlreadyAnnounced) {
        if (error.keyId === key.keyId) return { status, key_id: key.keyId, published: "already" };
        return { status: "mismatch", key_id: key.keyId, journal_key_id: error.keyId };
      }
      return { status, key_id: key.keyId, published: "failed", publishReason: reasonOf(error) };
    } finally {
      await forgetProductKey(key);
    }
  } finally {
    await forgetProductKey(stored);
  }
}

// --- key export / key import / key seal -------------------------------------------------------

/** What `key export` gives: the key exported under the passphrase, and its `key_id`. */
export interface KeyExportResult {
  readonly action: "export";
  readonly key_id: string;
  /** `apk1:…`: the key encrypted under the passphrase (Argon2id, XChaCha20-Poly1305). */
  readonly exported: string;
}

/** What `key import` did: the key stored now (the one replaced kept aside), or held already. */
export interface KeyImportResult {
  readonly action: "import";
  readonly key_id: string;
  readonly status: "imported" | "already";
  /** The key replaced, kept in the keychain under `product:<id>:previous:<key_id>`. */
  readonly replaced?: string;
}

/** What `key seal` did, file by file. */
export interface KeySealResult {
  readonly action: "seal";
  readonly key_id: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    /** `sealed` now, `already` encrypted, or `skipped` (a name the tools refuse, `reason`). */
    readonly status: "sealed" | "already" | "skipped";
    readonly reason?: string;
  }>;
}

interface KeyTarget {
  readonly product: string;
  readonly journal: StateStore;
  readonly human: HumanAccess & {
    readonly askPassphrase: NonNullable<HumanAccess["askPassphrase"]>;
  };
}

/** What `key export`, `key import` and `key seal` need (the terminal is checked by `keyCommand`). */
async function keyTarget(context: CommandContext): Promise<KeyTarget | AgentPluggedError> {
  if (!(await context.files.exists(METHOD_CONFIG_PATH))) return methodNotInstalled();
  const loaded = await loadMethodConfig(context.files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const journal = context.journal;
  const human = context.human;
  if (journal === undefined || human === undefined || human.askPassphrase === undefined) {
    return new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: "no journal, keychain or terminal is available here",
    });
  }
  const product = await productOf(loaded.config, journal);
  if (product instanceof AgentPluggedError) return product;
  return { product, journal, human: human as KeyTarget["human"] };
}

function passphraseInvalid(reason: "too_short" | "mismatch" | "wrong"): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.PASSPHRASE_INVALID, "error.passphrase_invalid", {
    reason,
    reason_key: `reason.passphrase.${reason}`,
    ...(reason === "too_short" ? { min: MIN_PASSPHRASE_LENGTH } : {}),
  });
}

function exportUnusable(reasonKey: "not_exported" | "export_damaged"): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "key",
    field: "key",
    reason:
      reasonKey === "not_exported"
        ? "key import: not an exported product key (apk1:…)"
        : "key import: the exported key is damaged or of an unknown format",
    reason_key: `reason.key.${reasonKey}`,
  });
}

/** The key the journal of `target` announces, as `holding` (when given) sees it. */
async function journalKey(
  context: CommandContext,
  target: KeyTarget,
  holding?: ProductKey,
): Promise<AnnouncedKey | null> {
  const listing = await target.journal.list();
  return announcedKey(listing.events, {
    product: target.product,
    problems: listing.problems,
    allowTestTypes: context.allowTestTypes === true,
    ...(holding === undefined ? {} : { productKey: holding }),
  });
}

/**
 * `key export [--out <file>]`: the product key this machine holds, encrypted under a passphrase
 * asked twice (at least 12 characters), derived by Argon2id (`MODERATE`), bound to the product.
 * Without the key: `PRODUCT_KEY_MISSING`; a key the journal does not announce:
 * `PRODUCT_KEY_MISMATCH`; a short passphrase or two different entries: `PASSPHRASE_INVALID`.
 */
export async function exportKey(context: CommandContext): Promise<CommandResult<KeyExportResult>> {
  const target = await keyTarget(context);
  if (target instanceof AgentPluggedError) return fail(target);
  let key: ProductKey | undefined;
  try {
    key = await readHeldProductKey(target.human.keys, target.product);
    if (key === undefined) {
      return fail(productKeyMissing(target.product, (await journalKey(context, target))?.key_id));
    }
    checkAnnounced(await journalKey(context, target, key), key);
    const passphrase = await target.human.askPassphrase("new");
    if ([...passphrase].length < MIN_PASSPHRASE_LENGTH) return fail(passphraseInvalid("too_short"));
    const again = await target.human.askPassphrase("again");
    if (again !== passphrase) return fail(passphraseInvalid("mismatch"));
    const exported = await exportProductKey(key.key, target.product, passphrase, {
      limits: target.human.passphraseLimits ?? "moderate",
    });
    return ok({ action: "export", key_id: key.keyId, exported });
  } catch (error) {
    if (error instanceof AgentPluggedError) return fail(error);
    throw error;
  } finally {
    await forgetProductKey(key);
  }
}

/**
 * `key import [--in <file>]`: the export (from the file, else asked without echo: never on the
 * command line) must be of this product and of the key the journal announces, checked before the
 * passphrase is asked; the journal must announce one (`journal sync` first). After decryption,
 * the key must verify the announcement's proof. A different key held here is replaced only once
 * the creator types « je confirme », and kept under `product:<id>:previous:<key_id>`.
 */
export async function importKey(
  context: CommandContext,
  input: Readonly<Record<string, unknown>>,
): Promise<CommandResult<KeyImportResult>> {
  const target = await keyTarget(context);
  if (target instanceof AgentPluggedError) return fail(target);
  let held: ProductKey | undefined;
  let candidate: ProductKey | undefined;
  try {
    const text =
      typeof input.text === "string" ? input.text : await target.human.askPassphrase("export");
    const info = exportedKeyInfo(text);
    if (info === undefined) return fail(exportUnusable("not_exported"));
    if (info.productId !== target.product) {
      return fail(
        new AgentPluggedError(ErrorCode.PRODUCT_KEY_MISMATCH, "error.product_key_other_product", {
          product: target.product,
          export_product: info.productId,
        }),
      );
    }
    held = await readHeldProductKey(target.human.keys, target.product);
    const announced = await journalKey(context, target, held);
    if (announced === null) {
      return fail(
        new AgentPluggedError(ErrorCode.PRODUCT_KEY_MISSING, "error.product_key_not_announced", {
          product: target.product,
        }),
      );
    }
    if (announced.key_id !== info.keyId)
      return fail(productKeyMismatch(announced.key_id, info.keyId));
    if (held?.keyId === info.keyId) {
      return ok({ action: "import", key_id: info.keyId, status: "already" });
    }
    const passphrase = await target.human.askPassphrase("enter");
    const imported = await importProductKey(text, passphrase, {
      limits: target.human.passphraseLimits ?? "moderate",
    });
    if (!imported.ok) {
      return fail(
        imported.reason === "passphrase"
          ? passphraseInvalid("wrong")
          : exportUnusable("export_damaged"),
      );
    }
    candidate = await productKeyOf(imported.key);
    // The key must prove the announcement: a forged one (another key, its proof) is refused.
    const proven = await journalKey(context, target, candidate);
    if (proven?.key_id !== candidate.keyId) {
      return fail(
        new AgentPluggedError(ErrorCode.PRODUCT_KEY_MISMATCH, "error.product_key_proof_invalid", {
          journal_key_id: proven?.key_id ?? announced.key_id,
          held_key_id: candidate.keyId,
        }),
      );
    }
    if (held !== undefined) {
      const ask = target.human.askConfirmation;
      const answer =
        ask === undefined
          ? ""
          : await ask({
              kind: "replace_product_key",
              held_key_id: held.keyId,
              key_id: candidate.keyId,
            });
      if (!explicitConfirmed(answer, "je confirme")) {
        return fail(new AgentPluggedError(ErrorCode.CANCELLED, "error.cancelled"));
      }
      await backupProductKey(target.human.keys, target.product, held);
    }
    await storeProductKey(target.human.keys, target.product, candidate);
    return ok({
      action: "import",
      key_id: candidate.keyId,
      status: "imported",
      ...(held === undefined ? {} : { replaced: held.keyId }),
    });
  } catch (error) {
    if (error instanceof AgentPluggedError) return fail(error);
    throw error;
  } finally {
    await forgetProductKey(held, candidate);
  }
}

/**
 * `key seal`: encrypts the files of `.agentplugged/salle/` and `.agentplugged/memory/` still in
 * clear (written by hand, or), each bound to its product and path; `.gitkeep`
 * and files encrypted already are left as they are; a name the tools refuse is skipped, said so.
 */
export async function sealFiles(context: CommandContext): Promise<CommandResult<KeySealResult>> {
  const target = await keyTarget(context);
  if (target instanceof AgentPluggedError) return fail(target);
  let key: ProductKey | undefined;
  try {
    key = await readHeldProductKey(target.human.keys, target.product);
    if (key === undefined) return fail(productKeyMissing(target.product));
    checkAnnounced(await journalKey(context, target, key), key);
    const files: Array<KeySealResult["files"][number]> = [];
    for (const area of SENSITIVE_AREAS as readonly SensitiveArea[]) {
      const prefix = `${METHOD_DIR}/${area}/`;
      for (const path of await context.files.listFiles(`${METHOD_DIR}/${area}`)) {
        const relative = path.slice(prefix.length);
        if (relative === ".gitkeep") continue;
        const refused = await checkSensitivePath(context.files, "key seal", area, relative);
        if (refused !== undefined) {
          files.push({ path, status: "skipped", reason: String(refused.details.reason ?? "") });
          continue;
        }
        const text = await context.files.readText(path);
        if (encryptedFileKeyId(text) !== undefined) {
          files.push({ path, status: "already" });
          continue;
        }
        const sealed = await encryptFile(
          text,
          fileBinding(target.product, area, relative),
          key.key,
        );
        await context.files.writeText(path, sealed);
        files.push({ path, status: "sealed" });
      }
    }
    return ok({ action: "seal", key_id: key.keyId, files });
  } catch (error) {
    if (error instanceof AgentPluggedError) return fail(error);
    throw error;
  } finally {
    await forgetProductKey(key);
  }
}
