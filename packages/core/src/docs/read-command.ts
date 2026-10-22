import { ErrorCode } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { readDocumentFiles } from "./docs-command.js";
import {
  READ_MAX_LINES,
  READ_PASSAGE_LINES,
  type Reading,
  readSelectors,
} from "./read-sections.js";

/** The answer of `docs read`: the passages asked for (see `Reading`). */
export type SectionsRead = Reading;

const SELECTOR =
  /^(?:@(?:requirements|constraints|journeys|decisions|stack|screens)|@cited:[\w-]+|\w[\w-]*(?:\/\w[\w-]*)*\.md(?:#[a-z0-9-]+)?|(?:EF|ENF|PU|MS|AD|UX)-[1-9]\d{0,5})$/;

/**
 * `docs read <selector…>`: the text of the passages named (identifiers, sections, groups), or the
 * outline of a document named alone. Reads only; never a whole document.
 */
export async function readSections(
  context: CommandContext,
  selectors: readonly string[],
): Promise<SectionsRead | AgentPluggedError> {
  const wrong = selectors.filter((selector) => !SELECTOR.test(selector));
  if (selectors.length === 0 || wrong.length > 0) {
    return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      reason: `docs read ${(wrong.length > 0 ? wrong : selectors).join(" ")} (EF-1, prd.md#anchor, prd.md, @requirements, @cited:<story>)`,
    });
  }
  const files = await readDocumentFiles(context.files, true);
  return readSelectors(files, selectors, { total: READ_MAX_LINES, passage: READ_PASSAGE_LINES });
}
