/**
 * The small checks on values that the engine makes everywhere: a parsed text or a payload read as
 * data, bytes compared.
 */

/** A JSON object: not null, not an array. */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A list of strings. */
export const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

/** True when two byte strings hold the same bytes (not for secrets: use a constant-time compare). */
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((byte, i) => byte === b[i]);
