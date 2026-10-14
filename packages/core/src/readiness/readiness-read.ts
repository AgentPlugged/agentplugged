import { DOMAIN_IDS, type MethodConfig } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { checkDocuments } from "../docs/check-docs.js";
import { knownOwners, readDocumentFiles, readMockupFiles } from "../docs/docs-command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { isPlanningPath, type ReadyCopy } from "./readiness-rules.js";

/** The profile has a UX domain (a product without one has no UX specification to wait for). */
export function needsUxOf(config: MethodConfig): boolean {
  return (config.profile?.domains ?? DOMAIN_IDS).includes("ux");
}

/**
 * The planning documents of the working copy, parsed once, and what `docs check` finds in them
 * (the rules of the documents alone, without a base). Every document is read for the check, since
 * a link may lead to any of them; only the planning ones are kept.
 */
export async function readCopy(context: CommandContext, needsUx: boolean): Promise<ReadyCopy> {
  const all = await readDocumentFiles(context.files, true);
  const owners = await knownOwners(context.files);
  const mockups = await readMockupFiles(context.files, true);
  const problems = checkDocuments({ current: all, owners, mockups });
  const planning = all.filter((file) => isPlanningPath(file.path));
  return {
    documents: planning.map((file) => parseDocumentFile(file.path, file.text)),
    texts: new Map(planning.map((file) => [file.path, file.text])),
    problems,
    needsUx,
  };
}
