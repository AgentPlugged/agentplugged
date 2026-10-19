import {
  type LinkRequest,
  LinkWelcomeSchema,
  linkWelcomeRecord,
  PAIR_ERROR_CODES,
  PAIR_MESSAGE_TYPES,
  type PairErrorCode,
  type ProductKeys,
  ProductKeysSchema,
  rootCertifiedRecord,
  TRUST_SIGNATURE_TAGS,
} from "@agentplugged/protocol";
import { type BrowserDeviceKeys, browserAgreement } from "./browser-keys.js";
import { generateEd25519 } from "./ed25519.js";
import { fromBase64url, toBase64url, utf8 } from "./encoding.js";
import { sha256 } from "./hash.js";
import {
  decodePairWire,
  encodePairWire,
  type PairLink,
  type PairLinkKind,
  pairLinkRootDevice,
  sealPairBox,
} from "./pairing.js";
import { openPeerMessage } from "./peer-message.js";
import { deviceIdOf, generateX25519, type X25519KeyPair } from "./primitives.js";
import { SequenceWindow } from "./sequence-window.js";
import { signTrustRecord, trustRecordBytes, verifyTrustRecord } from "./trust-signature.js";

/**
 * The part of a pairing that the new device plays (a phone that scanned a code, a browser that
 * opened a link): it sends its request in a box drawn from the link's secret, and counts itself
 * linked only on a welcome the bridge signed, checked against the bridge key read in the link
 * (which the relay never saw). It does no network and no storage: the host app feeds it the
 * messages of the rendezvous and keeps what it returns.
 */

export type JoinerKind = "phone" | "browser" | "machine";

/**
 * What a joiner is anchored to: the rendezvous, the key that opens its request, and the bridge key
 * and root it verifies the welcome against. A scanned or opened link is one; for a machine joining
 * with a short code, the secret is the session key of the password exchange and the keys are the
 * ones the bridge named in its hello.
 */
export interface JoinerLink extends Omit<PairLink, "kind"> {
  readonly kind: PairLinkKind | "machine";
}

/** The keys of a new device. The secret keys never leave the device that made them. */
export interface JoinerKeys {
  readonly kind: JoinerKind;
  readonly device: string;
  readonly sigPublicKey: Uint8Array;
  /** 64 bytes (libsodium format). */
  readonly sigSecretKey: Uint8Array;
  readonly encryption: X25519KeyPair;
}

/** New signing and encryption keys for a device of `kind`. */
export async function createJoinerKeys(kind: JoinerKind): Promise<JoinerKeys> {
  const signing = await generateEd25519();
  return {
    kind,
    device: deviceIdOf(kind, signing.publicKey),
    sigPublicKey: signing.publicKey,
    sigSecretKey: signing.secretKey,
    encryption: await generateX25519(),
  };
}

/** What the joiner holds once the bridge's welcome verified. */
export interface JoinerPins {
  readonly root: { readonly device: string; readonly key: string };
  readonly bridge: {
    readonly device: string;
    readonly sig: string;
    readonly enc: string;
    /** The identifier the relay knows the bridge by, when the welcome named it. */
    readonly relayDevice?: string;
  };
  readonly registry: ReadonlyArray<{
    readonly product: string;
    readonly head: string;
    readonly root: { readonly device: string; readonly key: string };
  }>;
}

/** What a message of the rendezvous did. */
export type JoinerEvent =
  | { readonly type: "linked"; readonly pins: JoinerPins }
  | { readonly type: "product_keys"; readonly keys: ProductKeys }
  /** The bridge said no (unsigned: anyone on the path can write such a message; informative only). */
  | { readonly type: "refused"; readonly code: PairErrorCode }
  /** A message that claims to come from the bridge does not verify against the code that was scanned. */
  | { readonly type: "rejected"; readonly code: PairErrorCode; readonly reason: string }
  | { readonly type: "ignored"; readonly reason: string };

