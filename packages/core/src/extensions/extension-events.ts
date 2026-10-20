import {
  ErrorCode,
  EXTENSION_MODULE_PATTERN,
  extensionModuleOf,
  isExtensionEventType,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import type { KeyStore } from "../journal/key-store.js";
import { journalProduct } from "../journal/prepare-event.js";
import { forgetProductKey, projectionKey } from "../journal/product-key.js";
import type { StateStore } from "../journal/state-store.js";
import {
  computeProjectionDetailed,
  type ExtensionEvent,
} from "../projection/compute-projection.js";

/**
 * The extension point of the journal, for a program built on the engine: it writes events of a
 * module (`x.<module>.<type>`) and reads them back. The events are signed, chained and encrypted
 * with the product key like any sensitive content; an engine that does not know the module keeps
 * them in the journal and applies them to nothing.
 */

function invalid(field: string, reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "extension",
    field,
    reason,
  });
}

export interface ExtensionWrite {
  /** The product the event belongs to. */
  readonly product: string;
  /** `x.<module>.<type>`. */
  readonly type: string;
  /** Who writes: the system (a program of the engine's own) or an agent acting for the creator. */
  readonly actor: { readonly kind: "system" } | { readonly kind: "agent"; readonly agent: string };
  readonly payload: Record<string, unknown>;
  readonly story?: string;
}

/**
 * Writes one event of an extension module in the journal. Never in the creator's name: an
 * extension event is the module's, written by the system or by an agent.
 */
export async function appendExtensionEvent(
  journal: StateStore,
  write: ExtensionWrite,
): Promise<{ readonly id: string; readonly type: string; readonly at: string }> {
  if (!isExtensionEventType(write.type)) {
    throw invalid("type", "expected `x.<module>.<type>`, lowercase");
  }
  const event = await journal.append({
    type: write.type,
    product: write.product,
    actor: write.actor,
    provenance: "trusted",
    payload: write.payload,
    ...(write.story === undefined ? {} : { story: write.story }),
  });
  return { id: event.id, type: event.type, at: event.at };
}

export interface ExtensionRead {
  /** Only the events of this module. */
  readonly module?: string;
  /** The keychain that holds the product key: without it the events stay unreadable. */
  readonly keys?: KeyStore;
  readonly product?: string;
}

export interface ExtensionReadResult {
  /** Valid events readable on this machine, in the order of the journal's projection. */
  readonly events: readonly ExtensionEvent[];
  /** Encrypted events applied without their content (no product key here, or another one). */
  readonly unreadable: number;
}

/** The events of an extension module (or of all), read from the journal. */
export async function readExtensionEvents(
  journal: StateStore,
  options: ExtensionRead = {},
): Promise<ExtensionReadResult> {
  if (options.module !== undefined && !EXTENSION_MODULE_PATTERN.test(options.module)) {
    throw invalid("module", "expected lowercase letters, digits and underscores");
  }
  const listing = await journal.list();
  const product = options.product ?? journalProduct(listing.events)?.product;
  const access = await projectionKey(
    options.keys === undefined ? {} : { keys: options.keys },
    product,
    { events: listing.events, problems: listing.problems, allowTestTypes: false },
  );
  try {
    const detailed = await computeProjectionDetailed(listing.events, {
      problems: listing.problems,
      head: listing.head,
      ...(product === undefined ? {} : { product }),
      ...(access.key === undefined ? {} : { productKey: access.key }),
    });
    const events =
      options.module === undefined
        ? detailed.extensionEvents
        : detailed.extensionEvents.filter(
            (event) => extensionModuleOf(event.type) === options.module,
          );
    return { events, unreadable: detailed.unreadable };
  } finally {
    await forgetProductKey(access.key);
  }
}
