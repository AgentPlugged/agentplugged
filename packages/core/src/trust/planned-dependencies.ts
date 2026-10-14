import { utf8 } from "@agentplugged/crypto";
import {
  ARCHITECTURE_DEPENDENCIES_FIELD,
  type Dependencies,
  DependenciesSchema,
  type ProjectionState,
} from "@agentplugged/protocol";
import { liftsBlocks } from "../checkpoints/resolution-rules.js";
import type { CommandContext } from "../command.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { ARCHITECTURE_PATH, isBlobOf } from "../phases/design-review.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";

/**
 * The dependencies the approved architecture declares: what « planned by the
 * architecture » means, written in the document and never guessed. The engine reads
 * `.agentplugged/docs/architecture.md` on the **main branch** only, and only when that very
 * version is the one a checkpoint the creator approved cited (`documents[].blob_sha`): an
 * architecture edited after its approval declares nothing, an agent's working copy declares nothing.
 */

/** True when `path` names the architecture document, as a checkpoint may cite it. */
function isArchitecture(path: string): boolean {
  return path.replaceAll("\\", "/").toLowerCase().endsWith("docs/architecture.md");
}

/**
 * The text of the approved architecture on the main branch, or undefined: no main branch, no
 * architecture there, a version no approved checkpoint cites. What the declared dependencies (story
 * 3.20) and the checkable decisions are read from.
 */
export async function approvedArchitecture(
  context: CommandContext,
  state: ProjectionState["state"],
): Promise<string | undefined> {
  const reader = context.mainBranch;
  if (reader === undefined) return undefined;
  const read = await reader.read(ARCHITECTURE_PATH).catch(() => undefined);
  if (read?.found !== true || read.text === undefined) return undefined;
  const bytes = utf8(read.text);
  const checkpoints = (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
  const approved = Object.values(checkpoints).some(
    (checkpoint) =>
      checkpoint.status === "resolved" &&
      checkpoint.resolution !== null &&
      liftsBlocks(checkpoint.resolution.decision) &&
      // Proved by the creator (the terminal, the form, or the hook), about a document or a phase end:
      // an answer written without proof, or by the engine itself, declares nothing.
      checkpoint.resolution.assurance !== "chat_unverified" &&
      checkpoint.resolution.assurance !== "system" &&
      checkpoint.resolution.assurance !== "agent" &&
      (checkpoint.type === "document" || checkpoint.type === "phase_end") &&
      checkpoint.documents.some(
        (document) => isArchitecture(document.path) && isBlobOf(document.blob_sha, bytes),
      ),
  );
  return approved ? read.text : undefined;
}

/**
 * The declared dependencies of the approved architecture on the main branch, or undefined: no
 * approved architecture, no valid `dependencies` in its header.
 */
export async function plannedDependencies(
  context: CommandContext,
  state: ProjectionState["state"],
): Promise<Dependencies | undefined> {
  const text = await approvedArchitecture(context, state);
  if (text === undefined) return undefined;
  const parsed = parseDocumentFile(ARCHITECTURE_PATH, text);
  if (parsed.header === undefined) return undefined;
  const declared = (parsed.header as Record<string, unknown>)[ARCHITECTURE_DEPENDENCIES_FIELD];
  const checked = DependenciesSchema.safeParse(declared);
  return checked.success ? checked.data : undefined;
}
