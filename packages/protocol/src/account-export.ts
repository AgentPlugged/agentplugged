import { z } from "zod";

/**
 * The file a creator receives when they export their account: everything the relay holds about it,
 * in indented JSON, checked by this schema (`account-export.v1`). It never holds a secret and never
 * a readable content: the encrypted packets and vaults appear with their dates and sizes only, and
 * the relay cannot read them. What a product holds (documents, stories, history) lives in the
 * creator's repository and is not part of it.
 */

export const ACCOUNT_EXPORT_SCHEMA_ID = "account-export.v1";

/** The sections of the file, one per kind of data the relay keeps for an account. */
export const ACCOUNT_EXPORT_SECTIONS = [
  "account",
  "passkeys",
  "sessions",
  "devices",
  "device_prekeys",
  "pending_envelopes",
  "seen_envelopes",
  "vaults",
  "shares",
  "push_tokens",
  "exports",
] as const;
export type AccountExportSection = (typeof ACCOUNT_EXPORT_SECTIONS)[number];

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const Row = z.record(z.string(), Scalar);

export const AccountExportV1Schema = z.strictObject({
  schema: z.literal(ACCOUNT_EXPORT_SCHEMA_ID),
  generated_at: z.string(),
  /** What is not in this file, and where it is. */
  not_included: z.string(),
  account: Row,
  passkeys: z.array(Row),
  sessions: z.array(Row),
  devices: z.array(Row),
  device_prekeys: z.array(Row),
  pending_envelopes: z.array(Row),
  seen_envelopes: z.array(Row),
  vaults: z.array(Row),
  shares: z.array(Row),
  push_tokens: z.array(Row),
  exports: z.array(Row),
});
export type AccountExportV1 = z.infer<typeof AccountExportV1Schema>;
