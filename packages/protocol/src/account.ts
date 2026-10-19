import { z } from "zod";
import { ULID_PATTERN } from "./event-envelope.js";

/**
 * The wire contract of the account routes of the relay: creating an account (the address is proved
 * by a code sent by e-mail, then a passkey is made), signing in with a passkey, reading and
 * changing the profile, signing out. No password exists anywhere in it: a passkey is the only way
 * in. The address is unique: one person, one account.
 */

/** The languages an account can choose. */
export const ACCOUNT_LOCALES = ["fr", "en", "es", "pt"] as const;
export type AccountLocale = (typeof ACCOUNT_LOCALES)[number];

/** The name of the session cookie: `__Host-` forces `Secure`, `Path=/` and no `Domain`. */
export const ACCOUNT_SESSION_COOKIE = "__Host-ap_session";

/**
 * The header a native app sends on every account call. Its presence picks the app's channel: no
 * `Origin` is expected, the session travels in `Authorization: Bearer` (never in a cookie), and the
 * answer to a sign-in carries it in the body. A web page cannot send a custom header to another
 * site without a successful preflight, which only the relay's allowed origins get.
 */
export const ACCOUNT_CLIENT_HEADER = "x-agentplugged-client";
export const ACCOUNT_CLIENT_APP = "app";

/** The routes of the relay's account API (all under the relay's own origin). */
export const ACCOUNT_ROUTES = {
  emailStart: "/account/email/start",
  emailVerify: "/account/email/verify",
  registerOptions: "/account/register/options",
  registerVerify: "/account/register/verify",
  loginOptions: "/account/login/options",
  loginVerify: "/account/login/verify",
  me: "/account/me",
  logout: "/account/logout",
  /** `POST` asks for an export of the account's data; `GET` tells where the last request stands. */
  export: "/account/export",
  /** `POST` with the identifier of a ready export: the file, once. */
  exportDownload: "/account/export/download",
  /** `POST` erases the account (irreversible). */
  delete: "/account/delete",
  /** `GET` lists the account's passkeys. */
  passkeys: "/account/passkeys",
  /** `POST` opens the making of one more passkey (a session is needed). */
  passkeyOptions: "/account/passkeys/options",
  /** `POST` closes it: the passkey is added to the account. */
  passkeyVerify: "/account/passkeys/verify",
  /** `POST` removes one passkey of the account. */
  passkeyRemove: "/account/passkeys/remove",
} as const;

/** The most passkeys one account may hold. */
export const ACCOUNT_PASSKEYS_MAX = 10;

/** The longest address kept (RFC 5321). */
export const ACCOUNT_EMAIL_MAX_CHARS = 254;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** An address as the relay keeps it: trimmed and lowercased. */
export const AccountEmailSchema = z
  .string()
  .transform((value) => value.trim().toLowerCase())
  .pipe(z.string().max(ACCOUNT_EMAIL_MAX_CHARS).regex(EMAIL_PATTERN));

export const AccountLocaleSchema = z.enum(ACCOUNT_LOCALES);

/** The length of the code sent by e-mail. */
export const ACCOUNT_EMAIL_CODE_DIGITS = 6;

/**
 * Starts the creation of an account: the address and the language. The relay sends a code to the
 * address and answers the same thing whether the address already has an account or not.
 */
export const AccountEmailStartRequestSchema = z.strictObject({
  email: AccountEmailSchema,
  locale: AccountLocaleSchema,
});
export type AccountEmailStartRequest = z.infer<typeof AccountEmailStartRequestSchema>;

/** The answer to the start: the identifier of the verification, to send back with the code. */
export const AccountEmailStartResponseSchema = z.strictObject({
  verification: z.string().min(1).max(64),
  /** How long the code works, in minutes. */
  valid_minutes: z.number().int().positive(),
});
export type AccountEmailStartResponse = z.infer<typeof AccountEmailStartResponseSchema>;

/** The code the creator read in the e-mail. The answer is `{ ok: true }`: the address is proved. */
export const AccountEmailVerifyRequestSchema = z.strictObject({
  verification: z.string().min(1).max(64),
  code: z.string().regex(new RegExp(`^[0-9]{${ACCOUNT_EMAIL_CODE_DIGITS}}$`)),
});
export type AccountEmailVerifyRequest = z.infer<typeof AccountEmailVerifyRequestSchema>;

/**
 * Asks, once the address is proved, for the options of the passkey to make. It may be asked again
 * (a passkey prompt that was closed) for as long as the verification lasts. The answer is an
 * `AccountCeremony`.
 */
