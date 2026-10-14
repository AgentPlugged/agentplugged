import {
  type CostsFound,
  costsLines,
  type DeckDrawn,
  type DocsCheckResult,
  type ResearchFound,
  type ResearchPlanned,
  researchLines,
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

/** The answer of `docs costs`: estimates, said so, and the break-even point when asked. */
export function formatCostsResult(result: CostsFound): string {
  return `${costsLines(result).join("\n")}\n`;
}
