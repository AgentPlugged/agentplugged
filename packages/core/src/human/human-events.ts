import {
  canonicalBytes,
  signBytesEd25519,
  signEd25519,
  toBase64url,
  webauthnChallenge,
} from "@agentplugged/crypto";
import {
  type Assurance,
  type CodedErrorPayload,
  currentEvent,
  ErrorCode,
  EVENT_ENVELOPE_VERSION,
  type EventEnvelope,
  HUMAN_DEVICE_PATTERN,
  HUMAN_EVENT_TYPES,
  type HumanPresenceLinkedPayload,
  type PresenceCredential,
  parseEventEnvelope,
  type SignatureAlg,
  type UnsignedEventEnvelope,
} from "@agentplugged/protocol";
import { AgentPluggedError } from "../errors.js";
import { type DeviceHead, hashOf, productIdMismatch } from "../journal/prepare-event.js";
import type { Clock, UlidFactory } from "../journal/ulid.js";
import type { HumanKey } from "./human-key.js";
import type { PresenceAuthenticator } from "./presence.js";

/** How one of the creator's events is signed: by the `locale` key, or the `presence` credential. */
export interface HumanSigner {
  readonly alg: SignatureAlg;
  /** The assurance its signature gives (declared in the envelope, checked by the verifier). */
  readonly assurance: Assurance;
  sign(unsigned: UnsignedEventEnvelope): Promise<EventEnvelope>;
}

/** What the terminal shows just before the system's prompt: what is signed, and its fingerprint. */
export interface PresencePrompt {
  readonly event: UnsignedEventEnvelope;
  /** 8 base64url characters of the WebAuthn challenge (the SHA-256 of the signed bytes). */
  readonly fingerprint: string;
}

/** The short fingerprint of what an event signs: 8 characters of its challenge, in base64url. */
export function fingerprintOf(unsigned: UnsignedEventEnvelope): string {
  return toBase64url(webauthnChallenge(unsigned)).slice(0, 8);
}

/** Signs with the `locale` key (`ed25519`, assurance `locale`). */
export function localeSigner(key: HumanKey): HumanSigner {
  return {
    alg: "ed25519",
    assurance: "locale",
    sign: (unsigned) => signEd25519(unsigned, key.secretKey),
  };
}

/**
 * Signs with the `presence` credential: `beforePrompt` shows what is signed and its fingerprint,
 * then the authenticator asks for the creator's verification (UV). A failed or cancelled
 * assertion gives `CANCELLED` (`error.presence_failed`): nothing is written.
 */
export function presenceSigner(
  authenticator: PresenceAuthenticator,
  credential: PresenceCredential,
  beforePrompt?: (prompt: PresencePrompt) => void | Promise<void>,
): HumanSigner {
  return {
    alg: credential.alg,
    assurance: "presence",
    async sign(unsigned) {
      await beforePrompt?.({ event: unsigned, fingerprint: fingerprintOf(unsigned) });
      try {
        const sig = await authenticator.assert(
          credential.credential_id,
          webauthnChallenge(unsigned),
        );
        return { ...unsigned, sig };
      } catch (error) {
        if (error instanceof AgentPluggedError) throw error;
        throw new AgentPluggedError(ErrorCode.CANCELLED, "error.presence_failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/** `locale_signature` of `human.presence_linked`: the `locale` key signs the credential. */
export async function linkPayload(
  key: HumanKey,
  credential: PresenceCredential,
): Promise<HumanPresenceLinkedPayload> {
  const { credential_id, cose_public_key, alg } = credential;
  const signature = await signBytesEd25519(
    canonicalBytes({ credential_id, cose_public_key, alg }),
    key.secretKey,
  );
  return { credential_id, cose_public_key, alg, locale_signature: toBase64url(signature) };
}

/** One of the creator's events to write, and how it is signed. */
export interface HumanDraft {
  readonly type: string;
  readonly story?: string;
  readonly payload: Record<string, unknown>;
  readonly signer: HumanSigner;
}

function thrown(error: CodedErrorPayload): AgentPluggedError {
  return new AgentPluggedError(error.code, error.message_key, error.details);
}

/**
 * The creator's events, completed (ULID, clock, `prev` on the creator's own chain), and signed
 * one after the other, each by its signer (a `presence` signer prompts). When the creator never
 * wrote to this journal (`deviceHead` null), `human.key_registered`, signed by the `locale` key
 * it publishes, comes first. `actor` is `{ kind: human, device }`, `provenance` trusted, and the
 * `assurance` the one the signer gives.
 */
export async function prepareHumanEvents(input: {
  readonly key: HumanKey;
  readonly drafts: readonly HumanDraft[];
  readonly deviceHead: DeviceHead | null;
  readonly product: string;
  readonly newId: UlidFactory;
  readonly now: Clock;
}): Promise<EventEnvelope[]> {
  const { key } = input;
  const drafts: HumanDraft[] = [...input.drafts];
  if (input.deviceHead === null && drafts[0]?.type !== HUMAN_EVENT_TYPES.keyRegistered) {
    drafts.unshift({
      type: HUMAN_EVENT_TYPES.keyRegistered,
      payload: { public_key: toBase64url(key.publicKey) },
      signer: localeSigner(key),
    });
  }
  const events: EventEnvelope[] = [];
  let head = input.deviceHead;
  for (const draft of drafts) {
    const time = input.now();
    const unsigned: UnsignedEventEnvelope = {
      v: EVENT_ENVELOPE_VERSION,
      id: input.newId(head?.id, time),
      type: draft.type,
      at: new Date(time).toISOString(),
      actor: { kind: "human", device: key.device },
      product: input.product,
      ...(draft.story === undefined ? {} : { story: draft.story }),
      provenance: "trusted",
      prev: head?.hash ?? null,
      payload: draft.payload,
      alg: draft.signer.alg,
      assurance: draft.signer.assurance,
    };
    const event = await draft.signer.sign(unsigned);
    const parsed = parseEventEnvelope(event);
    if (!parsed.success) throw thrown(parsed.error);
    events.push(parsed.data);
    head = { id: parsed.data.id, hash: hashOf(parsed.data) };
  }
  return events;
}

/**
 * What a store checks before writing the creator's events (`appendHuman`), on the journal as it
 * is when written: one creator's device, in a valid shape and of a known type, chained one after
 * the other on that device's head (`deviceHead`), and of the journal's product. A head that moved
 * since they were prepared gives `UNEXPECTED`: nothing is written, and the command can be run
 * again.
 */
export function checkHumanEvents(
  events: readonly EventEnvelope[],
  deviceHead: DeviceHead | null,
  journalProduct: string | null,
): void {
  const first = events[0];
  if (first === undefined) {
    throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
      reason: "no event to append",
    });
  }
  let prev = deviceHead?.hash ?? null;
  for (const event of events) {
    const parsed = parseEventEnvelope(event);
    if (!parsed.success) throw thrown(parsed.error);
    const current = currentEvent(parsed.data);
    if (!current.ok) throw thrown(current.error);
    if (
      event.actor.kind !== "human" ||
      event.actor.device !== first.actor.device ||
      !HUMAN_DEVICE_PATTERN.test(event.actor.device)
    ) {
      throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
        reason: "the creator's events must all be the same creator's",
      });
    }
    if (event.prev !== prev) {
      throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
        reason:
          "the creator's chain moved while this command ran (another command of yours wrote meanwhile): nothing was written, run it again",
      });
    }
    if (event.product !== (journalProduct ?? first.product)) {
      throw productIdMismatch(event.product, journalProduct ?? first.product);
    }
    prev = hashOf(event);
  }
}
