import { METHOD_DIR } from "../init/layout.js";
import type { ProjectScan } from "./scan.js";

/** The project profile: one short file, committed, written by the engine. */
export const PROFILE_PATH = `${METHOD_DIR}/profile.md`;

/** Most lines the generated sections may take: the profile is read by every developer. */
export const PROFILE_MAX_LINES = 60;

/** A concept that has one owner module, declared by the team and kept in the profile. */
export interface SingleSource {
  readonly concept: string;
  /** A file, or a folder (ending with `/`), that alone holds the concept. */
  readonly owner: string;
  readonly rule: string;
}

/** What a refresh keeps of the file: the parts people and agents wrote. */
export interface KeptProfile {
  readonly sources: readonly SingleSource[];
  /** Where the acceptance run happens (empty: not decided yet). */
  readonly acceptance: string;
  readonly notes: string;
}

/** The places an acceptance run can happen: on the creator's machine or on a staging environment. */
export const ACCEPTANCE_PLACES = ["local", "staging"] as const;
export type AcceptancePlace = (typeof ACCEPTANCE_PLACES)[number];

/** The acceptance section for a place and how to reach it (one line each, never a secret). */
export function acceptanceText(place: AcceptancePlace, how: string): string {
  const line = how
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 200);
  return `- Place: ${place}${line === "" ? "" : `\n- How: ${line}`}`;
}

const HEADER =
  "<!-- Written by agentplugged: `npx agentplugged docs profile refresh` rewrites every section but Single sources, Acceptance and Notes. -->";
const SOURCES_HEADING = "## Single sources";
const ACCEPTANCE_HEADING = "## Acceptance";
const NOTES_HEADING = "## Notes";

const cell = (text: string) => text.replace(/[|\r\n]+/g, " ").trim();

/** Rows kept per generated section: the file stays within `PROFILE_MAX_LINES` on a big product. */
const ROW_CAPS = { stack: 5, commands: 10, layout: 2, conventions: 8, advice: 6 } as const;

/** The generated sections of the profile, from what the scan found. */
export function renderProfile(scan: ProjectScan, kept: KeptProfile): string {
  const lines: string[] = [HEADER, "# Project profile", ""];
  const section = (title: string, rows: readonly string[], empty?: string) => {
    if (rows.length === 0 && empty === undefined) return;
    lines.push(`## ${title}`, ...(rows.length === 0 ? [empty as string] : rows), "");
  };
  section(
    "Stack",
    scan.stack.slice(0, ROW_CAPS.stack).map((row) => `- ${row}`),
    "- No code yet: run `npx agentplugged docs profile refresh` once the first story is merged.",
  );
  section(
    "Commands",
    scan.commands
      .slice(0, ROW_CAPS.commands)
      .map((command) => `- ${command.name}: \`${command.command}\` (${command.source})`),
    "- None found in the root manifests.",
  );
  section(
    "Layout",
    scan.layout.slice(0, ROW_CAPS.layout).map((row) => `- ${row}`),
  );
  section(
    "Conventions",
    scan.conventions.slice(0, ROW_CAPS.conventions).map((row) => `- ${row}`),
  );
  section(
    "Advice",
    scan.advice.slice(0, ROW_CAPS.advice).map((item) => `- ${item.advice} Why: ${item.why}`),
  );
  lines.push(SOURCES_HEADING);
  lines.push("One owner per concept: reuse it, never rewrite it elsewhere.");
  lines.push("| Concept | Owner | Rule |", "| --- | --- | --- |");
  for (const source of kept.sources) {
    lines.push(`| ${cell(source.concept)} | ${cell(source.owner)} | ${cell(source.rule)} |`);
  }
  lines.push(
    "",
    ACCEPTANCE_HEADING,
    kept.acceptance === "" ? "(not set)" : kept.acceptance.trimEnd(),
  );
  lines.push("", NOTES_HEADING, kept.notes === "" ? "(none)" : kept.notes.trimEnd(), "");
  return `${lines.join("\n")}`;
}

/** The single sources and the notes of an existing profile (what a refresh must keep). */
export function parseKept(text: string): KeptProfile {
  const body = text.replace(/\r\n/g, "\n");
  const start = body.indexOf(`\n${SOURCES_HEADING}\n`);
  const notesAt = body.lastIndexOf(`\n${NOTES_HEADING}\n`);
  const sources: SingleSource[] = [];
  if (start !== -1) {
    // The table ends at the next heading, whichever section follows it.
    const next = body.indexOf("\n## ", start + 1);
    const end = next === -1 ? body.length : next;
    for (const row of body.slice(start, end).split("\n")) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((part) => part.trim());
      if (cells.length !== 3 || cells[0] === "Concept" || /^-+$/.test(cells[0] as string)) continue;
      const [concept, owner, rule] = cells as [string, string, string];
      if (concept !== "" && owner !== "") sources.push({ concept, owner, rule });
    }
  }
  const acceptanceAt = body.indexOf(`\n${ACCEPTANCE_HEADING}\n`);
  let acceptance = "";
  if (acceptanceAt !== -1) {
    const from = acceptanceAt + ACCEPTANCE_HEADING.length + 2;
    const stop = body.indexOf("\n## ", from);
    acceptance = body.slice(from, stop === -1 ? body.length : stop).trim();
    if (acceptance === "(not set)") acceptance = "";
  }
  const afterNotes = notesAt === -1 ? "" : body.slice(notesAt + NOTES_HEADING.length + 2);
  // Notes run to the next heading of ours (or the end), so a table placed after them is not notes.
  const sourcesAfter = start > notesAt ? afterNotes.indexOf(`\n${SOURCES_HEADING}\n`) : -1;
  let notes = (sourcesAfter === -1 ? afterNotes : afterNotes.slice(0, sourcesAfter)).trim();
  if (notes === "(none)") notes = "";
  return { sources, acceptance, notes };
}

/** The same profile with one single source added or replaced (the concept names it, case apart). */
export function withSource(kept: KeptProfile, source: SingleSource): KeptProfile {
  const same = (candidate: SingleSource) =>
    candidate.concept.toLowerCase() === source.concept.toLowerCase();
  return { ...kept, sources: [...kept.sources.filter((item) => !same(item)), source] };
}
