import { ErrorCode, type ResearchReportReason } from "@agentplugged/protocol";
import type { DocsProblem } from "./docs-base.js";
import { type Section, tableCells } from "./parse-document.js";

/** The tables and problems the research reports share. */

export function problemOf(
  path: string,
  line: number,
  reason: ResearchReportReason,
  details: Record<string, unknown> = {},
): DocsProblem {
  return {
    code: ErrorCode.RESEARCH_REPORT_INVALID,
    message_key: `error.research_report_invalid.${reason}`,
    details: { path, line, reason, ...details },
  };
}

/** A cell as compared: no emphasis or code marks, lowercased, trimmed. */
export const plainCell = (cell: string | undefined): string =>
  (cell ?? "").replaceAll("`", "").replaceAll("*", "").trim().toLowerCase();

export interface Row {
  readonly line: number;
  readonly cells: string[];
}

export const isSeparator = (text: string): boolean =>
  text.includes("|") && tableCells(text).every((cell) => /^:?-{2,}:?$/.test(cell));

/**
 * The data rows of the tables of a section. A table is a run of lines with a pipe: its first line
 * is the header and its second the separator. A run without that header is `broken` (its first line
 * is named): its rows would otherwise slip past every rule.
 */
export function tablesOf(section: Section): { rows: Row[]; broken: number[] } {
  const rows: Row[] = [];
  const broken: number[] = [];
  let run: { text: string; line: number }[] = [];
  const close = () => {
    if (run.length === 0) return;
    if (run.length >= 2 && isSeparator(run[1]?.text ?? "")) {
      for (const entry of run.slice(2)) {
        rows.push({ line: entry.line, cells: tableCells(entry.text) });
      }
    } else {
      broken.push(run[0]?.line ?? section.line);
    }
    run = [];
  };
  section.lines.forEach((text, index) => {
    if (text.includes("|")) run.push({ text, line: section.line + 1 + index });
    else close();
  });
  close();
  return { rows, broken };
}

/** A title as a heading shows it, in each language the section accepts. */
export const headingOf = (titles: readonly string[]): string =>
  titles.map((title) => `## ${title.replace(/^./, (letter) => letter.toUpperCase())}`).join(" / ");
