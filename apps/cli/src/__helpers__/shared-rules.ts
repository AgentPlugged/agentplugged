import { DEFAULT_RULES, renderConstitutionReference } from "@agentplugged/core";

/**
 * The rules every skill held to (the checkpoint before the question, the click, the
 * points the creator did not keep, « tu », the memory) are written once, in the reference
 * (« Rules for skills and agents », the file `skill-rules`), and each skill points there with this
 * sentence.
 */
export const SHARED_RULES_POINTER =
  'Follow "Rules for skills and agents" (reference `skill-rules`)';

/** The text of « Rules for skills and agents », whitespace folded. */
export function sharedRules(): string {
  const reference = renderConstitutionReference([], DEFAULT_RULES, { tools: ["claude-code"] });
  const start = reference.indexOf("\n## Rules for skills and agents\n");
  if (start === -1) throw new Error("the reference has no « Rules for skills and agents »");
  const end = reference.indexOf("\n## ", start + 1);
  return reference.slice(start, end === -1 ? undefined : end).replace(/\s+/g, " ");
}
