import { z } from "zod";
import { plainLine } from "./agent-content.js";
import { SkillNameSchema } from "./method-config.js";

/**
 * A customisation of a skill shipped with the method: what a product adds to a skill
 * without touching the skill. Two files, the same fields: `.agentplugged/overrides/skills/<name>.yaml`
 * (the product's, in Git) and `<name>.local.yaml` (one person's, ignored by Git, applied last).
 *
 * It can only add: facts, a step before or after the skill's own, lines of verification, a model
 * for the output, an action at the end, a reviewer of the product's own for a review skill. Every
 * text is a plain line (no hidden character, no HTML), checked by the engine for instructions that
 * go round a rule; the skill itself, `AGENTS.md` and the hooks are written elsewhere and cannot be
 * changed here.
 */

/** The ceilings of one customisation, per field: what the creator reads and what the skill loads. */
export const SKILL_OVERRIDE_LIMITS = {
  facts: 8,
  fact: 300,
  steps: 5,
  step: 400,
  checks: 8,
  check: 300,
  done: 400,
  reviewers: 3,
  reviewerName: 40,
  reviewer: 600,
  path: 200,
} as const;

/** The review skills a product reviewer can be added to: the ones that run readers. */
export const REVIEW_SKILLS: readonly string[] = [
  "review-story",
  "review-tests",
  "critique-deliverable",
];

/** Why a path is refused, or undefined when it is a path inside the product. */
export function projectPathProblem(path: string): string | undefined {
  if (path.includes("\\")) return "use / in a path";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.startsWith("~")) {
    return "a path inside the product, from its root";
  }
  if (path.split("/").some((part) => part === ".." || part === "." || part === "")) {
    return "a path inside the product: no .., no empty part";
  }
  if (/^\.git(?:\/|$)/i.test(path)) return "never a path of .git";
  return undefined;
}

const projectPath = plainLine(SKILL_OVERRIDE_LIMITS.path).superRefine((path, context) => {
  const problem = projectPathProblem(path);
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

/** A sentence, or `file:<path>` whose contents are loaded as facts. */
const fact = plainLine(SKILL_OVERRIDE_LIMITS.fact).superRefine((text, context) => {
  if (!text.startsWith("file:")) return;
  const path = text.slice("file:".length).trim();
  const problem = path === "" ? "give the path after file:" : projectPathProblem(path);
  if (problem !== undefined) context.addIssue({ code: "custom", message: problem });
});

const ReviewerSchema = z.strictObject({
  /** What its findings are tagged with; the same name in a later file replaces the earlier reviewer. */
  name: SkillNameSchema.max(SKILL_OVERRIDE_LIMITS.reviewerName),
  instruction: plainLine(SKILL_OVERRIDE_LIMITS.reviewer),
});

const lines = (max: number, length: number) => z.array(plainLine(length)).max(max).optional();

export const SkillOverrideSchema = z.strictObject({
  /** Added to what the skill keeps in mind: sentences, or `file:<path>`. */
  facts: z.array(fact).max(SKILL_OVERRIDE_LIMITS.facts).optional(),
  /** Run before the skill's first step. */
  steps_before: lines(SKILL_OVERRIDE_LIMITS.steps, SKILL_OVERRIDE_LIMITS.step),
  /** Run after the skill's last step. */
  steps_after: lines(SKILL_OVERRIDE_LIMITS.steps, SKILL_OVERRIDE_LIMITS.step),
  /** Lines the skill verifies before it ends, on top of its own. */
  checks: lines(SKILL_OVERRIDE_LIMITS.checks, SKILL_OVERRIDE_LIMITS.check),
  /** What the skill does once everything is done; the personal file's replaces the product's. */
  when_done: plainLine(SKILL_OVERRIDE_LIMITS.done).optional(),
  /** A file of the product used as the model of what the skill produces; replaces the product's. */
  output_model: projectPath.optional(),
  /** Reviewers of the product's own, for a review skill. */
  reviewers: z.array(ReviewerSchema).max(SKILL_OVERRIDE_LIMITS.reviewers).optional(),
});

export type SkillOverride = z.infer<typeof SkillOverrideSchema>;
export type SkillOverrideField = keyof SkillOverride;
