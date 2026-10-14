import { z } from "zod";
import { BranchNameSchema } from "./checkpoint.js";
import { ARCHITECTURE_PREREQUISITES_FIELD, PrerequisitesSchema } from "./environment.js";
import { ARCHITECTURE_DEPENDENCIES_FIELD, DependenciesSchema } from "./install.js";
import { ISSUE } from "./issues.js";

/** Folders of `.agentplugged/` whose documents carry a header (`docs check`). */
export const DOCUMENT_DIRS = ["docs", "epics", "stories"] as const;

/** Kinds of document. Identifiers are stable. */
export const DOCUMENT_KINDS = [
  "brief",
  "prfaq",
  "prd",
  "ux",
  "architecture",
  "spec",
  "epic",
  "story",
  "note",
  "decision",
] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/** Owner of a document that no agent wrote: the creator. */
export const CREATOR_OWNER = "creator";

/**
 * Header keys refused in a document: the state of the product comes from the projection of the
 * journal, never from a document.
 */
export const DOCUMENT_STATE_KEYS = [
  "status",
  "state",
  "cost",
  "spent",
  "budget_spent",
  "progress",
] as const;

/** Prefixes of the tracked requirement identifiers (`EF-12`, `AD-3`…). */
export const REQUIREMENT_PREFIXES = ["EF", "ENF", "PU", "MS", "AD"] as const;
export type RequirementPrefix = (typeof REQUIREMENT_PREFIXES)[number];

/** A tracked requirement identifier: a prefix, `-`, an integer without a leading zero. */
export const REQUIREMENT_ID_PATTERN = /^(?:EF|ENF|PU|MS|AD)-[1-9]\d*$/;

/** A document id: lowercase letters, digits and hyphens. */
export const DOCUMENT_ID_PATTERN = /^[a-z0-9-]+$/;

export const DocumentIdSchema = z.string().regex(DOCUMENT_ID_PATTERN, { message: ISSUE.docId });

/** Each state key, refused whatever its value (`null` included). */
const refusedStateKeys = Object.fromEntries(
  DOCUMENT_STATE_KEYS.map((key) => [key, z.never({ message: ISSUE.docStateKey }).optional()]),
) as Record<(typeof DOCUMENT_STATE_KEYS)[number], z.ZodOptional<z.ZodNever>>;

/**
 * Header (YAML frontmatter) of a document of `.agentplugged/{docs,epics,stories}/`. Keys other
 * than the ones below are allowed, except the state keys (`DOCUMENT_STATE_KEYS`). `owner` names an
 * agent or `creator`; core checks that the agent exists.
 */
export const DocumentHeaderSchema = z.looseObject({
  id: DocumentIdSchema,
  kind: z.enum(DOCUMENT_KINDS, { message: ISSUE.docKind }),
  owner: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: ISSUE.idFormat }),
  links: z
    .array(
      z
        .string()
        .refine((link) => DOCUMENT_ID_PATTERN.test(link) || REQUIREMENT_ID_PATTERN.test(link), {
          message: ISSUE.docLink,
        }),
    )
    .default([]),
  ...refusedStateKeys,
});

export type DocumentHeader = z.infer<typeof DocumentHeaderSchema>;

/**
 * Header of the architecture document: the document header plus `dependencies`, the
 * dependencies and tools the product is built on, by ecosystem (`npm: [react, supabase]`). It is
 * what the engine reads, once the architecture is approved, to know that an installation is
 * planned; never deduced. It also carries `prerequisites`: what the stack asks of the machine
 * (tools and their versions, ports, memory), checked by `doctor`.
 */
export const ArchitectureHeaderSchema = DocumentHeaderSchema.extend({
  [ARCHITECTURE_DEPENDENCIES_FIELD]: z
    .unknown()
    .superRefine((value, context) => {
      if (value !== undefined && !DependenciesSchema.safeParse(value).success) {
        context.addIssue({ code: "custom", message: ISSUE.docDependencies });
      }
    })
    .optional(),
  [ARCHITECTURE_PREREQUISITES_FIELD]: z
    .unknown()
    .superRefine((value, context) => {
      if (value !== undefined && !PrerequisitesSchema.safeParse(value).success) {
        context.addIssue({ code: "custom", message: ISSUE.docPrerequisites });
      }
    })
    .optional(),
});

/**
 * A story's id in a document: `<epic>-<story>`, as in the journal (`2-6`), without a
 * leading zero, numbers from 1. Stories are ordered by it: epic, then story, as numbers.
 */
