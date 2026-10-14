import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { plainLine } from "./agent-content.js";

/**
 * The guard before a write. A hook of the AI tool runs before the tools that write a
 * file (`check_write`); the engine refuses the write when it breaks a **named rule**, and lets it
 * through otherwise. A refusal is one line: the rule, the decision that carries it, what to do. In
 * doubt (no story in progress, an ambiguous path, a decision that cannot be checked, an error, a
 * delay), the write goes through and the doubt is traced. The journal never holds the value of a
 * secret nor the content of a write: only the rule, the path and, for a decision, its id.
 */

/** Event types of the guard, each at version 1. */
export const WRITE_GUARD_EVENT_TYPES = {
  refused: "write.refused",
  doubted: "write.doubted",
} as const;

/**
 * The named rules that refuse a write. `test` is one rule for the tests, and its
 * `detail` names the row of the grid it breaks (`TEST_GUARD_ROWS`).
 */
export const WRITE_RULES = ["secret", "scope", "decision", "test"] as const;
export type WriteRule = (typeof WRITE_RULES)[number];

/** The rows of the grid of the tests (`TEST_ROWS`) that the guard decides alone, before the write. */
export const TEST_GUARD_ROWS = [
  "focused",
  "skipped",
  "hard_wait",
  "tautology",
  "oversize",
] as const;
export type TestGuardRow = (typeof TEST_GUARD_ROWS)[number];

/** Why a write went through without a rule having checked it. */
export const WRITE_DOUBTS = [
  "no_story",
  "ambiguous_story",
  "no_scope",
  "unverifiable_decision",
  "unreadable_input",
  "error",
  "timeout",
] as const;
export type WriteDoubt = (typeof WRITE_DOUBTS)[number];

/** The longest path kept. */
export const WRITE_PATH_MAX = 300;

/** A path as the engine cleaned it (control characters replaced): any other character is allowed in a name. */
const path = z.string().min(1).max(WRITE_PATH_MAX);
const session = z.string().trim().min(1).max(200);

/** `payload` of `write.refused`: the rule, the path, the story and the decision that carry it. */
export const WriteRefusedPayloadSchema = z.strictObject({
  rule: z.enum(WRITE_RULES),
  path,
  story: StoryIdSchema.optional(),
  /** The architecture decision (`AD-7`), for the rule `decision`. */
  decision: z
    .string()
    .regex(/^AD-\d{1,4}$/)
    .optional(),
  /** What matched, never a value: the kind of secret (`GitHub token`), the dependency or module forbidden. */
  detail: plainLine(120).optional(),
  session: session.optional(),
});
export type WriteRefusedPayload = z.infer<typeof WriteRefusedPayloadSchema>;

/** `payload` of `write.doubted`: why nothing was checked, once per session and reason. */
export const WriteDoubtedPayloadSchema = z.strictObject({
  reason: z.enum(WRITE_DOUBTS),
  path: path.optional(),
  story: StoryIdSchema.optional(),
  session: session.optional(),
});
export type WriteDoubtedPayload = z.infer<typeof WriteDoubtedPayloadSchema>;

/** How much of a write's text the engine reads (a hook sends it whole; a longer text is read up to there, never refused for its size). */
export const WRITE_TEXT_MAX = 4_000_000;

/**
 * Input of `check_write`: the hook of Claude Code before `Write`, `Edit`, `MultiEdit` and
 * `NotebookEdit`. Values come as the hook substitutes them (`${tool_input.file_path}`): possibly
 * empty, or left as `${…}` when the tool has no such field; the engine reads them with that doubt.
 */
export const CheckWriteInputSchema = z.strictObject({
  tool: z.string().max(100),
  path: z.string().max(2000).optional(),
  text: z.string().optional(),
  session: session.optional(),
  cwd: z.string().max(2000).optional(),
});
export type CheckWriteInput = z.infer<typeof CheckWriteInputSchema>;

/** The most paths one widening of a story's scope names. */
export const MAX_SCOPE_PATHS = 10;

/**
 * A path or folder the creator adds to a story's scope: relative to the project, with `/`, no `..`,
 * no drive; `*` and `**` stand for any name and any depth; a trailing `/` names a folder.
 */
export const ScopePathSchema = plainLine(200).superRefine((value, context) => {
  if (/^(?:[/\\~]|[A-Za-z]:)/.test(value) || value.includes("\\")) {
    context.addIssue({ code: "custom", message: "expected a path inside the project, with /" });
    return;
  }
  const segments = value.replace(/\/$/, "").split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    context.addIssue({ code: "custom", message: "expected a path without .. nor empty parts" });
    return;
  }
  // At least one name that is written out: `*`, `**` or `.` would open the whole project.
  if (!segments.some((segment) => !/^[.*?]*$/.test(segment))) {
    context.addIssue({ code: "custom", message: "expected a path that names something" });
  }
});
export const ScopePathsSchema = z
  .array(ScopePathSchema)
  .min(1)
  .max(MAX_SCOPE_PATHS)
  .refine((list) => new Set(list).size === list.length, { message: "each path once" });