export interface JoinerOptions {
  readonly link: JoinerLink;
  /** A device with readable keys (a phone), or a browser whose private keys cannot be read out. */
  readonly keys: JoinerKeys | BrowserDeviceKeys;
  /** The account the device is signed in to, as the relay knows it. */
  readonly account: string;
  /** What the device says it is (« declared »: shown to the creator as such, never believed). */
  readonly declared: { readonly type: string; readonly os: string };
  /** A machine only: what it serves and the attachment it signed (see the request). */
  readonly machine?: LinkRequest["machine"];
  /** The device's signature recognising the link's root (see `rootCertificationBytes`). */
  readonly rootCertification?: LinkRequest["root_certification"];
}

function certificationRecord(link: Pick<PairLink, "root">, issuedAt: string) {
  return rootCertifiedRecord({
    root: { device: pairLinkRootDevice(link), key: toBase64url(link.root.key) },
    issued_at: issuedAt,
  });
}

/**
 * The bytes a device signs to recognise the creator's key that a link carries as its root: the
 * signature the bridge writes as `device.root_certified`. Undefined when the link's root is not a
 * creator's key (a machine root has nothing to certify).
 */
export function rootCertificationBytes(
  link: Pick<PairLink, "root">,
  issuedAt: string,
): Uint8Array | undefined {
  if (link.root.kind !== "human") return undefined;
  return trustRecordBytes(certificationRecord(link, issuedAt), TRUST_SIGNATURE_TAGS.rootCertified);
}

/** The certification of a device whose secret key can be read (a phone, a machine). */
export async function signRootCertification(
  link: Pick<PairLink, "root">,
  secretKey: Uint8Array,
  issuedAt: string,
): Promise<NonNullable<LinkRequest["root_certification"]> | undefined> {
  if (link.root.kind !== "human") return undefined;
  const sig = await signTrustRecord(
    certificationRecord(link, issuedAt),
    TRUST_SIGNATURE_TAGS.rootCertified,
    secretKey,
  );
  return { issued_at: issuedAt, sig };
}

export class PairingJoiner {
  readonly #link: JoinerLink;
  readonly #keys: JoinerKeys | BrowserDeviceKeys;
  readonly #account: string;
  readonly #declared: { type: string; os: string };
  readonly #machine: LinkRequest["machine"];
  readonly #certification: LinkRequest["root_certification"];
  readonly #window = new SequenceWindow();
  #requestBytes: Uint8Array | undefined;
  #pins: JoinerPins | undefined;

  constructor(options: JoinerOptions) {
    this.#link = options.link;
    this.#keys = options.keys;
    this.#account = options.account;
    this.#declared = { type: options.declared.type, os: options.declared.os };
    this.#machine = options.machine;
    this.#certification = options.rootCertification;
    // A phone answers a phone code, a machine a short code and a browser a link, never the other way round.
    const expected =
      options.link.kind === "phone"
        ? "phone"
        : options.link.kind === "machine"
          ? "machine"
          : "browser";
    if (options.keys.kind !== expected)
      throw new TypeError("This code is for another kind of device.");
  }

  /** The pins, once a welcome verified. */
  get pins(): JoinerPins | undefined {
    return this.#pins;
  }

  get linked(): boolean {
    return this.#pins !== undefined;
  }

