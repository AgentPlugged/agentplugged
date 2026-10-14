import type { RequirementEntry } from "@agentplugged/protocol";
import { readDocumentFiles } from "../docs/docs-command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { buildRegistry } from "./requirement-rules.js";

/** What the documents of the working copy say of the requirements, read once. */
export async function readRegistry(files: WorkspaceFiles): Promise<RequirementEntry[]> {
  const documents = await readDocumentFiles(files, true);
  return buildRegistry(
    documents.map((file) => parseDocumentFile(file.path, file.text)),
    documents,
  );
}
