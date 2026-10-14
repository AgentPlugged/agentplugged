import {
  ARCHITECTURE_PREREQUISITES_FIELD,
  type Prerequisites,
  PrerequisitesSchema,
} from "@agentplugged/protocol";
import { parseDocumentFile } from "../docs/parse-document.js";
import { ARCHITECTURE_PATH } from "../phases/design-review.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import type { CatalogCheck, DoctorCatalog } from "./catalog.js";

/**
 * What the stack decided asks of the machine: the architect writes it in the header of
 * the architecture (`prerequisites`: tools with a minimum version, ports, memory) and the catalogue
 * gives the sentences. Nothing about any stack lives in the engine. The header is read from the
 * working copy, as a diagnostic only: it never makes the engine run anything.
 */

/** A check the engine makes up from a prerequisite: the catalogue's template filled in. */
export interface PrerequisiteCheck extends CatalogCheck {
  /** Facts the sentences use besides the detector's (`{why}`). */
  readonly facts?: Readonly<Record<string, string>>;
}

/** The `prerequisites` of the architecture's header, or undefined: none, unreadable, invalid. */
export async function readPrerequisites(files: WorkspaceFiles): Promise<Prerequisites | undefined> {
  try {
    if (!(await files.exists(ARCHITECTURE_PATH))) return undefined;
    const parsed = parseDocumentFile(ARCHITECTURE_PATH, await files.readText(ARCHITECTURE_PATH));
    const declared = (parsed.header as Record<string, unknown> | undefined)?.[
      ARCHITECTURE_PREREQUISITES_FIELD
    ];
    if (declared === undefined) return undefined;
    const checked = PrerequisitesSchema.safeParse(declared);
    return checked.success ? checked.data : undefined;
  } catch {
    return undefined;
  }
}

/** A tool's name as part of a check id (`docker` → `docker`, `Node.js` → `node-js`). */
function idPart(name: string): string {
  const part = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return part === "" ? "tool" : part;
}

/**
 * The templates' steps only: what the architecture names (a tool's name) must never end up in a
 * command the engine would run, so a prerequisite is never repaired by the engine itself.
 */
export function stepsOnly(template: CatalogCheck["fix"]): CatalogCheck["fix"] {
  return template?.map(({ options: _options, ...rest }) => rest);
}

/** The checks a stack's prerequisites ask for, from the catalogue's templates. */
export function prerequisiteChecks(
  catalog: DoctorCatalog,
  prerequisites: Prerequisites | undefined,
): PrerequisiteCheck[] {
  if (prerequisites === undefined) return [];
  const checks: PrerequisiteCheck[] = [];
  const taken = new Set<string>();
  const unique = (id: string) => {
    let candidate = id;
    for (let n = 2; taken.has(candidate); n += 1) candidate = `${id}-${n}`;
    taken.add(candidate);
    return candidate;
  };
  for (const tool of prerequisites.tools ?? []) {
    checks.push({
      ...catalog.templates.tool,
      fix: stepsOnly(catalog.templates.tool.fix),
      id: unique(`prerequisite.tool.${idPart(tool.name)}`),
      group: "prerequisites",
      detect: {
        kind: "command",
        names: [tool.name],
        ...(tool.min === undefined ? {} : { min: tool.min }),
      },
      facts: { why: tool.why ?? "", needed: tool.min ?? "" },
    });
  }
  for (const port of prerequisites.ports ?? []) {
    checks.push({
      ...catalog.templates.port,
      fix: stepsOnly(catalog.templates.port.fix),
      id: unique(`prerequisite.port.${port}`),
      group: "prerequisites",
      detect: { kind: "port", port },
    });
  }
  if (prerequisites.memory_gb !== undefined) {
    checks.push({
      ...catalog.templates.memory,
      fix: stepsOnly(catalog.templates.memory.fix),
      id: unique("prerequisite.memory"),
      group: "prerequisites",
      detect: { kind: "memory", min_gb: prerequisites.memory_gb },
    });
  }
  return checks;
}
