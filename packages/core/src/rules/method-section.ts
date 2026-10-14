import { parse } from "yaml";
import type { ZodType } from "zod";

/**
 * The section `key` of a `method.yaml` text, checked by `schema`: undefined when the file has none,
 * `"invalid"` when the text or the section cannot be read. The settings read on the main branch
 * (rules, validation, installs, pull requests) all start there.
 */
export function methodSection<T>(
  text: string,
  key: string,
  schema: ZodType<T>,
): T | undefined | "invalid" {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return "invalid";
  }
  if (data === null || typeof data !== "object" || !(key in data)) return undefined;
  const result = schema.safeParse((data as Record<string, unknown>)[key]);
  return result.success ? result.data : "invalid";
}
