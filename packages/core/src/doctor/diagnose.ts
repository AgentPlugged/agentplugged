import { PrerequisiteCommandSchema } from "@agentplugged/protocol";
import { z } from "zod";
import type { CommandContext } from "../command.js";
import type { CatalogCheck, DoctorCatalog, Signature } from "./catalog.js";
import { fillText, type Localized } from "./fixes.js";
import { stepsOnly } from "./prerequisites.js";
import { type DoctorItem, evaluateChecks } from "./report.js";

/**
 * The diagnosis of a failure. A command failed and the creator, or an agent, is about
 * to say why. The catalogue's *signatures* recognise what the failure looks like (an error code of
 * the engine, an exit code, a piece of the message) and name the checks to read on the machine; the
 * engine reads them and keeps apart three things:
 *
 * - `failure`: what the failure shows by itself (« exited with 137 »);
 * - `observed`: what the machine showed when it was read just now (« gh is in C:\\… and Windows
 *   knows that folder, but this program was opened before »);
 * - `assumed`: what is only supposed, and said so.
 *
 * Nothing here accuses: when the machine explains nothing, the cause is « not found », not guessed.
 * The text of the failure is only used to recognise it and to take a program's name or a port out
 * of it, both checked; it is never repeated, never run, never stored.
 */

/** What a failure gives: any of the three. */
export const FailureSchema = z.strictObject({
  /** An error code of the engine (`FORGE_NOT_LINKED`). */
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
    .optional(),
  /** The exit code of the command that failed. */
  exit_code: z.int().min(0).max(255).optional(),
  /** The end of what the command printed. */
  output: z.string().max(20_000).optional(),
});
export type Failure = z.infer<typeof FailureSchema>;

export interface Diagnosis {
  /** The signatures that matched, by id (empty: the failure is not one the catalogue knows). */
  readonly matched: readonly string[];
  /**
   * `found`: the machine shows a cause; `suspected`: it shows a lead that proves nothing by itself;
   * `not_found`: it was read and shows none; `unknown`: the failure is not known.
   */
  readonly cause: "found" | "suspected" | "not_found" | "unknown";
  /** One sentence: the cause, or that none was found. */
  readonly headline: Localized;
  /** What the failure shows by itself. */
  readonly failure: readonly Localized[];
  /** The points read on the machine, the ones that are not fine first. */
  readonly observed: readonly DoctorItem[];
  /** What is only supposed. */
  readonly assumed: readonly Localized[];
  /** The repair, in one sentence, when the machine showed a cause. */
  readonly next?: Localized;
  /** Where to see it all. */
  readonly doctor: Localized;
}

/** Most programs or ports taken out of one failure. */
const MAX_EXTRACTED = 4;

const NAME = "[A-Za-z0-9][A-Za-z0-9._+-]{0,63}";
const COMMAND_PATTERNS = [
  new RegExp(`'(${NAME})' is not recognized as an internal or external command`, "gi"),
  new RegExp(`The term '(${NAME})' is not recognized`, "gi"),
  new RegExp(`(?:^|[\\s:])(${NAME}): (?:command )?not found(?!:\\s*\\S)`, "gim"),
  new RegExp(`command not found: (${NAME})`, "gi"),
  new RegExp(`spawn(?:Sync)? (${NAME}) ENOENT`, "gi"),
];
const PORT_PATTERNS = [
  /\bport[ =:#]*(\d{2,5})\b/gi,
  /(?:\b\d{1,3}(?:\.\d{1,3}){3}|localhost|\[::1?\]|\*):(\d{2,5})\b/gi,
];

function collect(output: string, patterns: readonly RegExp[]): string[] {
  const found: string[] = [];
  for (const pattern of patterns) {
    for (const match of output.matchAll(pattern)) {
      const value = match[1];
      if (value !== undefined && !found.includes(value)) found.push(value);
    }
  }
  return found;
}

/** The programs a failure names, checked as plain command names. */
export function commandsIn(output: string): string[] {
  return collect(output, COMMAND_PATTERNS)
    .filter((name) => PrerequisiteCommandSchema.safeParse(name).success)
    .slice(0, MAX_EXTRACTED);
}

/** The ports a failure names. */
export function portsIn(output: string): number[] {
  return collect(output, PORT_PATTERNS)
    .map(Number)
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65_535)
    .slice(0, MAX_EXTRACTED);
}

function matches(signature: Signature, failure: Failure): boolean {
  const when = signature.when;
  if (when.code !== undefined && failure.code !== undefined && when.code.includes(failure.code)) {
    return true;
  }
  if (
    when.exit_code !== undefined &&
    failure.exit_code !== undefined &&
    when.exit_code.includes(failure.exit_code)
  ) {
    return true;
  }
  const output = failure.output?.toLowerCase();
  return (
    when.output !== undefined &&
    output !== undefined &&
    when.output.some((piece) => output.includes(piece.toLowerCase()))
  );
}

