import type { AgentFrontmatter } from "@agentplugged/protocol";
import { METHOD_DIR } from "../init/layout.js";
import type { Definition } from "../method/definitions.js";

/**
 * Developers: an agent of the `code` domain that carries a specialty
 * (`metadata.specialty`): the method's (`sam`, `ethan`, `hugo`, `lina`, `jade`) or one of the
 * creator's (an `embedded` developer…). A developer is never cloned: each story it builds is an
 * instance of it, named by the pair (developer, story), in its own worktree.
 */
export function isDeveloper(definition: Definition): boolean {
  if (definition.kind !== "agent") return false;
  const metadata = (definition.frontmatter as AgentFrontmatter).metadata;
  return metadata?.domain === "code" && typeof metadata.specialty === "string";
}

/** Why a customisation `<id>.yaml` names no agent. */
export function orphanReason(id: string): string {
  return `no agent "${id}" in ${METHOD_DIR}/agents/`;
}
