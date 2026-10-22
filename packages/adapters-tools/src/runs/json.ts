/** Small readers shared by the translators: a value of the wrong kind is simply absent. */

export type Json = Record<string, unknown>;

export const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

/** A session or conversation identifier as the tools write them. */
export const SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The kind of a sub-agent as the product names its agents: a short identifier. */
export const AGENT_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
/** A model name or alias. */
export const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]/-]{0,99}$/;

/**
 * A short code for a failure the tool told in free text, so that the text itself never travels:
 * the creator's views show a cause in their own language from the code.
 */
export function failureCode(message: string | undefined): string {
  const text = (message ?? "").toLowerCase();
  if (/usage limit|rate limit|quota|too many requests|credits/.test(text)) return "usage_limit";
  if (
    /not (?:logged|signed) in|log in|login|sign in|unauthori[sz]ed|authentication|api key/.test(
      text,
    )
  ) {
    return "not_signed_in";
  }
  if (/model/.test(text) && /(?:not found|unknown|invalid|unsupported|does not exist)/.test(text)) {
    return "model_unknown";
  }
  return "turn_failed";
}
