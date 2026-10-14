import { fromBase64url } from "@agentplugged/crypto";
import {
  type EventEnvelope,
  HUMAN_EVENT_TYPES,
  type HumanKeyEndorsedPayload,
  type HumanKeyRegisteredPayload,
  type HumanPresenceLinkedPayload,
  type IgnoredReason,
  type PresenceAlg,
} from "@agentplugged/protocol";
import { humanDevice } from "../human/human-key.js";
import { section } from "./agent-reducers.js";
import type { ProjectionDraft, Reducer } from "./reducers.js";

/** A `presence` credential linked to a creator's key. */
export interface PresenceEntry {
  readonly credential_id: string;
  readonly alg: PresenceAlg;
  readonly linked_at: string;
}

/**
 * How far a creator's key is trusted in this product: the `root` key (the first one registered,
 * in projection order), a key `endorsed` by a trusted one, or a `pending` key, whose answers,
 * links and endorsements are ignored until it is endorsed.
 */
export type HumanTrust = "root" | "endorsed" | "pending";

/** `state.humans[device]`: a creator's key registered in the journal, and its credentials. */
export interface HumanState {
  readonly device: string;
  /** The `locale` Ed25519 public key, base64url. */
  readonly public_key: string;
  readonly registered_at: string;
  trust: HumanTrust;
  /** The trusted creator who endorsed it, or null (root, pending). */
  endorsed_by: string | null;
  /** The `presence` credentials linked to it, in projection order. */
  readonly presence: PresenceEntry[];
}

function humanOf(draft: ProjectionDraft, device: string): HumanState | undefined {
  const humans = section<HumanState>(draft, "humans");
  return Object.hasOwn(humans, device) ? humans[device] : undefined;
}

/** True when `device` is a creator's key trusted in this product (root or endorsed). */
export function trustedHuman(draft: ProjectionDraft, device: string): boolean {
  const human = humanOf(draft, device);
  return human !== undefined && human.trust !== "pending";
}

/**
 * Why a creator's answer cannot count, or undefined: its key is not trusted
 * (`unendorsed_human`), or it is signed by a WebAuthn credential not linked to that key in this
 * journal (`unknown_signer`).
 */
export function untrustedAnswer(
  draft: ProjectionDraft,
  event: EventEnvelope,
): IgnoredReason | undefined {
  const human = humanOf(draft, event.actor.device);
  if (human === undefined) return "unknown_signer";
  if (human.trust === "pending") return "unendorsed_human";
  if (event.alg !== "ed25519") {
    const credential = draft.signedBy.get(event.id);
    if (!human.presence.some((entry) => entry.credential_id === credential)) {
      return "unknown_signer";
    }
  }
  return undefined;
}

/**
 * Who closes a record of a register (deferred work, deviations): a creator whose answer counts
 * (its device), or an agent the rule lets (`agentMay`). `refusal` when the creator's answer cannot
 * count; neither when nobody may.
 */
export function closerOf(
  draft: ProjectionDraft,
  event: EventEnvelope,
  agentMay: (agent: string) => boolean,
): { readonly by?: string; readonly refusal?: IgnoredReason } {
  if (event.actor.kind === "human") {
    const refusal = untrustedAnswer(draft, event);
    return refusal === undefined ? { by: event.actor.device } : { refusal };
  }
  const agent = event.actor.kind === "agent" ? event.actor.agent : undefined;
  return agent !== undefined && agentMay(agent) ? { by: agent } : {};
}

/** The creator's key that signed the event, once trusted; else the event is ignored, saying why. */
function trustedSigner(draft: ProjectionDraft, event: EventEnvelope): HumanState | undefined {
  const human = humanOf(draft, event.actor.device);
  const reason =
    human === undefined
      ? "unknown_signer"
      : human.trust === "pending"
        ? "unendorsed_human"
        : undefined;
  if (reason !== undefined) draft.ignored.push({ id: event.id, reason });
  return reason === undefined ? human : undefined;
}

/**
 * The reducers of the creator's keys. The projection applies them only to events it
 * verified: `human.key_registered` signed by the key it publishes, `human.presence_linked` signed
 * both by the credential (with UV) and by the `locale` key, `human.key_endorsed` signed by its
 * writer. The first key registered is the root; later ones are pending until endorsed by a
 * trusted key (an endorsement may come before the key's registration, in projection order).
 */
export const HUMAN_REDUCERS: Readonly<Record<string, Reducer>> = {
  [HUMAN_EVENT_TYPES.keyRegistered]: (draft, event) => {
    const humans = section<HumanState>(draft, "humans");
    const device = event.actor.device;
    if (Object.hasOwn(humans, device)) return;
    const { public_key } = event.payload as HumanKeyRegisteredPayload;
    const pin = draft.pinnedRoot;
    // A root pinned outside the repository decides: the first key in the journal's
    // order is no longer the root, and a machine's root makes no creator key the root by order.
    const root =
      pin === undefined
        ? !Object.values(humans).some((human) => human.trust === "root")
        : pin.device === device && pin.public_key === public_key;
    const endorsement = draft.endorsements.get(device);
    const endorsed = endorsement !== undefined && endorsement.public_key === public_key;
    humans[device] = {
      device,
      public_key,
      registered_at: event.at,
      trust: root ? "root" : endorsed ? "endorsed" : "pending",
      endorsed_by: !root && endorsed ? endorsement.by : null,
      presence: [],
    };
  },
  [HUMAN_EVENT_TYPES.presenceLinked]: (draft, event) => {
    const human = trustedSigner(draft, event);
    if (human === undefined) return;
    const { credential_id, alg } = event.payload as HumanPresenceLinkedPayload;
    if (human.presence.some((entry) => entry.credential_id === credential_id)) return;
    human.presence.push({ credential_id, alg, linked_at: event.at });
  },
  [HUMAN_EVENT_TYPES.keyEndorsed]: (draft, event) => {
    const endorser = trustedSigner(draft, event);
    if (endorser === undefined) return;
    const { device, public_key } = event.payload as HumanKeyEndorsedPayload;
    const key = fromBase64url(public_key);
    if (key === undefined || humanDevice(key) !== device) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    const target = humanOf(draft, device);
    if (target === undefined) {
      if (!draft.endorsements.has(device)) {
        draft.endorsements.set(device, { public_key, by: endorser.device });
      }
      return;
    }
    if (target.public_key !== public_key) {
      draft.ignored.push({ id: event.id, reason: "invalid" });
      return;
    }
    if (target.trust === "pending") {
      target.trust = "endorsed";
      target.endorsed_by = endorser.device;
    }
  },
};
