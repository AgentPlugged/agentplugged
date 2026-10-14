/**
 * The documents that hold what another document holds on the short path. A `spec`
 * defines the requirements (`EF-n`, `ENF-n`, `PU-n`, `MS-n`) of the PRD and the decisions (`AD-n`)
 * of the architecture, with the same identifiers, so the trace, the register of the requirements
 * and the checks read it where they read those documents.
 */

/** The kinds of document whose requirements are traced, covered by stories and registered. */
export function holdsRequirements(kind: string | undefined): boolean {
  return kind === "prd" || kind === "spec";
}

/** The kinds of document whose decisions (`AD-n`) state what they bind, prevent and their rule. */
export function holdsDecisions(kind: string | undefined): boolean {
  return kind === "architecture" || kind === "spec";
}
