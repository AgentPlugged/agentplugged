import { sha256Hex } from "@agentplugged/crypto";
import { parseDocument } from "yaml";
import { z } from "zod";
import { overlap, significantWords } from "../agents/workshop-rules.js";

/**
 * The cases that evaluate how a skill behaves, pure: their format, their validation
 * and the lint of a rubric that proves nothing. The cases sit next to the skill they judge, in
 * `evals/cases.yaml` (never copied to the AI tools: only `references/`, `scripts/` and `assets/`
 * are), so a skill of the method and a skill of the creator are evaluated the same way.
 *
 * A case is an input, what makes its output good (a rubric read by a judge in a fresh context, and
 * checks the engine makes itself on the answer, the files and the calls), an optional state that
 * puts the skill in the middle of its work, and optional files. Queries say when the skill must be
 * called, and when it must stay quiet.
 */

export const EVALS_DIR = "evals";
export const CASES_FILE = "cases.yaml";
export const REFERENCE_FILE = "reference.json";

/** A fingerprint of the file of cases: a pass says which cases it ran (a case dropped or loosened shows). */
export const casesDigest = (source: string): string =>
  sha256Hex(source.replaceAll("\r\n", "\n")).slice(0, 16);

/** What the format bounds: a file of cases is read by the engine and costs a run each. */
export const LIMITS = {
  cases: 12,
  rubric: 8,
  checks: 8,
  files: 5,
  fileChars: 4_000,
  input: 1_500,
  state: 600,
  queries: 24,
  query: 200,
  rubricItem: 300,
} as const;

/** The most a problem list holds: the creator reads a few lines. */
const MAX_PROBLEMS = 12;

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, {
  message: "1 to 40 lower-case letters, digits and hyphens, starting with a letter or a digit",
});

/** A path inside the case's clean folder: relative, no `..`, never the tool's own folders. */
const casePath = z
  .string()
  .min(1)
  .max(120)
  .refine((path) => isSafePath(path), {
    message:
      "a relative path inside the case's folder (no .., no leading slash, not .git/ or .claude/)",
  });

/** True for a relative path that stays inside the folder it is written in. */
export function isSafePath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || path.includes(":") || path.includes("\0")) {
    return false;
  }
  const parts = path.split("/");
  // A name ending with a dot or a space is read as the name without it on Windows (`.claude.`).
  if (parts.some((part) => part === "" || part === "." || part === ".." || /[. ]$/u.test(part))) {
    return false;
  }
  const first = (parts[0] ?? "").toLowerCase();
  return first !== ".git" && first !== ".claude";
}

const text = (max: number) => z.string().trim().min(1).max(max);

/** What the engine itself checks in an output, without a judge: free, and the same every time. */
export const CheckSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("answer_has"), text: text(200) }),
  z.strictObject({ kind: z.literal("answer_lacks"), text: text(200) }),
  z.strictObject({ kind: z.literal("file_has"), path: casePath, text: text(200) }),
  z.strictObject({ kind: z.literal("file_lacks"), path: casePath, text: text(200) }),
  z.strictObject({ kind: z.literal("tool_called"), name: text(80) }),
  z.strictObject({ kind: z.literal("tool_not_called"), name: text(80) }),
  /** Words in the answer (`of: answer`) or in a file of the case. */
  z
    .strictObject({
      kind: z.literal("words"),
      of: text(120),
      min: z.number().int().min(0).max(100_000).optional(),
      max: z.number().int().min(1).max(100_000).optional(),
    })
    .refine((check) => check.min !== undefined || check.max !== undefined, {
      message: "give min, max or both",
    }),
]);
export type Check = z.infer<typeof CheckSchema>;

const FileSchema = z.strictObject({ path: casePath, text: z.string().max(LIMITS.fileChars) });

export const CaseSchema = z
  .strictObject({
    id,
    input: text(LIMITS.input),
    /** Puts the skill in the middle of its work: prepended to the input, in one message. */
    state: text(LIMITS.state).optional(),
    files: z.array(FileSchema).max(LIMITS.files).default([]),
    rubric: z.array(text(LIMITS.rubricItem)).max(LIMITS.rubric).default([]),
    checks: z.array(CheckSchema).max(LIMITS.checks).default([]),
  })
  .refine((entry) => entry.rubric.length + entry.checks.length > 0, {
    message: "a case needs a rubric or a check: nothing would make it fail",
  });
export type EvalCase = z.infer<typeof CaseSchema>;

export const QuerySchema = z.strictObject({
  query: text(LIMITS.query),
  should_trigger: z.boolean(),
});
export type TriggerQuery = z.infer<typeof QuerySchema>;

/** The thresholds a skill's evaluations hold themselves to; the command may override them. */
export const ThresholdsSchema = z.strictObject({
  /** A case costing more than this many percent over its reference is a regression. */
  cost_growth_pct: z.number().min(0).max(500).default(30),
  /** …but only when the growth is also more than this many tokens (a small case is noisy). */
  cost_floor_tokens: z.number().int().min(0).max(10_000_000).default(2_000),
  /** A case whose pass rate falls by more than this share is a regression. */
  pass_drop: z.number().min(0).max(1).default(0.25),
});
export type Thresholds = z.infer<typeof ThresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = ThresholdsSchema.parse({});

export const CasesFileSchema = z.strictObject({
  cases: z.array(CaseSchema).max(LIMITS.cases).default([]),
  triggers: z.array(QuerySchema).max(LIMITS.queries).default([]),
  thresholds: ThresholdsSchema.optional(),
});
export type CasesFile = z.infer<typeof CasesFileSchema>;

/** What is wrong, where. */
export interface EvalProblem {
  readonly field: string;
  readonly detail: string;
}

