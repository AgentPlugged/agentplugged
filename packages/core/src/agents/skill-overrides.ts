import {
  ErrorCode,
  REVIEW_SKILLS,
  SKILL_OVERRIDE_FIELDS,
  type SkillOverride,
  SkillOverrideSchema,
} from "@agentplugged/protocol";
import { parseDocument, stringify } from "yaml";
import { AgentPluggedError } from "../errors.js";
import { GENERATED_HEADER_HASH, normalizeText } from "../init/generated.js";
import { METHOD_DIR, METHOD_GITIGNORE_PATH } from "../init/layout.js";
import { ROOT_FIELD } from "../init/method-config.js";
import type { Definition } from "../method/definitions.js";
import { factLine } from "../sync/agent-render.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { CHARS_PER_TOKEN, listProblems, type Problem, unsafeProblems } from "./workshop-rules.js";

/**
 * Customisations of the skills shipped with the method, one or two files per skill:
 * `<name>.yaml` (the product's, in Git) and `<name>.local.yaml` (one person's, ignored by Git,
 * applied last). `init` never touches them. A skill the creator made is edited directly.
 *
 * The product's file is merged into the skill's rendered `SKILL.md` by `sync`, for every tool; the
 * method shipped is never written. The personal file is checked by `sync` too, but never rendered:
 * the generated files are shared through Git, so a personal layer is read when the skill runs
 * (the rule « Rules for skills and agents » says so).
 */
export const SKILL_OVERRIDES_DIR = `${METHOD_DIR}/overrides/skills`;

const SHARED_EXTENSION = ".yaml";
const PERSONAL_EXTENSION = ".local.yaml";

export type SkillLayer = "shared" | "personal";

export function skillOverridePath(name: string, layer: SkillLayer = "shared"): string {
  return `${SKILL_OVERRIDES_DIR}/${name}${layer === "shared" ? SHARED_EXTENSION : PERSONAL_EXTENSION}`;
}

/** The longest text a customisation adds to a skill once rendered: it is loaded each time it runs. */
export const SECTION_CAP = 3_000;

/** The longest file of customisation, and the longest file a customisation loads (`file:` fact, model). */
export const FILE_CAP = 20_000;
export const LOADED_FILE_CAP = 4_000;

/** True for the person's own layer (`<name>.local.yaml`): never rendered, never in Git. */
export function isPersonalLayerFile(fileName: string): boolean {
  return fileName.endsWith(PERSONAL_EXTENSION);
}

/** The line of `.agentplugged/.gitignore` that keeps the personal layers out of Git. */
export const PERSONAL_IGNORE = "overrides/skills/*.local.yaml";

/** The two layers of one skill, each validated. */
export interface SkillLayers {
  readonly shared?: SkillOverride;
  readonly personal?: SkillOverride;
}

// ---------------------------------------------------------------------------------------------
// Reading

const CUSTOMISABLE = SKILL_OVERRIDE_FIELDS.join(", ");

function problem(field: string, detail: string): Problem {
  return { rule: "override_invalid", field, detail };
}

/**
 * A customisation read from its text: the fields, or everything wrong with it at once. A file
 * holding only comments is an empty customisation.
 */
