import { AgentPluggedError } from "../errors.js";
import { parseDefinition, SKILL_FILE } from "../method/definitions.js";
import type { MethodSource } from "../method/method-source.js";
import { CASES_FILE, casesDigest, EVALS_DIR, REFERENCE_FILE, readCases } from "./eval-cases.js";
import { type Pass, PassSchema } from "./eval-compare.js";
import { digestOf, type SkillUnder } from "./eval-run.js";
import { type Candidate, scoreTriggersByWords } from "./eval-triggers.js";

/**
 * Reading a skill, its cases and its reference from a folder, and what the workshop
 * says of them when it verifies a skill. The folder is the method's or the creator's: the same
 * layout, `<skill>/SKILL.md`, `references/`, `evals/cases.yaml`, `evals/reference.json`.
 */

/** The files of a skill an agent can read: the others (`evals/`, binaries) never reach the run. */
const READABLE = /\.(?:md|txt|ya?ml|json|tmpl)$/iu;
const ANNEXES = ["references/", "scripts/", "assets/"];

export interface Loaded {
  readonly dir: string;
  readonly skill: SkillUnder;
  readonly casesText?: string;
  /** The recorded pass; `error` when the file cannot be read (it is never replaced silently). */
  readonly reference?: Pass | { readonly error: string };
  readonly body: string;
}

/** Loads the skill in `dir` (`<base>/<name>`) from `source`, or says why it cannot. */
export async function loadSkill(
  source: MethodSource,
  dir: string,
): Promise<Loaded | { readonly error: string }> {
  const name = dir.split("/").at(-1) ?? dir;
  const paths = await source.listFiles(dir);
  const inner = paths.map((path) => path.slice(dir.length + 1));
  if (!inner.includes(SKILL_FILE)) return { error: `${dir}/${SKILL_FILE} does not exist` };
  const annexes = inner.filter((path) => ANNEXES.some((annex) => path.startsWith(annex))).sort();
  const parsed = parseDefinition(
    "skill",
    dir,
    name,
    await source.readText(`${dir}/${SKILL_FILE}`),
    annexes,
  );
  if (parsed instanceof AgentPluggedError)
    return { error: `${dir}/${SKILL_FILE}: ${parsed.message}` };
  const files = [{ path: SKILL_FILE, text: parsed.text }];
  for (const path of annexes) {
    if (READABLE.test(path)) files.push({ path, text: await source.readText(`${dir}/${path}`) });
  }
  const casesPath = `${EVALS_DIR}/${CASES_FILE}`;
  const referencePath = `${EVALS_DIR}/${REFERENCE_FILE}`;
  let reference: Loaded["reference"];
  if (inner.includes(referencePath)) {
    try {
      const value = PassSchema.safeParse(
        JSON.parse(await source.readText(`${dir}/${referencePath}`)),
      );
      reference = value.success
        ? value.data
        : { error: `${referencePath}: ${value.error.issues[0]?.message ?? "invalid"}` };
    } catch {
      reference = { error: `${referencePath} is not JSON` };
    }
  }
  return {
    dir,
    skill: {
      name,
      description: (parsed.frontmatter as { description: string }).description,
      files,
    },
    ...(inner.includes(casesPath)
      ? { casesText: await source.readText(`${dir}/${casesPath}`) }
      : {}),
    ...(reference === undefined ? {} : { reference }),
    body: parsed.body,
  };
}

// ---------------------------------------------------------------------------------------------
// The workshop's view

export type ReferenceState = "absent" | "none" | "current" | "stale" | "invalid";

/** What `agent.workshop` `verify` says of a skill's cases. */
export interface EvalStatus {
  readonly cases: number;
  readonly queries: number;
  /** What makes the file unusable: the check fails on it. */
  readonly problems: readonly string[];
  /** What would make a case prove little. */
  readonly warnings: number;
  /** Queries the words of the description do not route as expected (a floor, not the real firing). */
  readonly misrouted: readonly string[];
  /**
   * `absent`: no cases; `none`: cases but no pass kept; `current`: a pass kept for this version of
   * the skill; `stale`: the skill changed since the pass kept (run the evaluation: a regression
   * blocks there); `invalid`: the file cannot be read.
   */
  readonly reference: ReferenceState;
  /** When there are no cases: a start to adapt, never written by the engine. */
  readonly starter?: string;
}

const MAX_LISTED = 3;
const MAX_STARTER = 1_400;

const quoted = (value: string) => JSON.stringify(value.replace(/\s+/gu, " ").trim());