export const STORY_DOCUMENT_ID_PATTERN = /^[1-9]\d{0,5}-[1-9]\d{0,5}$/;

/** An epic's id: `epic-<n>` (`epic-2`, from 1), the epic of the stories `<n>-<s>`. */
export const EPIC_DOCUMENT_ID_PATTERN = /^epic-[1-9]\d{0,5}$/;

/** The epic id a story id belongs to: `2-6` → `epic-2`. */
export function epicIdOf(storyId: string): string {
  return `epic-${storyId.slice(0, storyId.indexOf("-"))}`;
}

const RequirementIdSchema = z.string().regex(REQUIREMENT_ID_PATTERN, {
  message: ISSUE.requirementId,
});
const StoryDocumentIdSchema = z.string().regex(STORY_DOCUMENT_ID_PATTERN, {
  message: ISSUE.storyId,
});

/** A Git branch name (the rules of `BranchNameSchema`, with a message of its own). */
const StoryBranchSchema = z.string().refine((name) => BranchNameSchema.safeParse(name).success, {
  message: ISSUE.branchName,
});

/**
 * Header of a story: the document header plus `title`, `epic` (the epic of its
 * id), `reviewer` (an agent or `creator`, checked by core like `owner`), `requirements` (at least
 * one), `budget_usd` (above zero), `branch` and `depends_on`. Never a status: the state keys stay
 * refused.
 */
export const StoryHeaderSchema = DocumentHeaderSchema.extend({
  id: StoryDocumentIdSchema,
  title: z
    .string()
    .trim()
    .min(1)
    .refine((title) => !/[\r\n]/.test(title), { message: ISSUE.oneLine }),
  epic: z.string().regex(EPIC_DOCUMENT_ID_PATTERN, { message: ISSUE.storyEpic }),
  reviewer: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: ISSUE.idFormat }),
  requirements: z.array(RequirementIdSchema).min(1, { message: ISSUE.storyRequirements }),
  budget_usd: z
    .number({ message: ISSUE.budget })
    .refine((amount) => Number.isFinite(amount) && amount > 0, { message: ISSUE.budget }),
  branch: StoryBranchSchema,
  depends_on: z.array(StoryDocumentIdSchema).default([]),
}).superRefine((header, context) => {
  if (header.epic !== epicIdOf(header.id)) {
    context.addIssue({ code: "custom", path: ["epic"], message: ISSUE.storyEpic });
  }
});
export type StoryHeader = z.infer<typeof StoryHeaderSchema>;

/**
 * Header of an epic: the document header, plus `out_of_scope`, the requirements the
 * breakdown leaves aside (they count as covered).
 */
export const EpicHeaderSchema = DocumentHeaderSchema.extend({
  id: z.string().regex(EPIC_DOCUMENT_ID_PATTERN, { message: ISSUE.epicId }),
  out_of_scope: z.array(RequirementIdSchema).default([]),
});
export type EpicHeader = z.infer<typeof EpicHeaderSchema>;

/**
 * The sections of a story's body (level 2 headings), and the titles each one accepts, compared
 * without case.
 */
export const STORY_SECTIONS = {
  context: ["context", "contexte"],
  intent: ["intent", "intention"],
  acceptance_criteria: ["acceptance criteria", "critères d'acceptation"],
  out_of_scope: ["out of scope", "hors périmètre"],
} as const satisfies Record<string, readonly string[]>;
export type StorySection = keyof typeof STORY_SECTIONS;

/** The header field of a page of the knowledge base that records what it was built from. */
export const KNOWLEDGE_SOURCES_FIELD = "sources";

/**
 * One source of a page of the knowledge base: a document of the method the page was
 * built from, and the Git blob of the version read, as `blob_sha` in a checkpoint. When the
 * creator approves another version of that document, the page is behind it.
 */
export const KnowledgeSourceSchema = z.strictObject({
  /**
   * The document's path, on one line. Core reads it from `.agentplugged/` (`\` read as `/`,
   * `./` and the folders before `.agentplugged/` dropped) and requires a document of
   * `.agentplugged/docs/`.
   */
  path: z
    .string()
    .min(1)
    .max(500)
    .refine((path) => ![...path].some((char) => char.charCodeAt(0) < 0x20)),
  blob: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
});
export type KnowledgeSource = z.infer<typeof KnowledgeSourceSchema>;
