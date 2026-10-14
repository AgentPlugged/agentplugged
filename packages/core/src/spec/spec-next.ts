import type { CommandContext } from "../command.js";
import { mentionsSensitiveData } from "../critique/critique-rules.js";
import { currentState } from "../deferred/deferred-commands.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { isSkipped } from "../journey/journey-rules.js";
import type { NextStep } from "../next/next.js";
import { outgrown, readScope } from "./path-rules.js";
import { countSpec, SPEC_PATH } from "./spec-grow.js";

/** The most reasons `next` says of a spec that outgrew the short path. */
const MAX_WHY = 4;

/**
 * What `next` adds for the short path, when there is something to say: nothing
 * otherwise. `choose`: a new product reaches the framing, the creator has not chosen a path (Noah
 * proposes one, `docs path`). `grow`: the spec outgrew the short path (`spec_path_why`, as codes):
 * Noah proposes the full path in one line. `carry`: the full path is on again while a spec still
 * stands: `docs grow` carries it over. `risk`: the spec speaks of sensitive data
 * (`spec_path_why`: `text:sensitive`) although its scope declares none and the creator did not ask
 * for the short path in so many words: Noah says it in one line and proposes the full path.
 */
export interface SpecNext {
  readonly spec_path?: "choose" | "grow" | "carry" | "risk";
  readonly spec_path_why?: readonly string[];
}

/** What the spec reveals that its scope does not declare. */
const RISK: SpecNext = { spec_path: "risk", spec_path_why: ["text:sensitive"] };

/** Reads the spec only when it exists; writes nothing. */
export async function specNext(context: CommandContext, step: NextStep): Promise<SpecNext> {
  const hasSpec = await context.files.exists(SPEC_PATH);
  const skipped = isSkipped(await currentState(context), "full_path");
  if (!hasSpec) return !skipped && step.step === "framing" ? { spec_path: "choose" } : {};
  if (!skipped) return { spec_path: "carry" };
  const text = await context.files.readText(SPEC_PATH).catch(() => undefined);
  if (text === undefined) return {};
  const document = parseDocumentFile(SPEC_PATH, text);
  const scope =
    document.header === undefined
      ? undefined
      : readScope(document.header as Record<string, unknown>);
  const asked = (document.header as Record<string, unknown> | undefined)?.asked;
  const unasked = asked !== "short";
  if (scope === undefined || !scope.ok) {
    return unasked && mentionsSensitiveData(text) ? RISK : {};
  }
  const why = outgrown(scope.criteria, countSpec(document, text));
  if (why.length > 0) return { spec_path: "grow", spec_path_why: why.slice(0, MAX_WHY) };
  return unasked && mentionsSensitiveData(text) ? RISK : {};
}
