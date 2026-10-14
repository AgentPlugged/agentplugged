import type { ReviewLens } from "@agentplugged/protocol";
import type { ReaderPass } from "./review-lenses.js";

/**
 * The review as a request that stands alone: the story's criteria (or the intent), the
 * lenses and passes to run, the judge, the shape of the answer and the diff itself, in one text to
 * give to another tool or another model that cannot read the repository. Its answer comes back
 * through `review.submit` as it is. Pure: the commands read the files and write the result.
 */

/** The texts of the review skill's reference files the request carries. */
export interface ExportParts {
  readonly format: string;
  readonly judge: string;
  readonly lens: Readonly<Partial<Record<ReviewLens, string>>>;
  readonly pass: Readonly<Partial<Record<ReaderPass, string>>>;
}

/** The file of the review skill that holds a lens, and a pass. */
export const lensFileOf = (lens: ReviewLens): string => `lens-${lens.replaceAll("_", "-")}.md`;
export const passFileOf = (pass: ReaderPass): string => `pass-${pass}.md`;

/** The longest diff and story text the request carries, in characters. */
export const EXPORT_DIFF_CHARS = 400_000;
export const EXPORT_STORY_CHARS = 30_000;

/**
 * The answer expected, as a skeleton: what `review.submit` takes (the `commit` is the caller's).
 * The security review has no judge.
 */
const skeleton = (judge: boolean) =>
  JSON.stringify({
    summary: "what you looked at",
    lenses: [
      {
        lens: "<lens name>",
        summary: "",
        covered: ["what you checked"],
        findings: [
          {
            severity: "blocking | should_fix | minor",
            title: "",
            evidence: "",
            criterion: null,
            recommendation: "",
            path: "",
            line: 1,
          },
        ],
      },
    ],
    ...(judge
      ? {
          judge: {
            summary: "",
            criteria: [
              { criterion: 1, status: "met | partly | unmet", evidence: "", recommendation: "" },
            ],
            findings: [
              {
                finding: "<lens>#<rank of the finding in that lens's report>",
                status: "confirmed | refuted | undecided",
                severity: "blocking | should_fix | minor",
                evidence: "",
                at: "file:line or a test, for a refutation",
                cause: "story, only if the story itself is wrong",
              },
            ],
            gap: null,
          },
        }
      : {}),
  });

export interface ExportInput {
  /** `Story 3-1: title`, or the free review's source. */
  readonly subject: string;
  /** The numbered acceptance criteria, or the one-sentence intent. */
  readonly criteria: readonly string[];
  readonly story?: string | undefined;
  readonly lenses: readonly ReviewLens[];
  readonly passes: readonly ReaderPass[];
  /** The review has a judge (the quality review does, the security review does not). */
  readonly judge: boolean;
  readonly statements: string;
  readonly diff: string;
  readonly parts: ExportParts;
}

const cut = (text: string, max: number, what: string) =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n# cut at ${max} characters: the ${what} goes on, say so in your summary\n`;

/** A fence longer than any run of backticks in `text`, so that nothing inside can close it. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** The request, as Markdown text. */
export function exportPrompt(input: ExportInput): string {
  const lensBlocks = input.lenses.map(
    (lens) => `### Lens: ${lens}\n\n${(input.parts.lens[lens] ?? "").trim()}`,
  );
  const passBlocks = input.passes.map(
    (pass) => `### Pass: ${pass}\n\n${(input.parts.pass[pass] ?? "").trim()}`,
  );
  const criteria = input.criteria.map((criterion, index) => `${index + 1}. ${criterion}`);
  const diff = cut(input.diff, EXPORT_DIFF_CHARS, "diff");
  const statementsFence = fenceFor(input.statements);
  const diffFence = fenceFor(diff);
  const silent =
    'A lens that gave nothing (you ran out of time) is given as `{"lens": "<name>", "silent": true}` in `lenses`';
  return [
    `# Independent review: ${input.subject}`,
    "",
    "You are an independent reviewer. You cannot run commands nor read anything outside this text, and nobody can answer a question: review once, then answer with one JSON object and nothing else. Write the findings in the language of the criteria below.",
    "",
    "## What the change must do",
    "",
    ...criteria,
    ...(input.story === undefined || input.story.trim() === ""
      ? []
      : ["", "### The story", "", cut(input.story.trim(), EXPORT_STORY_CHARS, "story")]),
    "",
    "## How to review",
    "",
    `Run each lens below on the diff, one report per lens, without reading the others' reports.${input.passes.length === 0 ? "" : " Then run the passes, whose findings go in the report of the lens `verification_gaps`."}${input.judge ? " Then play the judge, last, as a different person who has only the story, the diff and the findings above: if you can, do it in a fresh conversation." : ""}`,
    "",
    ...lensBlocks.flatMap((block) => [block, ""]),
    ...passBlocks.flatMap((block) => [block, ""]),
    ...(input.judge
      ? [
          "### The judge",
          "",
          input.parts.judge.trim(),
          "",
          `Rule on every finding of your lens reports by its name (\`<lens>#<rank>\`, ranks from 1 in each report): \`confirmed\` with the severity it deserves, \`refuted\` with the place that proves it wrong, or \`undecided\`. ${silent}, the judge as \`{"silent": true}\`, never left out silently nor invented.`,
          "",
        ]
      : [`${silent}, never left out silently nor invented.`, ""]),
    "## Shape of the answer",
    "",
    input.parts.format.trim(),
    "",
    "```json",
    skeleton(input.judge),
    "```",
    ...(input.statements.trim() === ""
      ? []
      : [
          "",
          "## Commit messages (what the change says of itself)",
          "",
          statementsFence,
          input.statements.trim(),
          statementsFence,
        ]),
    "",
    "## Diff",
    "",
    `${diffFence}diff`,
    diff,
    diffFence,
    "",
  ].join("\n");
}
