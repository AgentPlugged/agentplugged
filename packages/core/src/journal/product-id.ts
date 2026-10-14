import { isMap, isScalar, parseDocument } from "yaml";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import {
  loadMethodConfig,
  parseMethodConfig,
  stringifyMethodDocument,
} from "../init/method-config.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { productIdMismatch } from "./prepare-event.js";
import type { StateStore } from "./state-store.js";
import type { UlidFactory } from "./ulid.js";

/**
 * Writes `product_id` into the text of `method.yaml`, right after `engine_version`, keeping
 * comments, other keys and line endings.
 */
export function writeProductId(text: string, productId: string): string | AgentPluggedError {
  const document = parseDocument(text);
  const map = document.contents;
  const keyIndex = (name: string) =>
    isMap(map) ? map.items.findIndex((pair) => isScalar(pair.key) && pair.key.value === name) : -1;
  if (isMap(map) && keyIndex("product_id") === -1) {
    const after = keyIndex("engine_version");
    const pair = document.createPair("product_id", productId);
    (map.items as unknown[]).splice(after === -1 ? map.items.length : after + 1, 0, pair);
  } else document.set("product_id", productId);
  const output = stringifyMethodDocument(document, text);
  const checked = parseMethodConfig(output);
  return checked instanceof AgentPluggedError ? checked : output;
}

export interface ProductIdResult {
  readonly productId: string;
  /** True when `method.yaml` had none and this call added it: the caller tells the creator. */
  readonly added: boolean;
}

/**
 * The product id the journal holds, or null when it holds none or cannot be read (no Git
 * repository, no `git`): the journal itself checks the id again on every write.
 */
export async function readJournalProductId(
  journal: StateStore | undefined,
): Promise<string | null> {
  if (journal === undefined) return null;
  try {
    return await journal.productId();
  } catch {
    return null;
  }
}

/**
 * The product's `product_id` from `method.yaml`, which must exist. The journal is the authority:
 * a file without one adopts the journal's (a new ULID when the journal holds none yet), written
 * with comments and line endings kept, and `added` is true; a different one gives
 * `PRODUCT_ID_MISMATCH`, naming the journal's.
 */
export async function ensureProductId(
  files: WorkspaceFiles,
  newId: UlidFactory,
  journal?: StateStore,
): Promise<ProductIdResult | AgentPluggedError> {
  const loaded = await loadMethodConfig(files);
  if (loaded instanceof AgentPluggedError) return loaded;
  const held = await readJournalProductId(journal);
  const own = loaded.config.product_id;
  if (own !== undefined) {
    if (held !== null && held !== own) return productIdMismatch(own, held);
    return { productId: own, added: false };
  }
  const productId = held ?? newId();
  const text = writeProductId(loaded.text, productId);
  if (text instanceof AgentPluggedError) return text;
  await files.writeText(METHOD_CONFIG_PATH, text);
  return { productId, added: true };
}
