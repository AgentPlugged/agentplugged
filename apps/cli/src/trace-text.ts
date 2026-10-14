import type {
  Deviation,
  RequirementTrace,
  TraceDetail,
  TraceOverview,
  TraceResult,
  TraceTests,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";
import { displayText, localDateTime, pushList } from "./history-text.js";

/** Longest requirement text shown on one line of the overview. */
const MAX_TEXT = 90;

/** A text from a document or an agent, on one line, without control characters, cut. */
function oneLine(text: string, max = MAX_TEXT): string {
  const flat = displayText(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function testsNote(t: Translate, tests: TraceTests): string[] {
  if (tests.status === "unavailable") return [t("trace.tests.unavailable")];
  if (tests.status === "truncated") return [t("trace.tests.truncated")];
  return [];
}

/** A deviation on two lines (three when resolved): its id, story, requirements and summary. */
function deviationLines(t: Translate, deviation: Deviation): string[] {
  const head = t(deviation.pr === null ? "trace.deviation" : "trace.deviation.pr", {
    id: deviation.id,
    story: displayText(deviation.story),
    requirements: deviation.requirements.map(displayText).join(", "),
    summary: oneLine(deviation.summary, 160),
    pr: deviation.pr ?? 0,
  });
  const lines = [
    head,
    t("trace.deviation.reported", {
      at: localDateTime(deviation.reported_at),
      by: displayText(deviation.reported_by),
    }),
  ];
  if (deviation.detail !== null) {
    for (const line of deviation.detail.split(/\r?\n/)) lines.push(`      ${oneLine(line, 400)}`);
  }
  if (deviation.commit !== null) {
    lines.push(t("trace.deviation.commit", { commit: displayText(deviation.commit) }));
  }
  if (deviation.resolved !== null) {
    lines.push(
      t("trace.deviation.resolved", {
        at: localDateTime(deviation.resolved.at),
        by: displayText(deviation.resolved.by),
        reason: oneLine(deviation.resolved.reason, 160),
      }),
    );
  }
  return lines;
}

function overviewText(t: Translate, result: TraceOverview): string {
  const lines: string[] = [];
  if (result.requirements.length === 0) {
    lines.push(t("trace.empty"));
  } else {
    lines.push(t("trace.title", { count: result.requirements.length }));
    for (const requirement of result.requirements) {
      lines.push(
        t("trace.row", {
          id: requirement.id,
          status: t(`trace.status.${requirement.status}`),
          text: oneLine(requirement.text),
        }),
      );
      lines.push(
        t("trace.row.links", {
          stories:
            requirement.stories.length === 0
              ? t("trace.none")
              : requirement.stories.map(displayText).join(", "),
          tests: requirement.tests ?? "?",
          pull_requests: requirement.pull_requests,
          deviations: requirement.deviations,
        }),
      );
    }
    lines.push(t("trace.counts", result.counts));
  }
  if (result.deviations.length > 0) {
    lines.push(t("trace.deviations.title", { count: result.deviations.length }));
    for (const deviation of result.deviations) lines.push(...deviationLines(t, deviation));
    lines.push(t("trace.resolve.hint"));
  }
  lines.push(...testsNote(t, result.tests));
  if (result.requirements.length > 0) lines.push(t("trace.hint"));
  return `${lines.join("\n")}\n`;
}

function requirementText(t: Translate, requirement: RequirementTrace, tests: TraceTests): string {
  const lines = [
    t(requirement.retired ? "trace.requirement.retired" : "trace.requirement", {
      id: requirement.id,
      status: t(`trace.status.${requirement.status}`),
    }),
  ];
  if (requirement.text.trim() !== "") lines.push(`    ${oneLine(requirement.text, 400)}`);
  lines.push(
    t("trace.requirement.defined", {
      path: displayText(requirement.path),
      line: requirement.line,
    }),
  );
  pushList(
    lines,
    t,
    requirement.stories,
    { none: "trace.stories.none", title: "trace.stories.title" },
    (story) =>
      t("trace.story", {
        id: displayText(story.id),
        status: t(`trace.story_status.${story.status}`),
        title: story.title === null ? "" : oneLine(story.title),
      }).trimEnd(),
  );
  if (tests.status === "unavailable") lines.push(t("trace.tests.unavailable"));
  else if (requirement.tests.length === 0) lines.push(t("trace.tests.none"));
  else {
    lines.push(t("trace.tests.title", { count: requirement.tests.length }));
    for (const test of requirement.tests) {
      lines.push(
        test.line === 0
          ? t("trace.test.name", { path: displayText(test.path) })
          : t("trace.test", { path: displayText(test.path), line: test.line }),
      );
    }
    if (tests.status === "truncated") lines.push(t("trace.tests.truncated"));
  }
  pushList(
    lines,
    t,
    requirement.pull_requests,
    { none: "trace.prs.none", title: "trace.prs.title" },
    (pr) =>
      t("trace.pr", { number: pr.number, story: displayText(pr.story), url: displayText(pr.url) }),
  );
  pushList(
    lines,
    t,
    requirement.deviations,
    { none: "trace.requirement.deviations.none", title: "trace.requirement.deviations.title" },
    (deviation) => [
      ...deviationLines(t, deviation).map((line) => `  ${line}`),
      `    ${t(`trace.deviation.status.${deviation.status}`)}`,
    ],
  );
  if (requirement.deviations.some((deviation) => deviation.status === "open")) {
    lines.push(t("trace.resolve.hint"));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * What `trace` shows: every requirement with its status and its links, the counts and
 * the open deviations; one requirement with its stories, tests, pull requests and deviations; or
 * the resolution written. Every text from a document, the journal or an agent goes through
 * `displayText`.
 */
export function formatTrace(t: Translate, result: TraceResult): string {
  if (result.action === "overview") return overviewText(t, result);
  if (result.action === "requirement") {
    return requirementText(t, (result as TraceDetail).requirement, result.tests);
  }
  return `${t("trace.resolved", {
    id: result.deviation,
    story: displayText(result.story),
    summary: oneLine(result.summary, 160),
  })}\n`;
}

/** `trace --json`: the result as data, values exact. */
export function traceJson(result: TraceResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}