export const AccountRegisterOptionsRequestSchema = z.strictObject({
  verification: z.string().min(1).max(64),
});
export type AccountRegisterOptionsRequest = z.infer<typeof AccountRegisterOptionsRequestSchema>;

/** Opens a sign-in: nothing to say, the passkey tells who the creator is. */
export const AccountLoginOptionsRequestSchema = z.strictObject({});

/** What the relay answers to open a ceremony: its identifier and the options for the browser. */
export const AccountCeremonySchema = z.object({
  ceremony: z.string().min(1).max(64),
  options: z.record(z.string(), z.unknown()),
});
export type AccountCeremony = z.infer<typeof AccountCeremonySchema>;

/** Closes a ceremony: the identifier and what the browser's passkey produced. */
export const AccountVerifyRequestSchema = z.strictObject({
  ceremony: z.string().min(1).max(64),
  response: z.record(z.string(), z.unknown()),
});
export type AccountVerifyRequest = z.infer<typeof AccountVerifyRequestSchema>;

/** The answer to a creation or a sign-in: the session itself travels in a cookie, never in the body. */
export const AccountVerifyResponseSchema = z.strictObject({ ok: z.literal(true) });

/**
 * The answer to a creation or a sign-in on the app's channel: the session token itself (the app
 * keeps it in the phone's secure store) and the moment it stops working.
 */
export const AccountAppVerifyResponseSchema = z.strictObject({
  ok: z.literal(true),
  session: z.string().min(1).max(128),
  expires_at: z.string(),
});
export type AccountAppVerifyResponse = z.infer<typeof AccountAppVerifyResponseSchema>;

/** The profile the relay keeps: the address, the language, the creation date. */
export const AccountProfileSchema = z.strictObject({
  account_id: z.string().regex(ULID_PATTERN),
  email: z.string().nullable(),
  locale: AccountLocaleSchema.nullable(),
  created_at: z.string(),
});
export type AccountProfile = z.infer<typeof AccountProfileSchema>;

export const AccountProfileUpdateSchema = z.strictObject({ locale: AccountLocaleSchema });

/** Where an export stands: being prepared, or ready to download. */
export const ACCOUNT_EXPORT_STATUSES = ["pending", "ready"] as const;

/** An export of the account's data, as the relay describes it to its owner. */
export const AccountExportStatusSchema = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
  status: z.enum(ACCOUNT_EXPORT_STATUSES),
  requested_at: z.string(),
  /** The date the export is promised by (it is usually ready within seconds). */
  due_at: z.string(),
  ready_at: z.string().nullable(),
  /** The date the link stops working, once the export is ready. */
  expires_at: z.string().nullable(),
});
export type AccountExportStatus = z.infer<typeof AccountExportStatusSchema>;

/** The answer to a request or a look at the export: the current one, or none. */
export const AccountExportAnswerSchema = z.strictObject({
  export: AccountExportStatusSchema.nullable(),
});
export type AccountExportAnswer = z.infer<typeof AccountExportAnswerSchema>;

/** Downloads a ready export, once. */
export const AccountExportDownloadRequestSchema = z.strictObject({
  id: z.string().regex(ULID_PATTERN),
});

/** Erases the account for good; `confirm` must be `true` (the creator's second gesture). */
export const AccountDeleteRequestSchema = z.strictObject({ confirm: z.literal(true) });
export type AccountDeleteRequest = z.infer<typeof AccountDeleteRequestSchema>;

/** One passkey of the account, as its owner sees it: public facts only. */
export const AccountPasskeySchema = z.strictObject({
  /** The credential identifier, base64url (public: it is not a secret). */
  id: z.string().min(1).max(1024),
  created_at: z.string(),
  last_used_at: z.string().nullable(),
});
export type AccountPasskey = z.infer<typeof AccountPasskeySchema>;

/** The answer to the list of the account's passkeys. */
export const AccountPasskeysAnswerSchema = z.strictObject({
  passkeys: z.array(AccountPasskeySchema).max(ACCOUNT_PASSKEYS_MAX),
});
export type AccountPasskeysAnswer = z.infer<typeof AccountPasskeysAnswerSchema>;

/** Removes a passkey of the account. */
export const AccountPasskeyRemoveRequestSchema = z.strictObject({
  id: z.string().min(1).max(1024),
});
export type AccountPasskeyRemoveRequest = z.infer<typeof AccountPasskeyRemoveRequestSchema>;
