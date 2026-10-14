import { deviceIdMatchesKey, fromBase64url } from "@agentplugged/crypto";
import { type RootPin, RootPinSchema } from "@agentplugged/protocol";

/**
 * The root of trust of a product, pinned on this machine outside the repository:
 * written once by `agentplugged pair`, before any `device.paired`
 * and any product key is sent, read by every projection that decides who is trusted. The file is
 * the machine's, not the journal's: a journal that says another thing is signalled
 * (`SECURITY_ROOT_CHANGED`), never believed.
 */
export interface RootPinStore {
  /** The pin of `product`, or undefined when this machine pinned none. */
  read(product: string): Promise<RootPin | undefined>;
  /** Pins (or replaces) the root of `product`. */
  write(product: string, pin: RootPin): Promise<void>;
}

/** The pin a text holds, or undefined when it is not a pin whose identifier is its key's. */
export function parseRootPin(text: string): RootPin | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = RootPinSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const key = fromBase64url(parsed.data.public_key);
  if (key === undefined || !deviceIdMatchesKey(parsed.data.device, key)) return undefined;
  return parsed.data;
}

/** The text a pin is stored as. */
export function rootPinText(pin: RootPin): string {
  return `${JSON.stringify({ device: pin.device, public_key: pin.public_key }, null, 2)}\n`;
}

/** `RootPinStore` in memory: tests. */
export class MemoryRootPinStore implements RootPinStore {
  readonly pins = new Map<string, RootPin>();

  async read(product: string): Promise<RootPin | undefined> {
    return this.pins.get(product);
  }

  async write(product: string, pin: RootPin): Promise<void> {
    this.pins.set(product, pin);
  }
}
