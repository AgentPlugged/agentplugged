import { ErrorCode } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { fail, ok } from "../command.js";
import { currentState } from "../deferred/deferred-commands.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { AgentPluggedError } from "../errors.js";
import { isSkipped } from "../journey/journey-rules.js";
import { choosePath, type PathChoice, readScope, scopeWords } from "./path-rules.js";
import { GROWN_PATHS, growSpec, SPEC_PATH } from "./spec-grow.js";

/** `docs path`: the path the engine recommends for what the creator described. */
export interface SpecPathResult {
  readonly spec: "path";
  readonly choice: PathChoice;
}

/** `docs grow`: the documents the spec became. */
export interface SpecGrowResult {
  readonly spec: "grow";
  readonly written: readonly string[];
  readonly removed: string;
  /** The identifiers the spec defined, all kept (the same set in the new documents). */
  readonly identifiers: readonly string[];
}

const invalid = (reason: string) =>
  new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });

/**
 * `docs path size=… users=… sensitive=… integrations=… platforms=… [asked=short|full]`: reads
 * nothing, writes nothing. Every criterion must be given.
 */
export function specPath(words: readonly string[]) {
  const record = scopeWords(words);
  if (record === false) return fail(invalid(`docs path ${words.join(" ")} (key=value)`));
  const scope = readScope(record);
  if (!scope.ok) return fail(invalid(`docs path ${scope.reason}`));
  const unknown = Object.keys(record).find(
    (key) => !["size", "users", "sensitive", "integrations", "platforms", "asked"].includes(key),
  );
  if (unknown !== undefined) return fail(invalid(`docs path ${unknown}`));
  return ok<SpecPathResult>({ spec: "path", choice: choosePath(scope.criteria) });
}

/** The identifiers a text defines, in order. */
function identifiersOf(path: string, text: string): string[] {
  return parseDocumentFile(path, text).definitions.map((definition) => definition.id);
}

/**
 * `docs grow`: carries the spec over to the full path. The brief, the PRD and the architecture are
 * written from its parts, the spec removed. Refuses (nothing written) when the spec is missing,
 * when the short path is still chosen, when one of the three exists already, when the spec has no parts, or when the identifiers of the
 * new documents are not exactly those of the spec: nothing is lost on the way.
 */
export async function specGrow(context: CommandContext) {
  const { files } = context;
  if (!(await files.exists(SPEC_PATH))) return fail(invalid("docs grow: no spec"));
  // The creator resumes the full path first: else `next` would ask for the spec again.
  // A copy with no journal yet has not chosen anything: nothing to wait for.
  const state = await currentState(context).catch(() => undefined);
  if (state !== undefined && isSkipped(state, "full_path")) {
    return fail(invalid("docs grow: short path"));
  }
  for (const path of Object.values(GROWN_PATHS)) {
    if (await files.exists(path)) return fail(invalid(`docs grow: ${path} exists`));
  }
  const text = await files.readText(SPEC_PATH);
  const grown = growSpec(text);
  if (!grown.ok) return fail(invalid(`docs grow: ${grown.reason}`));
  const before = identifiersOf(SPEC_PATH, text);
  const after = Object.entries(GROWN_PATHS).flatMap(([key, path]) =>
    identifiersOf(path, grown.documents[key as keyof typeof GROWN_PATHS]),
  );
  const same =
    before.length === after.length && [...before].sort().join() === [...after].sort().join();
  if (!same) return fail(invalid("docs grow: identifiers"));
  const written: string[] = [];
  for (const [key, path] of Object.entries(GROWN_PATHS)) {
    await files.writeText(path, grown.documents[key as keyof typeof GROWN_PATHS]);
    written.push(path);
  }
  await files.remove(SPEC_PATH);
  return ok<SpecGrowResult>({ spec: "grow", written, removed: SPEC_PATH, identifiers: before });
}
