import { z } from "zod";

/**
 * Linking a code platform (GitHub, GitLab) to a machine. The creator's device asks, with a signed
 * order, for the machine to be authorised at the platform; the machine does it itself, keeps the
 * token in its own system keychain and says what became of it in its report. The token is in none
 * of these shapes: a device only ever learns the state of a link (who, how far, until when) and,
 * while an authorisation is under way, the short code and the public address to enter it at.
 */

/** The platforms a machine can be linked to. */
export const FORGE_PROVIDERS = ["github", "gitlab"] as const;
export type ForgeProvider = (typeof FORGE_PROVIDERS)[number];

/** Where each platform lives unless the machine is told otherwise. */
export const FORGE_DEFAULT_HOSTS: Readonly<Record<ForgeProvider, string>> = {
  github: "github.com",
  gitlab: "gitlab.com",
};

/**
 * The longest host name (with its port) a link can name: the name of its secret
 * (`forge.gitlab.<host>`) and the reference of its orders must stay within what those allow.
 */
export const FORGE_HOST_MAX = 50;

/**
 * A host name, lowercase, with an optional port: `gitlab.example.com`, `git.acme.io:8443`. No
 * scheme, no user, no path, no parameter: the machine builds the address itself and always asks
 * for `https` (a host of this very machine may be reached in the clear).
 */
export const FORGE_HOST_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::[1-9][0-9]{0,4})?$/;

export const ForgeHostSchema = z
  .string()
  .max(FORGE_HOST_MAX)
  .regex(FORGE_HOST_PATTERN)
  .refine((host) => {
    const port = host.split(":")[1];
    return port === undefined || Number(port) <= 65_535;
  });

/** The platform a link or an order is about; an absent host is the platform's own. */
export const ForgeTargetSchema = z.strictObject({
  provider: z.enum(FORGE_PROVIDERS),
  host: ForgeHostSchema.optional(),
});
export type ForgeTarget = z.infer<typeof ForgeTargetSchema>;

/** The host a target stands for. */
export function forgeHostOf(target: ForgeTarget): string {
  return target.host ?? FORGE_DEFAULT_HOSTS[target.provider];
}

/**
 * The name a machine keeps the token under in its keychain (`forge.github`, `forge.gitlab`,
 * `forge.gitlab.git.acme.io-8443`). It fits the shape of a secret name; it never holds a value.
 */
export function forgeSecretName(target: ForgeTarget): string {
  const host = forgeHostOf(target);
  if (host === FORGE_DEFAULT_HOSTS[target.provider]) return `forge.${target.provider}`;
  return `forge.${target.provider}.${host.replace(":", "..")}`;
}

/** The reference an applied order answers with: it names the link, never a token. */
export function forgeReference(
  target: ForgeTarget,
  outcome: "started" | "removed" | "grant_remains",
): string {
  return `forge:${forgeSecretName(target)}:${outcome}`;
}

/** The orders. */
export const ORDER_TYPE_FORGE_LINK = "forge.link";
export const ORDER_TYPE_FORGE_UNLINK = "forge.unlink";

/** Asks a machine to authorise itself at a platform (it answers at once, the wait goes on in the machine). */
export const LinkForgeParamsSchema = ForgeTargetSchema;
export type LinkForgeParams = z.infer<typeof LinkForgeParamsSchema>;

/** Asks a machine to forget a platform: the token goes, and the grant is revoked when it can be. */
export const UnlinkForgeParamsSchema = ForgeTargetSchema;
export type UnlinkForgeParams = z.infer<typeof UnlinkForgeParamsSchema>;

/** The codes a refused `forge.link` or `forge.unlink` answers with. */
export const FORGE_ORDER_CODES = {
  /** The publisher's application is not registered for this platform: link from the machine. */
  noApplication: "FORGE_NO_APPLICATION",
  /** This machine has no system keychain to keep a token in. */
  storeUnavailable: "FORGE_STORE_UNAVAILABLE",
  /** The platform could not be reached or refused the request for a code. */
  unreachable: "FORGE_UNREACHABLE",
  /** The platform has no device flow (an old self-hosted version). */
  noDeviceFlow: "FORGE_NO_DEVICE_FLOW",
  /** The host cannot be used (not `https`, or not a host name). */
  badHost: "FORGE_BAD_HOST",
  /** The token could not be taken out of the keychain: nothing was said to be removed. */
  notRemoved: "FORGE_NOT_REMOVED",
} as const;

/** Why a link, or an attempt to link, is not in order. */
export const FORGE_FAILURES = [
  "expired",
  "denied",
  "unreachable",
  "rejected",
  "not_saved",
] as const;
export type ForgeFailure = (typeof FORGE_FAILURES)[number];

/**
 * What the machine says of one link. `pending`: an authorisation is under way, with the code and
 * the address to enter it at (both public, useless without the creator's login at the platform).
 * `linked`: a token is kept. `relink`: a token was kept and the platform no longer takes it
 * (revoked, or expired with nothing to renew it). `failed`: the last attempt did not end well.
 */
export const FORGE_LINK_STATES = ["pending", "linked", "relink", "failed"] as const;

/** What a token allows: read only, read and write, or not told by the platform. */
export const FORGE_ACCESS = ["read", "write", "unknown"] as const;
export type ForgeAccess = (typeof FORGE_ACCESS)[number];

export const FORGE_REPOS_LISTED_MAX = 30;

export const ForgeLinkStatusSchema = z.strictObject({
  provider: z.enum(FORGE_PROVIDERS),
  host: ForgeHostSchema,
  state: z.enum(FORGE_LINK_STATES),
  /** How the token was obtained: the platform's device flow, or given on the machine. */
  method: z.enum(["device", "token"]).optional(),
  /** The account the token belongs to (the platform's login). */
  account: z.string().min(1).max(100).optional(),
  access: z.enum(FORGE_ACCESS).optional(),
  /** The scopes or permissions the platform reported, as it names them. */
  scopes: z.array(z.string().min(1).max(60)).max(12).optional(),
  repos: z
    .discriminatedUnion("kind", [
      z.strictObject({ kind: z.literal("all") }),
      z.strictObject({
        kind: z.literal("listed"),
        names: z.array(z.string().min(1).max(140)).max(FORGE_REPOS_LISTED_MAX),
        more: z.boolean(),
      }),
    ])
    .optional(),
  linked_at: z.iso.datetime().optional(),
  /** When the token stops working; absent when the platform did not say. */
  expires_at: z.iso.datetime().optional(),
  pending: z
    .strictObject({
      user_code: z.string().min(1).max(32),
      /** The public address to enter the code at. */
      verification_uri: z.string().max(300),
      expires_at: z.iso.datetime(),
    })
    .optional(),
  failure: z.enum(FORGE_FAILURES).optional(),
});
export type ForgeLinkStatus = z.infer<typeof ForgeLinkStatusSchema>;

/** The most links one machine reports. */
export const FORGE_LINKS_MAX = 16;

/**
 * Whether a list of scopes (GitHub's `repo`, GitLab's `api`, a permission such as
 * `contents:write`) lets a token write. Anything not known to be read only counts as writing, so
 * the creator is never told a token is read only when it may not be.
 */
export function forgeAccessOf(scopes: readonly string[]): ForgeAccess {
  if (scopes.length === 0) return "unknown";
  const readOnly = (scope: string): boolean =>
    /^(?:read_[a-z_]+|read:[a-z_:]+|repo:status|openid|profile|email|user:email|contents:read|[a-z_]+:read|metadata:read)$/.test(
      scope,
    );
  return scopes.every(readOnly) ? "read" : "write";
}
