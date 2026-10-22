import {
  type BricksFound,
  type CostsFound,
  costsLines,
  type DeckDrawn,
  type DocsCheckResult,
  type ProfileShown,
  type ResearchFound,
  type ResearchPlanned,
  researchLines,
  type SectionsRead,
  type SheetsWritten,
  type SpecGrowResult,
  type SpecPathResult,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { ErrorCode } from "@agentplugged/protocol";
import { errorMessage } from "./error-text.js";

/** The summary of `docs check`, for stdout: what was checked, and against which base. */
export function formatDocsSummary(t: Translate, root: string, result: DocsCheckResult): string {
  const lines = [t("docs.check.title", { root, count: result.documents })];
  // Without documents in the base, only the "no base" line: it names the reference.
  if (result.base !== null && result.withoutBase === undefined) {
    lines.push(
      t("docs.check.base", { ref: result.base.ref, commit: result.base.commit.slice(0, 12) }),
    );
  }
  if (result.withoutBase !== undefined) {
    lines.push(
      t(`docs.check.without_base.${result.withoutBase}`, { ref: result.base?.ref ?? "HEAD" }),
    );
  }
  if (result.intents.compared > 0) {
    lines.push(t("docs.check.intents", { count: result.intents.compared }));
  }
  // What could not be verified: shown, never failing the check.
  for (const warning of result.warnings) {
    lines.push(t("docs.check.warning", { message: errorMessage(t, warning) }));
  }
  // The problems of a step the creator skipped: warnings, never a failure.
  for (const problem of result.skipped ?? []) {
    lines.push(
      t("docs.check.skipped", {
        path: String(problem.details.path),
        line: String(problem.details.line),
        code: problem.code,
        message: errorMessage(t, problem),
      }),
    );
  }
  if (result.problems.length === 0) lines.push(t("docs.check.ok"));
  return `${lines.join("\n")}\n`;
}

/** The problems of `docs check`, for stderr: one line each, with file and line. */
export function formatDocsProblems(t: Translate, result: DocsCheckResult): string {
  const { problems } = result;
  if (problems.length === 0) return "";
  const title =
    problems.length === 1
      ? t("docs.check.problems.one")
      : t("docs.check.problems.other", { count: problems.length });
  const lines = problems.map(
    (problem) =>
      `  ${t("docs.check.problem", {
        // A removed identifier is gone from the working copy: its place is in the base.
        path:
          problem.code === ErrorCode.REQ_ID_REMOVED
            ? `${problem.details.path}@${String(problem.details.base)}`
            : problem.details.path,
        line: problem.details.line,
        code: problem.code,
        message: errorMessage(t, problem),
      })}`,
  );
  return `${title}\n${lines.join("\n")}\n`;
}

/**
 * The answer of `docs path` and `docs grow`, for stdout: plain `key: value` lines an
 * agent reads, then tells the creator in their own words.
 */
export function formatSpecResult(result: SpecPathResult | SpecGrowResult): string {
  if (result.spec === "path") {
    const { path, risky, asked, reasons } = result.choice;
    return `${[
      `path: ${path}`,
      `risky: ${risky}`,
      `asked: ${asked}`,
      `reasons: ${reasons.length === 0 ? "none" : reasons.join(", ")}`,
    ].join("\n")}\n`;
  }
  return `${[
    ...result.written.map((path) => `written: ${path}`),
    `removed: ${result.removed}`,
    `identifiers: ${result.identifiers.join(", ")}`,
  ].join("\n")}\n`;
}

/** The answer of `docs research`: one line per page already searched, or none. */
export function formatResearchResult(result: ResearchFound | ResearchPlanned): string {
  return `${researchLines(result).join("\n")}\n`;
}

/** The answer of `docs slides`: where the page is, what it holds, the deck's state. */
export function formatDeckDrawn(result: DeckDrawn): string {
  return `${[
    `written: ${result.path}`,
    `slides: ${result.slides}`,
    `notes: ${result.notes}`,
    ...(result.notDrawn.length === 0 ? [] : [`not_drawn: ${result.notDrawn.join(", ")}`]),
    `deck: ${result.deck}`,
  ].join("\n")}\n`;
}

/**
 * The answer of `docs sheet`: one line per story sheet (lines, excerpts, whether written), the
 * citations no document holds, the sheets over the ceiling, and the stories to validate again.
 */
export function formatSheetsWritten(result: SheetsWritten): string {
  const lines = result.sheets.map(
    (sheet) =>
      `${sheet.written ? "written" : "unchanged"}: ${sheet.path} (${sheet.lines} lines, ${sheet.excerpts} excerpts)`,
  );
  for (const sheet of result.sheets) {
    if (sheet.unresolved.length > 0) {
      lines.push(`not_found: ${sheet.story}: ${sheet.unresolved.join(", ")}`);
    }
    if (sheet.too_long) {
      lines.push(`too_long: ${sheet.story}: over ${result.max_lines} lines, cut the story`);
    }
  }
  if (result.revalidate.length > 0) {
    lines.push(`validate_again: ${result.revalidate.join(", ")}`);
  }
  if (result.sheets.length === 0) lines.push("sheets: none");
  return `${lines.join("\n")}\n`;
}

/** The answer of `docs costs`: estimates, said so, and the break-even point when asked. */
export function formatCostsResult(result: CostsFound): string {
  return `${costsLines(result).join("\n")}\n`;
}

/**
 * The answer of `docs read`: each passage under its identifier and document, the outline of a
 * document named alone, the passages left out for want of room, and the selectors no document holds.
 */
export function formatSectionsRead(result: SectionsRead): string {
  const lines: string[] = [];
  for (const found of result.passages) {
    lines.push(`## ${found.id} (${found.source})`, found.text);
    if (found.more > 0) lines.push(`... ${found.more} more lines in ${found.source}`);
  }
  for (const outline of result.outlines) {
    lines.push(`## outline of ${outline.source} (${outline.lines} lines)`);
    for (const section of outline.sections) {
      lines.push(`- ${section.selector} (${section.lines} lines): ${section.title}`);
    }
  }
  if (result.omitted.length > 0) lines.push(`omitted: ${result.omitted.join(", ")}`);
  if (result.not_found.length > 0) lines.push(`not_found: ${result.not_found.join(", ")}`);
  if (lines.length === 0) lines.push("passages: none");
  return `${lines.join("\n")}\n`;
}

/** The answer of `docs profile`: the file as written, and what was done to it. */
export function formatProfileShown(result: ProfileShown): string {
  const { path, state, lines } = result.profile;
  const head =
    state === "created" || state === "refreshed"
      ? `profile ${state}: ${path}`
      : state === "current"
        ? `profile current: ${path}`
        : state === "stale"
          ? `profile stale (the root files say more): ${path}; "docs profile refresh" rewrites it`
          : `no profile yet: "docs profile refresh" writes ${path}`;
  return `${`${head}\n${lines.join("\n")}`.trimEnd()}\n`;
}

/** The answer of `docs bricks`: the bricks that answer the request, or the clear "nothing like it". */
export function formatBricksFound(result: BricksFound): string {
  const { bricks } = result;
  if (bricks.declared !== undefined) {
    return `single source declared: ${bricks.declared.concept} -> ${bricks.declared.owner}\n`;
  }
  const lines: string[] = [];
  for (const source of bricks.sources) {
    const rule = source.rule === "" ? "" : ` (${source.rule})`;
    lines.push(
      `single source "${source.concept}": ${source.owner}${rule} - use it, do not rewrite it`,
    );
  }
  for (const hit of bricks.hits) {
    lines.push(`${hit.kind} ${hit.sig} ${hit.path}:${hit.line}`);
  }
  if (bricks.unavailable !== undefined) {
    lines.push(
      `registry unavailable (${bricks.unavailable}): search the code with your own tools, then decide`,
    );
  } else if (bricks.hits.length === 0 && bricks.sources.length === 0) {
    lines.push(
      `nothing like "${bricks.query.join(" ")}" among ${bricks.searched?.total ?? 0} bricks (commit ${bricks.searched?.commit ?? "?"}): write it, it joins the registry once merged`,
    );
  } else if (bricks.searched !== undefined) {
    lines.push(`(${bricks.searched.total} bricks searched, commit ${bricks.searched.commit})`);
  }
  return `${lines.join("\n")}\n`;
}