const PLACEHOLDER = /\bTODO\b/u;

/** Normal form for comparing two queries. */
const same = (query: string) => query.toLowerCase().replace(/\s+/gu, " ").trim();

/**
 * A rubric line that a wrong output would also pass: existence alone, or a judgement with nothing
 * to measure. A warning: the creator decides, the judge flags it too.
 */
const EXISTENCE_ONLY =
  /^(?:the\s+|le\s+|la\s+)?[\w./-]+\s+(?:exists?|is (?:present|created|there)|existe|est (?:présent|créé))\.?$/iu;
const SUBJECTIVE =
  /\b(?:high[- ]quality|good|great|well[- ]written|professional|nice|clear|clean|bonne?s?|bien écrit|de qualité|professionnel|clair)\b/iu;

export function weakRubricLines(rubric: readonly string[]): number[] {
  const weak: number[] = [];
  for (const [index, line] of rubric.entries()) {
    const measurable = /\d|["'`“«]/u.test(line);
    if (EXISTENCE_ONLY.test(line.trim()) || (SUBJECTIVE.test(line) && !measurable)) {
      weak.push(index);
    }
  }
  return weak;
}

/** What reading a file of cases gives: the cases when nothing is wrong, else what is, and what could be better. */
export interface ReadCases {
  readonly file?: CasesFile;
  readonly problems: readonly EvalProblem[];
  readonly warnings: readonly EvalProblem[];
}

/**
 * Reads and validates `evals/cases.yaml`. Everything wrong is listed at once, a few lines. A
 * `description` is the skill's, to tell a query that could never fire apart from a near miss.
 */
export function readCases(source: string, description?: string): ReadCases {
  const document = parseDocument(source, { uniqueKeys: true });
  const syntax = document.errors[0];
  if (syntax !== undefined) {
    return {
      problems: [{ field: "(file)", detail: syntax.message.split("\n")[0] ?? "invalid" }],
      warnings: [],
    };
  }
  const parsed = CasesFileSchema.safeParse(document.toJS() ?? {});
  if (!parsed.success) {
    const problems = parsed.error.issues.slice(0, MAX_PROBLEMS).map((issue) => ({
      field: issue.path.map(String).join(".") || "(file)",
      detail: issue.message,
    }));
    return { problems, warnings: [] };
  }
  const file = parsed.data;
  const problems: EvalProblem[] = [];
  const warnings: EvalProblem[] = [];
  if (file.cases.length === 0 && file.triggers.length === 0) {
    problems.push({ field: "(file)", detail: "no case and no query: nothing is evaluated" });
  }
  const seen = new Set<string>();
  for (const [index, entry] of file.cases.entries()) {
    const at = `cases.${index}`;
    if (seen.has(entry.id))
      problems.push({ field: `${at}.id`, detail: `"${entry.id}" is used twice` });
    seen.add(entry.id);
    const texts: Array<[string, string]> = [
      [`${at}.input`, entry.input],
      ...(entry.state === undefined
        ? []
        : ([[`${at}.state`, entry.state]] as Array<[string, string]>)),
      ...entry.rubric.map((line, i): [string, string] => [`${at}.rubric.${i}`, line]),
    ];
    for (const [field, value] of texts) {
      if (PLACEHOLDER.test(value)) {
        problems.push({ field, detail: "still a placeholder (TODO): write the real text" });
      }
    }
    const paths = new Set(entry.files.map((file) => file.path));
    if (paths.size !== entry.files.length) {
      problems.push({ field: `${at}.files`, detail: "a path is given twice" });
    }
    for (const index of weakRubricLines(entry.rubric)) {
      warnings.push({
        field: `${at}.rubric.${index}`,
        detail:
          "a wrong output would pass this: state a fact, a number or a thing that must not appear",
      });
    }
    if (
      entry.rubric.length > 0 &&
      entry.checks.length === 0 &&
      entry.rubric.length === weakRubricLines(entry.rubric).length
    ) {
      warnings.push({
        field: `${at}.rubric`,
        detail: "nothing discriminating: every line is weak",
      });
    }
  }
  const queries = new Set<string>();
  for (const [index, entry] of file.triggers.entries()) {
    const at = `triggers.${index}.query`;
    if (PLACEHOLDER.test(entry.query)) {
      problems.push({ field: at, detail: "still a placeholder (TODO): write the real request" });
    }
    if (queries.has(same(entry.query)))
      problems.push({ field: at, detail: "the query is given twice" });
    queries.add(same(entry.query));
  }
  if (file.triggers.length > 0) {
    const fires = file.triggers.filter((entry) => entry.should_trigger).length;
    if (fires === 0) {
      problems.push({
        field: "triggers",
        detail: "no query that must call the skill: firing is not measured",
      });
    }
    if (fires === file.triggers.length) {
      problems.push({
        field: "triggers",
        detail: "no query that must leave it quiet: silence is not measured",
      });
    }
  }
  if (description !== undefined) {
    const known = significantWords(description);
    for (const [index, entry] of file.triggers.entries()) {
      if (!entry.should_trigger && overlap(significantWords(entry.query), known) === 0) {
        warnings.push({
          field: `triggers.${index}.query`,
          detail: "shares no word with the description: too easy, a near miss tests the boundary",
        });
      }
    }
  }
  return {
    ...(problems.length === 0 ? { file } : {}),
    problems: problems.slice(0, MAX_PROBLEMS),
    warnings: warnings.slice(0, MAX_PROBLEMS),
  };
}

/** The message a case sends: its state, then its input (one message, no simulator of turns). */
export function messageOf(entry: Pick<EvalCase, "state" | "input">): string {
  return entry.state === undefined ? entry.input : `[${entry.state}] ${entry.input}`;
}