export function parseSkillOverride(raw: string): SkillOverride | Problem[] {
  // A customisation fits in a few thousand characters: a file far beyond that is not one.
  if (raw.length > FILE_CAP) {
    return [problem(ROOT_FIELD, `${raw.length} characters, at most ${FILE_CAP} in a file`)];
  }
  const document = parseDocument(normalizeText(raw), { uniqueKeys: true });
  const syntaxError = document.errors[0];
  if (syntaxError) {
    return [problem(ROOT_FIELD, syntaxError.message.split("\n")[0] ?? syntaxError.code)];
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    // An alias (`*a`) that expands a file into a flood of lines: refused, not followed.
    return [problem(ROOT_FIELD, error instanceof Error ? error.message : "unreadable YAML")];
  }
  const result = SkillOverrideSchema.safeParse(value ?? {});
  if (result.success) return result.data;
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const issue of result.error.issues) {
    const keys = issue.code === "unrecognized_keys" ? issue.keys : undefined;
    const items =
      keys === undefined
        ? [problem(issue.path.length > 0 ? issue.path.join(".") : ROOT_FIELD, issue.message)]
        : keys.map((key) =>
            problem(
              [...issue.path, key].join("."),
              `cannot be customised here (customisable: ${CUSTOMISABLE})`,
            ),
          );
    for (const item of items) {
      const id = `${item.field}|${item.detail}`;
      if (seen.has(id)) continue;
      seen.add(id);
      problems.push(item);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Merging

function appended(...lists: Array<readonly string[] | undefined>): string[] {
  return [...new Set(lists.flatMap((list) => list ?? []))];
}

/**
 * Two layers into one, the later on top: the lists are added after the earlier one's (a line
 * already there is kept once), `when_done` and `output_model` of the later replace the earlier
 * ones, a reviewer with the name of an earlier one replaces it in place and a new name is added at
 * the end. Nothing is ever removed.
 */
export function mergeSkillOverrides(base: SkillOverride, top: SkillOverride): SkillOverride {
  const reviewers = [...(base.reviewers ?? [])].map(
    (item) => (top.reviewers ?? []).find((other) => other.name === item.name) ?? item,
  );
  const known = new Set(reviewers.map((item) => item.name));
  for (const item of top.reviewers ?? []) if (!known.has(item.name)) reviewers.push(item);
  const facts = appended(base.facts, top.facts);
  const before = appended(base.steps_before, top.steps_before);
  const after = appended(base.steps_after, top.steps_after);
  const checks = appended(base.checks, top.checks);
  const done = top.when_done ?? base.when_done;
  const template = top.output_model ?? base.output_model;
  return {
    ...(facts.length > 0 ? { facts: facts } : {}),
    ...(before.length > 0 ? { steps_before: before } : {}),
    ...(after.length > 0 ? { steps_after: after } : {}),
    ...(checks.length > 0 ? { checks } : {}),
    ...(done === undefined ? {} : { when_done: done }),
    ...(template === undefined ? {} : { output_model: template }),
    ...(reviewers.length > 0 ? { reviewers } : {}),
  };
}

/** The customisation of both layers, the personal one on top. */
export function mergedLayers(layers: SkillLayers): SkillOverride {
  return mergeSkillOverrides(layers.shared ?? {}, layers.personal ?? {});
}

// ---------------------------------------------------------------------------------------------
// Rendering

/**
 * The section appended to the skill's `SKILL.md` for the product's customisation; empty when it
 * adds nothing. Fixed English labels, like every generated instruction file.
 */
export function renderSkillCustomisation(name: string, override: SkillOverride): string {
  const numbered = (lines: readonly string[]) =>
    lines.map((line, index) => `${index + 1}. ${line.replace(/\n/g, "\n   ")}`).join("\n");
  const blocks: string[] = [];
  const add = (title: string, body: string) => blocks.push(`### ${title}\n\n${body}`);
  if (override.facts?.length) {
    add("Facts", override.facts.map(factLine).join("\n"));
  }
  if (override.steps_before?.length) add("Before the first step", numbered(override.steps_before));
  if (override.steps_after?.length) add("After the last step", numbered(override.steps_after));
  if (override.checks?.length) {
    add("Also verify before you end", override.checks.map((line) => `- ${line}`).join("\n"));
  }
  if (override.output_model !== undefined) {
    add(
      "Model of the output",
      `Load \`${override.output_model}\` (from the project root) and use it as the model of what this skill produces; where it differs from the skill's own model, follow it.`,
    );
  }
  if (override.reviewers?.length) {
    add(
      "Reviewers of this product",
      [
        "Start each one as one more reviewer, on the same material as your others; fold its findings into your report in the form the skill asks, each tagged with its name. It changes nothing.",
        ...override.reviewers.map((item) => `- **${item.name}**: ${item.instruction}`),
      ].join("\n"),
    );
  }
  if (override.when_done !== undefined) add("When done", `- ${override.when_done}`);
  if (blocks.length === 0) return "";
  return [
    "## Product customisation",
    `From \`${skillOverridePath(name)}\`. These lines add to the skill above; they lift none of its rules, none of AGENTS.md and not what the creator says now.`,
    ...blocks,
  ].join("\n\n");
}

/** `text` with the product's customisation after it; unchanged when there is none. */
export function withCustomisation(text: string, section: string | undefined): string {
  if (section === undefined || section === "") return text;
  return `${text.trimEnd()}\n\n${section}\n`;
}

/** What a customisation costs: nothing at every request, and this much each time the skill runs. */
export interface OverrideCost {
  /** Added to the name and description listed at every request: always 0. */
  readonly loaded_tokens: 0;
  readonly section_chars: number;
  readonly section_tokens: number;
  /** The files it names (a `file:` fact, the model of the output), loaded whole when the skill runs. */
  readonly files_chars: number;
  readonly files_tokens: number;
}

const tokensOf = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** The cost of the section alone; `overrideCostWithFiles` adds the files it names. */
export function overrideCost(name: string, layers: SkillLayers): OverrideCost {
  const chars = renderSkillCustomisation(name, mergedLayers(layers)).length;
  return {
    loaded_tokens: 0,
    section_chars: chars,
    section_tokens: tokensOf(chars),
    files_chars: 0,
    files_tokens: 0,
  };
}

/** The files a customisation loads: its `file:` facts and the model of its output. */
function namedFiles(override: SkillOverride): Array<{ field: string; path: string }> {
  const paths: Array<{ field: string; path: string }> = [];
  for (const [index, fact] of (override.facts ?? []).entries()) {
    if (fact.startsWith("file:")) {
      paths.push({ field: `facts.${index}`, path: fact.slice("file:".length).trim() });
    }
  }
  if (override.output_model !== undefined) {
    paths.push({ field: "output_model", path: override.output_model });
  }
  return paths;
}

/** The cost with the weight of the files the customisation names, which the skill loads whole. */
export async function overrideCostWithFiles(
  files: WorkspaceFiles,
  name: string,
  layers: SkillLayers,
): Promise<OverrideCost> {
  const cost = overrideCost(name, layers);
  let total = 0;
  const seen = new Set<string>();
  for (const { path } of namedFiles(mergedLayers(layers))) {
    if (seen.has(path)) continue;
    seen.add(path);
    try {
      total += (await files.readText(path)).length;
    } catch {
      // A file that cannot be read is refused elsewhere, with its name.
    }
  }
  return { ...cost, files_chars: total, files_tokens: tokensOf(total) };
}

// ---------------------------------------------------------------------------------------------
// Checking

/**
 * A file no instruction may load into a session: keys, certificates, the folders and files where
 * tools keep credentials, and the like. A floor: the engine's own detector of sensitive paths
 * judges what a change touches, this one judges what a customisation may load.
 */
const SECRET_FILE =
  /(?:^|\/)(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore|jks|tfstate)|id_(?:rsa|dsa|ecdsa|ed25519)|\.npmrc|\.netrc|\.pgpass|\.mcp\.json|credentials(?:\..*)?|secrets?\.[a-z0-9]+)$|(?:^|\/)\.(?:ssh|aws|gnupg|kube|docker|azure|config\/gcloud)(?:\/|$)/i;

function textsOf(override: SkillOverride): Array<{ field: string; text: string }> {
  const texts: Array<{ field: string; text: string }> = [];
  const list = (field: string, lines: readonly string[] | undefined) => {
    for (const [index, text] of (lines ?? []).entries())
      texts.push({ field: `${field}.${index}`, text });
  };
  // A `file:` fact names a file: it is checked as a path and by what the file says, below.
  list(
    "facts",
    (override.facts ?? []).map((fact) => (fact.startsWith("file:") ? "" : fact)),
  );
  list("steps_before", override.steps_before);
  list("steps_after", override.steps_after);
  list("checks", override.checks);
  if (override.when_done !== undefined)
    texts.push({ field: "when_done", text: override.when_done });
  for (const [index, item] of (override.reviewers ?? []).entries()) {
    texts.push({ field: `reviewers.${index}.instruction`, text: item.instruction });
  }
  return texts.filter((entry) => entry.text !== "");
}

/**
 * Everything wrong with one layer, at once: an instruction that goes round a rule, the creator's
 * word, a secret or the main branch (the workshop's rules) in its lines and in the
 * files it loads; a file that does not exist, is a folder, holds secrets or is longer than
 * `LOADED_FILE_CAP`; a reviewer on a skill that is not a review.
 */
export async function layerProblems(
  files: WorkspaceFiles,
  name: string,
  override: SkillOverride,
): Promise<Problem[]> {
  const problems = unsafeProblems(textsOf(override));
  for (const { field, path } of namedFiles(override)) {
    if (SECRET_FILE.test(path)) {
      problems.push({
        rule: "unsafe_instruction",
        field,
        detail: `${path} holds secrets: no instruction loads it`,
      });
      continue;
    }
    if (!(await files.exists(path))) {
      problems.push({ rule: "reference_unknown", field, detail: `${path} is not in the product` });
      continue;
    }
    if ((await files.listFiles(path)).length > 0) {
      problems.push(problem(field, `${path} is a folder: name a file`));
      continue;
    }
    let text: string;
    try {
      text = await files.readText(path);
    } catch {
      problems.push(problem(field, `${path} cannot be read as text`));
      continue;
    }
    if (text.includes("\u0000")) {
      problems.push(problem(field, `${path} is not a text file`));
    } else if (text.length > LOADED_FILE_CAP) {
      problems.push({
        rule: "override_too_large",
        field,
        detail: `${path} has ${text.length} characters, at most ${LOADED_FILE_CAP}: the skill loads it whole each time it runs`,
      });
    } else {
      // What the file tells the agent is judged like a line of the customisation.
      for (const found of unsafeProblems([{ field, text }])) {
        problems.push({ ...found, detail: `in ${path}: ${found.detail}` });
      }
    }
  }
  if ((override.reviewers?.length ?? 0) > 0 && !REVIEW_SKILLS.includes(name)) {
    problems.push(
      problem("reviewers", `"${name}" is not a review (reviews: ${REVIEW_SKILLS.join(", ")})`),
    );
  }
  return problems;
}

/**
 * What is wrong with the two layers together: the section once rendered is over the ceiling, or
 * the person's layer gives a reviewer the product's layer already has (it would silence it).
 */
export function layersProblems(name: string, layers: SkillLayers): Problem[] {
  const problems: Problem[] = [];
  const size = renderSkillCustomisation(name, mergedLayers(layers)).length;
  if (size > SECTION_CAP) {
    problems.push({
      rule: "override_too_large",
      field: ROOT_FIELD,
      detail: `${size} characters once rendered, at most ${SECTION_CAP}: it is loaded each time the skill runs, shorten it`,
    });
  }
  const shared = new Set((layers.shared?.reviewers ?? []).map((item) => item.name));
  for (const [index, item] of (layers.personal?.reviewers ?? []).entries()) {
    if (shared.has(item.name)) {
      problems.push(
        problem(
          `reviewers.${index}.name`,
          `"${item.name}" is already a reviewer of the product: a personal layer adds, it never replaces`,
        ),
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Loading

export function skillOverrideRefused(
  path: string,
  problems: readonly Problem[],
): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.OVERRIDE_INVALID, "error.skill_override_refused", {
    path,
    count: problems.length,
    problems: listProblems(problems),
  });
}

/** `<name>.yaml` or `<name>.local.yaml` directly in the folder; anything else is ignored. */
function fileOf(path: string): { name: string; layer: SkillLayer } | undefined {
  const file = path.slice(SKILL_OVERRIDES_DIR.length + 1);
  if (file.includes("/")) return undefined;
  if (file.endsWith(PERSONAL_EXTENSION)) {
    return { name: file.slice(0, -PERSONAL_EXTENSION.length), layer: "personal" };
  }
  if (file.endsWith(SHARED_EXTENSION)) {
    return { name: file.slice(0, -SHARED_EXTENSION.length), layer: "shared" };
  }
  return undefined;
}

/**
 * Every customisation of `.agentplugged/overrides/skills/`, validated, by skill name. Refused, with
 * everything wrong listed at once: a file that names no skill of `.agentplugged/skills/`, a file
 * for one of the creator's own skills (their files are edited directly), a text that goes round a
 * rule, a file that does not exist, a customisation over the ceiling once rendered. `shipped` is
 * the names of the skills shipped with the method.
 */
export async function loadSkillOverrides(
  files: WorkspaceFiles,
  definitions: readonly Definition[],
  shipped: ReadonlySet<string>,
): Promise<Map<string, SkillLayers> | AgentPluggedError> {
  const skills = new Set(definitions.filter((d) => d.kind === "skill").map((d) => d.name));
  const result = new Map<string, SkillLayers>();
  for (const path of await files.listFiles(SKILL_OVERRIDES_DIR)) {
    const found = fileOf(path);
    if (found === undefined) continue;
    const { name, layer } = found;
    if (!skills.has(name)) {
      return new AgentPluggedError(ErrorCode.OVERRIDE_INVALID, "error.skill_override_orphan", {
        path,
        id: name,
      });
    }
    if (!shipped.has(name)) {
      return new AgentPluggedError(ErrorCode.OVERRIDE_INVALID, "error.skill_override_own", {
        path,
        id: name,
      });
    }
    const parsed = await readSkillLayer(files, name, layer);
    if (parsed instanceof AgentPluggedError) return parsed;
    result.set(name, { ...result.get(name), [layer]: parsed });
  }
  for (const [name, layers] of result) {
    const heavy = heavyLayers(name, layers);
    if (heavy instanceof AgentPluggedError) return heavy;
  }
  return result;
}

/** One layer of a skill read from its file and checked; undefined when the file is not there. */
export async function readSkillLayer(
  files: WorkspaceFiles,
  name: string,
  layer: SkillLayer,
): Promise<SkillOverride | undefined | AgentPluggedError> {
  const path = skillOverridePath(name, layer);
  if (!(await files.exists(path))) return undefined;
  const parsed = parseSkillOverride(await files.readText(path));
  if (Array.isArray(parsed)) return skillOverrideRefused(path, parsed);
  const wrong = await layerProblems(files, name, parsed);
  return wrong.length > 0 ? skillOverrideRefused(path, wrong) : parsed;
}

/** The refusal of a customisation over the ceiling once both layers are rendered. */
function heavyLayers(name: string, layers: SkillLayers): undefined | AgentPluggedError {
  const heavy = layersProblems(name, layers);
  if (heavy.length === 0) return undefined;
  return skillOverrideRefused(
    skillOverridePath(name, layers.personal === undefined ? "shared" : "personal"),
    heavy,
  );
}

/** Both layers of one skill, checked as `sync` checks them; the refusal lists everything wrong. */
export async function loadSkillLayers(
  files: WorkspaceFiles,
  name: string,
): Promise<SkillLayers | AgentPluggedError> {
  const shared = await readSkillLayer(files, name, "shared");
  if (shared instanceof AgentPluggedError) return shared;
  const personal = await readSkillLayer(files, name, "personal");
  if (personal instanceof AgentPluggedError) return personal;
  const layers: SkillLayers = {
    ...(shared === undefined ? {} : { shared }),
    ...(personal === undefined ? {} : { personal }),
  };
  return heavyLayers(name, layers) ?? layers;
}

/** The section each skill gets from the product's file, for the skills that have one. */
export function skillSections(overrides: ReadonlyMap<string, SkillLayers>): Map<string, string> {
  const sections = new Map<string, string>();
  for (const [name, layers] of overrides) {
    if (layers.shared === undefined) continue;
    const section = renderSkillCustomisation(name, layers.shared);
    if (section !== "") sections.set(name, section);
  }
  return sections;
}

// ---------------------------------------------------------------------------------------------
// The template `agent edit <skill>` writes

function commented(key: string, value: unknown): string {
  return stringify({ [key]: value }, { lineWidth: 96 })
    .trimEnd()
    .split("\n")
    .map((line) => `# ${line}`)
    .join("\n");
}

/** The commented template of a customisation: every field, commented out, with the merge rules. */
export function renderSkillOverrideTemplate(name: string, layer: SkillLayer): string {
  const personal = layer === "personal";
  const review = REVIEW_SKILLS.includes(name);
  return `${[
    `# Customisation of the skill \`${name}\` ${
      personal
        ? "for you only: this file is ignored by Git and applied after the product's own."
        : "for this product, applied by `npx agentplugged sync` to every AI tool."
    }`,
    "# `init` never touches this file, even when it updates the skill: your changes survive updates.",
    "# Uncomment the fields you want. A customisation adds, it never removes or replaces what the skill says.",
    "#",
    "# Merge rules, applied at every sync (never twice):",
    "# - facts, steps_before, steps_after, checks: your lines are added to the skill;",
    "# - when_done, output_model: one value; yours replaces the product's when both give one;",
    ...(review
      ? [
          "# - reviewers: a reviewer with the name of an earlier one replaces it; a new name is added;",
        ]
      : []),
    "# - a rule of the skill, of AGENTS.md or a hook cannot be lifted here: the engine refuses a line that",
    "#   tells the agent to go round one, and says everything wrong at once.",
    `# - it is loaded each time the skill runs, at most ${SECTION_CAP} characters in all.`,
    "",
    commented("facts", ["A fact about this product.", "file:.agentplugged/docs/facts.md"]),
    commented("steps_before", ["A step run before the skill's first step."]),
    commented("steps_after", ["A step run after the skill's last step."]),
    commented("checks", ["A line the skill verifies before it ends."]),
    commented("when_done", "What the skill does once everything is done."),
    commented("output_model", ".agentplugged/docs/templates/output.md"),
    ...(review
      ? [
          commented("reviewers", [
            { name: "our-rules", instruction: "What this reviewer looks for." },
          ]),
        ]
      : []),
  ].join("\n")}\n`;
}

/**
 * Makes sure Git ignores the personal layers before one is written: `init` writes the line, but a
 * product `init` has not updated since, or whose `.gitignore` was edited by hand, may lack it. The
 * line is added to \`.agentplugged/.gitignore\`; nothing else of the file changes.
 */
export async function ensurePersonalIgnore(files: WorkspaceFiles): Promise<void> {
  const current = (await files.exists(METHOD_GITIGNORE_PATH))
    ? await files.readText(METHOD_GITIGNORE_PATH)
    : undefined;
  if (current?.split(/\r?\n/).some((line) => line.trim() === PERSONAL_IGNORE)) return;
  const kept = current === undefined ? `${GENERATED_HEADER_HASH}\n.cache/\n` : current;
  const eol = kept.includes("\r\n") ? "\r\n" : "\n";
  const body = kept === "" || kept.endsWith("\n") ? kept : `${kept}${eol}`;
  await files.writeText(METHOD_GITIGNORE_PATH, `${body}${PERSONAL_IGNORE}${eol}`);
}

// ---------------------------------------------------------------------------------------------
// What a request the creator approves writes

/** The file the engine writes for an approved customisation: a header, then the fields as given. */
export function renderSkillOverrideFile(
  name: string,
  layer: SkillLayer,
  override: SkillOverride,
): string {
  const header = `# Customisation of the skill \`${name}\` (${
    layer === "personal" ? "yours alone, ignored by Git" : "this product's"
  }), written by the engine from a request you approved. \`npx agentplugged agent edit ${name}\` shows the fields.\n`;
  return Object.keys(override).length === 0
    ? header
    : `${header}${stringify(override, { lineWidth: 96 })}`;
}

/**
 * An approved customisation checked against the product: everything wrong at once (the workshop's
 * rules, the files it names, the ceiling with the other layer), then the layers as they would be and
 * the text of the file. A refusal writes nothing.
 */
export async function checkSkillOverrideRequest(
  files: WorkspaceFiles,
  name: string,
  layer: SkillLayer,
  override: SkillOverride,
): Promise<{ layers: SkillLayers; text: string } | AgentPluggedError> {
  const path = skillOverridePath(name, layer);
  const problems = await layerProblems(files, name, override);
  if (problems.length > 0) return skillOverrideRefused(path, problems);
  const other = await readSkillLayer(files, name, layer === "shared" ? "personal" : "shared");
  if (other instanceof AgentPluggedError) return other;
  const layers: SkillLayers = {
    ...(other === undefined ? {} : { [layer === "shared" ? "personal" : "shared"]: other }),
    [layer]: override,
  };
  const heavy = layersProblems(name, layers);
  if (heavy.length > 0) return skillOverrideRefused(path, heavy);
  return { layers, text: renderSkillOverrideFile(name, layer, override) };
}