/** The first sentence of a text, cut. */
function firstSentence(text: string, max = 150): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  const end = flat.search(/[.!?](?:\s|$)/u);
  const sentence = end === -1 ? flat : flat.slice(0, end + 1);
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** The lines of a skill's body that say what it must produce or never do, as plain sentences. */
function rubricSources(body: string): string[] {
  const found: string[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*[-*]\s+(?:\*\*)?(?:Output|Never|Rules?)[^:]*:(?:\*\*)?\s*(.+)$/iu.exec(line);
    const bullet = /^\s*[-*]\s+(Never\b.+)$/iu.exec(line);
    const text = (match?.[1] ?? bullet?.[1] ?? "").replace(/[*`]/gu, "").trim();
    if (text.length >= 20)
      found.push(text.length > 200 ? `${text.slice(0, 199).trimEnd()}…` : text);
    if (found.length === 2) break;
  }
  return found;
}

/**
 * Cases proposed for a skill that has none (the workshop shows them for a creation): the phrases
 * the creator expects become queries that must call it, the neighbour whose description is closest
 * supplies a near miss that must not, and a first case takes its rubric from what the skill says
 * it produces or never does. Whatever the engine could not draw stays `TODO`, which the validation
 * refuses: a start to adapt, not cases to keep.
 */
export function suggestStarter(
  skill: Candidate & { readonly body: string },
  expected: readonly string[],
  others: readonly Candidate[],
): string {
  const own = new Set(skill.description.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const closest = others
    .filter((other) => other.name !== skill.name)
    .map((other) => ({
      other,
      shared: (other.description.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((word) =>
        own.has(word),
      ).length,
    }))
    .sort((a, b) => b.shared - a.shared || a.other.name.localeCompare(b.other.name))[0];
  const asked = expected.length > 0 ? expected.slice(0, 2) : [firstSentence(skill.description)];
  const rubric = rubricSources(skill.body);
  const out = [
    `# Cases proposed for ${skill.name}: adapt them, a line left as TODO is refused.`,
    "triggers:",
    ...asked.map((query) => `  - { query: ${quoted(query)}, should_trigger: true }`),
    closest === undefined
      ? '  - { query: "TODO: a request that looks like this skill\'s but belongs to another", should_trigger: false }'
      : `  - { query: ${quoted(firstSentence(closest.other.description))}, should_trigger: false }`,
    "cases:",
    "  - id: first-use",
    `    input: ${quoted(asked[0] ?? "TODO: a realistic request, as the creator would type it")}`,
    "    rubric:",
    ...(rubric.length > 0
      ? rubric.map((line) => `      - ${quoted(`The output respects: ${line}`)}`)
      : ['      - "TODO: a fact the output must hold"']),
    '      - "TODO: something a wrong output would contain and this one must not"',
  ].join("\n");
  return out.length > MAX_STARTER ? `${out.slice(0, MAX_STARTER - 1)}…` : out;
}

/** What the workshop says of a skill's cases and of the pass kept for it. */
export function evalStatus(
  loaded: Loaded,
  others: readonly Candidate[],
  expected: readonly string[] = [],
): EvalStatus {
  const { skill } = loaded;
  if (loaded.casesText === undefined) {
    return {
      cases: 0,
      queries: 0,
      problems: [],
      warnings: 0,
      misrouted: [],
      reference: "absent",
      starter: suggestStarter(
        { name: skill.name, description: skill.description, body: loaded.body },
        expected,
        others,
      ),
    };
  }
  const read = readCases(loaded.casesText, skill.description);
  const file = read.file;
  const candidates = [
    ...others.filter((other) => other.name !== skill.name),
    { name: skill.name, description: skill.description },
  ];
  const misrouted =
    file === undefined
      ? []
      : scoreTriggersByWords(skill.name, file.triggers, candidates)
          .verdicts.filter((verdict) => !verdict.ok)
          .slice(0, MAX_LISTED)
          .map((verdict) => verdict.query);
  let reference: ReferenceState = "none";
  if (loaded.reference !== undefined) {
    if ("error" in loaded.reference) reference = "invalid";
    else {
      const kept = loaded.reference;
      const sameSkill = kept.digest === digestOf(skill.files);
      const sameCases =
        kept.cases_digest === undefined || kept.cases_digest === casesDigest(loaded.casesText);
      reference = sameSkill && sameCases ? "current" : "stale";
    }
  }
  return {
    cases: file?.cases.length ?? 0,
    queries: file?.triggers.length ?? 0,
    problems: read.problems
      .slice(0, MAX_LISTED)
      .map((problem) => `${problem.field}: ${problem.detail}`),
    warnings: read.warnings.length,
    misrouted,
    reference,
  };
}