/** The program and the port checks a failure's text asks for, from the catalogue's templates. */
function seenChecks(catalog: DoctorCatalog, matched: readonly Signature[], output: string) {
  const checks: CatalogCheck[] = [];
  const wants = new Set(matched.flatMap((signature) => signature.extract ?? []));
  if (wants.has("command")) {
    for (const name of commandsIn(output)) {
      checks.push({
        ...catalog.templates.seen_tool,
        fix: stepsOnly(catalog.templates.seen_tool.fix),
        id: `seen.tool.${name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-")}`,
        group: "machine",
        detect: { kind: "command", names: [name], version: false },
      });
    }
  }
  if (wants.has("port")) {
    for (const port of portsIn(output)) {
      checks.push({
        ...catalog.templates.seen_port,
        fix: stepsOnly(catalog.templates.seen_port.fix),
        id: `seen.port.${port}`,
        group: "machine",
        detect: { kind: "port", port },
      });
    }
  }
  return checks;
}

/** Worst first: what blocks, then what can improve, then what is fine. */
function byGravity(items: readonly DoctorItem[]): DoctorItem[] {
  const rank = { fail: 0, warn: 1, ok: 2 } as const;
  return [...items].sort((a, b) => rank[a.status] - rank[b.status]);
}

/**
 * Reads on the machine what the failure points to, and says what it found. Only reads. Returns
 * undefined when the machine cannot be looked at here.
 */
export async function diagnoseFailure(
  context: CommandContext,
  catalog: DoctorCatalog,
  failure: Failure,
): Promise<Diagnosis | undefined> {
  if (context.environment === undefined) return undefined;
  const matched = catalog.signatures.filter((signature) => matches(signature, failure));
  const doctor = fillText(catalog.diagnosis.doctor, {});
  if (matched.length === 0) {
    return {
      matched: [],
      cause: "unknown",
      headline: fillText(catalog.diagnosis.unknown, {}),
      failure: [],
      observed: [],
      assumed: [],
      doctor,
    };
  }
  const direct = new Set(matched.flatMap((signature) => signature.read));
  const leads = new Set(matched.flatMap((signature) => signature.lead ?? []));
  const checks = [
    ...catalog.checks.filter((check) => direct.has(check.id) || leads.has(check.id)),
    ...seenChecks(catalog, matched, failure.output ?? ""),
  ];
  const observed = byGravity(await evaluateChecks(context, checks));
  // A cause needs a finding that names it: not a check read only as a lead for this failure, not a
  // finding that is weak by nature, and not a reading that could not be made or explains nothing.
  const weak = new Set(
    catalog.checks.filter((check) => check.weak === true).map((check) => check.id),
  );
  const lead = observed.find((item) => item.status !== "ok" && item.outcome !== "unreadable");
  const worst = observed.find(
    (item) =>
      item.status !== "ok" &&
      !weak.has(item.id) &&
      !(leads.has(item.id) && !direct.has(item.id)) &&
      item.outcome !== "unreadable" &&
      item.outcome !== "refused",
  );
  const assumed = matched.flatMap((signature) => (signature.assumed ? [signature.assumed] : []));
  // The repair is only offered for a cause found, never for a lead.
  const firstStep = worst?.fix?.steps;
  return {
    matched: matched.map((signature) => signature.id),
    cause: worst !== undefined ? "found" : lead !== undefined ? "suspected" : "not_found",
    headline:
      worst === undefined && lead !== undefined
        ? {
            en: fillText(catalog.diagnosis.suspected, { text: lead.text.en }).en,
            fr: fillText(catalog.diagnosis.suspected, { text: lead.text.fr }).fr,
          }
        : worst === undefined
          ? fillText(
              observed.length === 0 ? catalog.diagnosis.nothing : catalog.diagnosis.not_found,
              {
                count: String(observed.length),
              },
            )
          : {
              en: fillText(catalog.diagnosis.found, { text: worst.text.en }).en,
              fr: fillText(catalog.diagnosis.found, { text: worst.text.fr }).fr,
            },
    failure: matched.map((signature) => fillText(signature.say, {})),
    observed,
    assumed: assumed.map((text) => fillText(text, {})),
    ...(firstStep?.en[0] === undefined
      ? {}
      : { next: { en: firstStep.en[0], fr: firstStep.fr[0] ?? firstStep.en[0] } }),
    doctor,
  };
}
