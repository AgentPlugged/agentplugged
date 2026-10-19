import { z } from "zod";
import { BRIDGE_ID_PATTERN } from "./device-trust.js";
import { FORGE_LINKS_MAX, ForgeLinkStatusSchema } from "./forge-link.js";
import { SemverSchema } from "./method-config.js";
import {
  PRODUCT_CREATIONS_MAX,
  PRODUCT_LOCATIONS_MAX,
  ProductCreationSchema,
  ProductLifeSchema,
  ProductLocationSchema,
} from "./product-lifecycle.js";
import { readTolerant } from "./tolerant-reader.js";

/**
 * Several machines for one account: what a machine says about itself (end-to-end encrypted, the
 * relay never reads it), the choice of a product's main bridge, and the rules that route an order.
 *
 * Generic on purpose: schemas and small pure rules only, no transport and no account.
 *
 * Reading rule: a device ignores the optional fields of a report it does not know and validates
 * those it knows (`MachineReportReader`); an order a machine receives stays strict.
 */

/** Event types of the machines, each at version 1. */
export const MACHINE_EVENT_TYPES = {
  /** The main bridge of the product changed: written by the machine that becomes main. */
  primaryChanged: "bridge.primary_changed",
} as const;

/**
 * `payload` of `bridge.primary_changed`: the bridge that is now the product's main one, and the
 * one that was (null for the first choice). Only the last one in projection order counts.
 */
export const PrimaryChangedPayloadSchema = z.strictObject({
  bridge: z.string().regex(BRIDGE_ID_PATTERN),
  previous: z.string().regex(BRIDGE_ID_PATTERN).nullable(),
});
export type PrimaryChangedPayload = z.infer<typeof PrimaryChangedPayloadSchema>;

/** Stable codes of a refused change of main bridge (separate from `ErrorCode`, like the pairing's). */
export const PRIMARY_ERROR_CODES = {
  /** The new bridge does not hold the product's journal up to date: synchronise it first. */
  PRIMARY_BRIDGE_NOT_SYNCED: "PRIMARY_BRIDGE_NOT_SYNCED",
  /** The new bridge does not serve this product. */
  PRIMARY_BRIDGE_NOT_SERVING: "PRIMARY_BRIDGE_NOT_SERVING",
  /** The new bridge is too old for the current protocol version. */
  PRIMARY_BRIDGE_UPGRADE_REQUIRED: "PRIMARY_BRIDGE_UPGRADE_REQUIRED",
  /** The new bridge is offline: it would publish nothing. */
  PRIMARY_BRIDGE_OFFLINE: "PRIMARY_BRIDGE_OFFLINE",
  /** The new bridge is not a trusted machine of the journal. */
  PRIMARY_BRIDGE_NOT_TRUSTED: "PRIMARY_BRIDGE_NOT_TRUSTED",
} as const;
export type PrimaryErrorCode = (typeof PRIMARY_ERROR_CODES)[keyof typeof PRIMARY_ERROR_CODES];

/** The longest role text a machine takes, in characters. */
export const MACHINE_ROLE_MAX = 120;
/** The most products and tools one report lists. */
export const MACHINE_REPORT_MAX_ITEMS = 64;

/** One AI tool the bridge detected on its machine, and how it is integrated. */
export const DetectedToolSchema = z.strictObject({
  tool: z.string().min(1).max(40),
  /** The integration mode, in plain words (never a path). */
  mode: z.string().min(1).max(60),
  active: z.boolean(),
});
export type DetectedTool = z.infer<typeof DetectedToolSchema>;

/**
 * What a bridge says of its machine, inside its end-to-end encrypted beat: its version, the
 * protocol version it speaks, the products it serves (names the creator knows), how many agent
 * instances run (an instance is an agent on a story), the tools it detected and the role the
 * creator gave it. The relay sees none of it.
 */
export const MachineReportSchema = z.strictObject({
  /** The name the machine goes by (its host name unless the creator changed it). */
  name: z.string().min(1).max(60),
  bridge_version: SemverSchema,
  protocol_version: z.number().int().positive(),
  products: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(80),
        name: z.string().min(1).max(80),
        /** The creator's priority for this product (1 first); absent while they gave none. */
        rank: z.int().min(1).max(9999).optional(),
        /** The marks the creator gave it (stage, pause, archive), its repository and its profile. */
        ...ProductLifeSchema.shape,
      }),
    )
    .max(MACHINE_REPORT_MAX_ITEMS),
  agents: z.number().int().nonnegative(),
  tools: z.array(DetectedToolSchema).max(MACHINE_REPORT_MAX_ITEMS),
  role: z.string().max(MACHINE_ROLE_MAX).optional(),
  /**
   * The names of the tokens and logins the creator gave this machine (`forge.github`,
   * `data.crm`), never their values: what to renew at the platforms if the machine is lost. Only
   * present when there is at least one.
   */
  secrets: z
    .array(z.string().regex(/^(?:forge|data)\.[a-z0-9][a-z0-9._-]{0,63}$/))
    .max(MACHINE_REPORT_MAX_ITEMS)
    .optional(),
  /**
   * The code platforms this machine is linked to (or being linked to): who, how far, until when.
   * Never a token. Only present when there is at least one.
   */
  forges: z.array(ForgeLinkStatusSchema).max(FORGE_LINKS_MAX).optional(),
  /**
   * Where this machine keeps its keys: the system keychain, or the fallback store of a machine
   * that has none (a server). Absent from a bridge that does not say.
   */
  key_store: z.enum(["system", "fallback"]).optional(),
  /**
   * The places this machine allows new products in, with the repositories already there that a
   * product can start from. Only present on a machine that can create products.
   */
  locations: z.array(ProductLocationSchema).max(PRODUCT_LOCATIONS_MAX).optional(),
  /** The products this machine is creating or failed to create. Only present when there is one. */
  creations: z.array(ProductCreationSchema).max(PRODUCT_CREATIONS_MAX).optional(),
});
export type MachineReport = z.infer<typeof MachineReportSchema>;

/** What a device reads of a report: unknown optional fields dropped, known ones as strict as above. */
export const MachineReportReader = readTolerant(MachineReportSchema);

/**
 * The payload of the order that gives a machine its role: free text, replaced as a whole. It is
 * carried by a signed, encrypted order, never written in clear anywhere.
 */
export const MachineRoleOrderSchema = z.strictObject({
  bridge: z.string().regex(BRIDGE_ID_PATTERN),
  role: z.string().max(MACHINE_ROLE_MAX),
});
export type MachineRoleOrder = z.infer<typeof MachineRoleOrderSchema>;

/**
 * Whether a bridge speaking `bridgeProtocol` still works with the current protocol version
 * `current`: the current one and the previous one are served, anything older must be updated.
 */
export function bridgeNeedsUpgrade(bridgeProtocol: number, current: number): boolean {
  return bridgeProtocol < current - 1;
}