  /** The request, as the bridge reads it once opened. */
  request(): LinkRequest {
    return {
      t: PAIR_MESSAGE_TYPES.request,
      account: this.#account,
      browser: {
        device: this.#keys.device,
        sig: { alg: "ed25519", key: toBase64url(this.#keys.sigPublicKey) },
        enc: { alg: "x25519", key: toBase64url(this.#keys.encryption.publicKey) },
      },
      declared: this.#declared,
      ...(this.#certification === undefined ? {} : { root_certification: this.#certification }),
      ...(this.#machine === undefined ? {} : { machine: this.#machine }),
    };
  }

  /** The `data` of the first message of the rendezvous: the request, in a box drawn from `s`. */
  async requestData(): Promise<string> {
    const plaintext = utf8(JSON.stringify(this.request()));
    this.#requestBytes = plaintext;
    const box = await sealPairBox({
      s: this.#link.s,
      x: this.#link.x,
      direction: "up",
      type: PAIR_MESSAGE_TYPES.request,
      plaintext,
    });
    return encodePairWire({ k: "request", nonce: box.nonce, ciphertext: box.ciphertext });
  }

  /**
   * What a message of the bridge does here. It is believed only if it verifies against the link:
   * an unsigned `refused` message is informative (anyone on the path can write one), the rest
   * must be signed by the bridge key of the link and addressed to this device.
   */
  async receive(data: string): Promise<JoinerEvent> {
    const wire = decodePairWire(data);
    if (wire === undefined) return { type: "ignored", reason: "malformed" };
    if (wire.k === "refused") {
      return { type: "refused", code: wire.code };
    }
    if (wire.k !== "envelope") return { type: "ignored", reason: "unexpected" };
    const link = this.#link;
    const bridgeDevice = deviceIdOf("machine", link.bridgeSigKey);
    const opened = await openPeerMessage(wire.envelope, {
      ...("secretKey" in this.#keys.encryption
        ? { recipientSecretKey: this.#keys.encryption.secretKey }
        : { recipientAgreement: browserAgreement(this.#keys.encryption) }),
      // The only source of trust is the code: the bridge key the relay never saw.
      registry: (sender) =>
        sender === bridgeDevice
          ? { signingKey: link.bridgeSigKey, routingId: wire.envelope.from }
          : undefined,
    });
    if (!opened.ok) {
      // A message nobody could read is noise; one from a key the code does not hold is a substitution.
      return opened.reason === "bad_signature" ||
        opened.reason === "unknown_sender" ||
        opened.reason === "sender_mismatch"
        ? rejected(opened.reason)
        : { type: "ignored", reason: opened.reason };
    }
    if (wire.envelope.to !== this.#keys.device)
      return { type: "ignored", reason: "wrong_recipient" };
    if (this.#window.check(opened.seq) !== "accepted") return { type: "ignored", reason: "replay" };
    this.#window.accept(opened.seq);
    if (opened.type === "link.welcome") return this.#welcome(opened.body);
    if (opened.type === "product.keys") return this.#productKeys(opened.body);
    return { type: "ignored", reason: "unknown_type" };
  }

  async #welcome(body: unknown): Promise<JoinerEvent> {
    const parsed = LinkWelcomeSchema.safeParse(body);
    if (!parsed.success) return { type: "ignored", reason: "welcome_shape" };
    const welcome = parsed.data;
    const { sig, ...unsigned } = welcome;
    const link = this.#link;
    const verified = await verifyTrustRecord(
      linkWelcomeRecord(unsigned),
      PAIR_MESSAGE_TYPES.welcome,
      sig,
      link.bridgeSigKey,
    );
    if (!verified) return rejected("welcome_signature");
    if (
      welcome.root.key !== toBase64url(link.root.key) ||
      welcome.root.device !== pairLinkRootDevice(link) ||
      welcome.bridge.sig.key !== toBase64url(link.bridgeSigKey) ||
      welcome.browser !== this.#keys.device
    ) {
      return rejected("welcome_mismatch");
    }
    if (
      this.#requestBytes !== undefined &&
      welcome.request !== toBase64url(sha256(this.#requestBytes))
    ) {
      return rejected("welcome_request");
    }
    this.#pins = {
      root: welcome.root,
      bridge: {
        device: welcome.bridge.device,
        sig: welcome.bridge.sig.key,
        enc: welcome.bridge.enc.key,
        ...(welcome.bridge.relay_device === undefined
          ? {}
          : { relayDevice: welcome.bridge.relay_device }),
      },
      registry: welcome.registry,
    };
    return { type: "linked", pins: this.#pins };
  }

  #productKeys(body: unknown): JoinerEvent {
    // No key is kept before the welcome verified: a product key comes after the link.
    if (this.#pins === undefined) return { type: "ignored", reason: "keys_before_welcome" };
    const parsed = ProductKeysSchema.safeParse(body);
    if (!parsed.success) return { type: "ignored", reason: "keys_shape" };
    if (fromBase64url(parsed.data.key) === undefined)
      return { type: "ignored", reason: "keys_shape" };
    return { type: "product_keys", keys: parsed.data };
  }
}

/** A message that did not verify against the code: the bridge key it carries is not the one scanned. */
function rejected(reason: string): JoinerEvent {
  return { type: "rejected", code: PAIR_ERROR_CODES.PAIRING_KEY_MISMATCH, reason };
}
