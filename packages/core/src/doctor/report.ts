import type { ToolId } from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError, unexpected } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { type DetectedTool, detectTools } from "../tools/detect-tools.js";
import {
  type CatalogCheck,
  type DoctorCatalog,
  type Outcome,
  readDoctorCatalog,
} from "./catalog.js";
import { evaluateDetect, foldersNotYetSeen } from "./evaluate.js";
import { fillText, type Localized, type PlannedFix, planFix } from "./fixes.js";
import { type PrerequisiteCheck, prerequisiteChecks, readPrerequisites } from "./prerequisites.js";

/**
 * The report of `doctor`: one line per point, ✓ ready, ⚠ to improve, ✗ blocking, in
 * words anyone reads, each with the repair the catalogue gives for the machine as it is.
 */

export type DoctorStatus = "ok" | "warn" | "fail";

/** One line of the report. */
export interface DoctorItem {
  /** Stable identifier: `git.identity`, `prerequisite.tool.docker`. */
  readonly id: string;
  readonly group: string;
  readonly status: DoctorStatus;
  readonly outcome: Outcome;
  readonly text: Localized;
  /** What can be done about it; absent for a point that is ready or has no repair. */
  readonly fix?: PlannedFix;
}

export interface DoctorReport {
  readonly platform: string;
  readonly groups: readonly { readonly id: string; readonly title: Localized }[];
  readonly items: readonly DoctorItem[];
  readonly counts: { readonly ok: number; readonly warn: number; readonly fail: number };
  /** True when a point is ✗: the product cannot work well until it is repaired. */
  readonly blocking: boolean;
}

export interface DoctorOptions {
  /** Only these checks (to read one again after its repair). */
  readonly only?: readonly string[];
}

/** The tools the product targets, when its `method.yaml` says; undefined otherwise. */
async function targetedByProduct(context: CommandContext): Promise<readonly ToolId[] | undefined> {
  try {
    if (!(await context.files.exists(METHOD_CONFIG_PATH))) return undefined;
    const loaded = await loadMethodConfig(context.files);
    return loaded instanceof AgentPluggedError ? undefined : loaded.config.tools;
  } catch {
    return undefined;
  }
}

export function statusOf(check: CatalogCheck, outcome: Outcome): DoctorStatus {
  if (outcome === "ok") return "ok";
  // Found, or found elsewhere than expected: the engine can use it; never a blocking point.
  if (outcome === "off_path" || outcome === "unreadable" || outcome === "stale") return "warn";
  return check.level;
}

/** The checks of the catalogue and of the architecture's prerequisites, in the catalogue's order. */
export async function environmentChecks(
  context: CommandContext,
  catalog: DoctorCatalog,
): Promise<(CatalogCheck | PrerequisiteCheck)[]> {
  const prerequisites = await readPrerequisites(context.files);
  return [...catalog.checks, ...prerequisiteChecks(catalog, prerequisites)];
}

/** The repository's `.gitattributes`, or undefined. */
async function gitAttributesOf(context: CommandContext): Promise<string | undefined> {
  try {
    return (await context.files.exists(".gitattributes"))
      ? await context.files.readText(".gitattributes")
      : undefined;
  } catch {
    return undefined;
  }
}

/** How `evaluateChecks` words the points. */
export interface EvaluateOptions {
  /** Changes the facts before they are put in a sentence (a support report hides the personal ones). */
  readonly facts?: (
    facts: Readonly<Record<string, string>>,
    check: { readonly id: string },
  ) => Readonly<Record<string, string>>;
  /** Receives the id of every check whose reading failed (it is left out of the points). */
  readonly crashed?: string[];
  /** False: no repair is planned (a report only reads). */
  readonly fixes?: boolean;
}

/**
 * Reads these checks on the machine, whatever their kind: one item each, in the order given. A
 * check that does not apply here (`skipped`, another system) or whose probe crashes is left out.
 */
