import { canonicalBytes, fromUtf8 } from "@agentplugged/crypto";
import type { ProjectionState, SensitiveUnreadableWarning } from "@agentplugged/protocol";
import { METHOD_DIR } from "../init/layout.js";
import type { KeyStore } from "../journal/key-store.js";
import { journalProduct } from "../journal/prepare-event.js";
import { forgetProductKey, projectionKey } from "../journal/product-key.js";
import type { StateStore } from "../journal/state-store.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { computeProjectionDetailed } from "./compute-projection.js";

/** The projection's cache: never versioned (`.agentplugged/.gitignore`), never read as a source. */
export const STATE_CACHE_PATH = `${METHOD_DIR}/.cache/state.json`;

/**
 * A warning of this machine only, never written to `state.json` (two synced clones write the
 * same bytes): the journal no longer descends from the last position projected here, or lost
 * events projected then. `unknown` when that position cannot be read any more (no count).
 */
export interface HistoryRewrittenWarning {
  readonly code: "history_rewritten";
  readonly missing: number;
  readonly unknown: boolean;
}

/** What became of `state.json`: written, already those bytes, or no method installed here. */
export type StateFileStatus = "written" | "unchanged" | "not_installed";

/**
 * A warning of this machine only, never written to `state.json`: the system keychain
 * could not be read, so the sensitive content was not decrypted here.
 */
export interface KeychainUnavailableWarning {
  readonly code: "keychain_unavailable";
  readonly reason: string;
}

/** Warnings of this machine only: in a command's result, never in `state.json`. */
export type LocalWarning =
  | HistoryRewrittenWarning
  | SensitiveUnreadableWarning
  | KeychainUnavailableWarning;

export interface ProjectStateResult {
  /**
   * The state of the product, with the sensitive content this machine can decrypt (costs…):
   * computed in memory, for the command's output. `state.json` holds the projection without it.
   */
  readonly state: ProjectionState;
  readonly file: StateFileStatus;
  /** Warnings of this machine only (not in `state.json`). */
  readonly warnings: readonly LocalWarning[];
}

export interface ProjectStateOptions {
  /** The `product_id` of `method.yaml`, when it has one: the product the journal must hold. */
  readonly productId?: string;
  /** Applies the types reserved to tests (`test.*`): tests only. */
  readonly allowTestTypes?: boolean;
  /**
   * The keychain holding the product key: the sensitive content is decrypted when
   * this machine holds the key of the journal's product, and left out otherwise.
   */
  readonly keys?: KeyStore;
}

/** The bytes of `state.json`: canonical JSON (RFC 8785), then `\n`. */
export function stateFile(state: ProjectionState): string {
  return `${fromUtf8(canonicalBytes(state))}\n`;
}

async function readText(files: WorkspaceFiles, path: string): Promise<string | undefined> {
  try {
    return (await files.exists(path)) ? await files.readText(path) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The state of the product, always computed again from the whole journal (one `list()`): the
 * existing `state.json` is never read as a source, only compared to the new bytes, so it is
 * written only when they differ, and only where the method is installed (`.agentplugged/`
 * exists). When the journal no longer descends from the last position projected here
 * (`refs/agentplugged/projected`), or lost events projected then, the result carries the
 * machine-local `history_rewritten` warning. The position projected is then recorded (cleared
 * for an empty journal). A type or a version this engine does not know, signed by a registered
 * device, throws `UPGRADE_REQUIRED` before anything is written.
 */
export async function projectState(
  journal: StateStore,
  files: WorkspaceFiles,
  options: ProjectStateOptions = {},
): Promise<ProjectStateResult> {
  const listing = await journal.list();
  const head = listing.head;
  const base = {
    problems: listing.problems,
    head,
    ...(options.productId === undefined ? {} : { product: options.productId }),
    allowTestTypes: options.allowTestTypes === true,
  };
  // `state.json` never holds decrypted content: it is the projection without the product key.
  const written = await computeProjectionDetailed(listing.events, base);
  const access = await projectionKey(
    options.keys === undefined ? {} : { keys: options.keys },
    options.productId ?? journalProduct(listing.events)?.product,
  );
  let shown = written;
  if (access.key !== undefined) {
    try {
      shown = await computeProjectionDetailed(listing.events, { ...base, productKey: access.key });
    } finally {
      await forgetProductKey(access.key);
    }
  }
  const state = shown.projection;

  const projected = await journal.projected();
  const warnings: LocalWarning[] = [];
  if (access.keychainError !== undefined) {
    warnings.push({ code: "keychain_unavailable", reason: access.keychainError });
  }
  if (shown.unreadable > 0)
    warnings.push({ code: "sensitive_unreadable", count: shown.unreadable });
  if (projected !== null && projected !== head) {
    const history = await journal.history(projected, head);
    const unknown = history.unknown === true;
    if (unknown || !history.descends || history.missing > 0) {
      warnings.push({ code: "history_rewritten", missing: history.missing, unknown });
    }
  }

  let file: StateFileStatus = "not_installed";
  if (await files.exists(METHOD_DIR)) {
    const bytes = stateFile(written.projection);
    if ((await readText(files, STATE_CACHE_PATH)) === bytes) file = "unchanged";
    else {
      await files.writeText(STATE_CACHE_PATH, bytes);
      file = "written";
    }
  }
  if (head !== projected) await journal.markProjected(head, projected);
  return { state, file, warnings };
}