export async function evaluateChecks(
  context: CommandContext,
  checks: readonly (CatalogCheck | PrerequisiteCheck)[],
  options: EvaluateOptions = {},
): Promise<DoctorItem[]> {
  const probe = context.environment;
  if (probe === undefined) return [];
  const targeted = await targetedByProduct(context);
  let detected: Promise<readonly DetectedTool[]> | undefined;
  const tools = () => {
    detected ??= detectTools(context.tools);
    return detected;
  };
  let unseen: Promise<string[]> | undefined;
  const unseenFolders = () => {
    unseen ??= foldersNotYetSeen(probe);
    return unseen;
  };
  let attributes: Promise<string | undefined> | undefined;
  const readAttributes = () => {
    attributes ??= gitAttributesOf(context);
    return attributes;
  };
  const evaluated = await Promise.all(
    checks
      .filter(
        (check) =>
          check.platforms === undefined || check.platforms.includes(probe.platform as never),
      )
      .map(async (check): Promise<DoctorItem | undefined> => {
        let found: Awaited<ReturnType<typeof evaluateDetect>>;
        try {
          found = await evaluateDetect(check.detect, {
            probe,
            tools,
            targeted,
            attributes: readAttributes,
            unseen: unseenFolders,
          });
        } catch {
          // A probe that crashes leaves its point out: the others are still worth reading.
          options.crashed?.push(check.id);
          return undefined;
        }
        if (found.outcome === "skipped") return undefined;
        const facts = { ...found.facts, ...(("facts" in check ? check.facts : undefined) ?? {}) };
        const sentence = check.say[found.outcome] ?? check.say.ok;
        const status = statusOf(check, found.outcome);
        const fix =
          status === "ok" || options.fixes === false
            ? undefined
            : await planFix(check, found.outcome, facts, probe);
        return {
          id: check.id,
          group: check.group,
          status,
          outcome: found.outcome,
          text: fillText(
            sentence as NonNullable<typeof sentence>,
            options.facts?.(facts, check) ?? facts,
          ),
          ...(fix === undefined ? {} : { fix }),
        };
      }),
  );
  return evaluated.filter((item): item is DoctorItem => item !== undefined);
}

/**
 * Looks at the machine: every check of the catalogue, plus the stack's prerequisites. Never fails
 * for a point that is wrong (that is a line of the report); only when the catalogue or the probe is
 * missing. The checks that only matter after a failure (`routine: false`) are read when `only`
 * names them.
 */
export async function runDoctor(
  context: CommandContext,
  options: DoctorOptions = {},
): Promise<DoctorReport | AgentPluggedError> {
  const probe = context.environment;
  if (probe === undefined) return unexpected("the machine cannot be looked at here");
  const catalog = await readDoctorCatalog(context.method);
  if (catalog instanceof AgentPluggedError) return catalog;
  const all = await environmentChecks(context, catalog);
  const only = options.only === undefined ? undefined : new Set(options.only);
  // A check left out of the usual report comes back when the architecture names its tool (docker).
  const named = new Set(
    (await readPrerequisites(context.files))?.tools?.map((tool) => tool.name.toLowerCase()) ?? [],
  );
  const checks = all.filter((check) =>
    only === undefined
      ? check.routine !== false ||
        (check.with_tool !== undefined && named.has(check.with_tool.toLowerCase()))
      : only.has(check.id),
  );
  const items = await evaluateChecks(context, checks);
  const present = new Set(items.map((item) => item.group));
  const counts = {
    ok: items.filter((item) => item.status === "ok").length,
    warn: items.filter((item) => item.status === "warn").length,
    fail: items.filter((item) => item.status === "fail").length,
  };
  return {
    platform: probe.platform,
    groups: catalog.groups
      .filter((group) => present.has(group.id))
      .map((group) => ({ id: group.id, title: fillText(group.title, {}) })),
    items,
    counts,
    blocking: counts.fail > 0,
  };
}
