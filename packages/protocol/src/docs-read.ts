import { z } from "zod";
import { REQUIREMENT_STATUSES, TRACED_REQUIREMENT_PATTERN } from "./trace.js";

/**
 * Reading the documents of a product, the status of each requirement and the retrospectives, through
 * its machine's bridge: the shapes the requests and the answers of the file reading carry (`docs`,
 * `trace`, `retros`).
 *
 * The bridge reads the documents of the product's folder and its journal, lets the engine compute
 * everything that is computed (a requirement's status, the coverage, the standing of a document,
 * the lessons in force) and tells the device only what is below. Every text that comes from a
 * document or from an agent (a title, a requirement, a deviation, a lesson) is untrusted content
 * and has been through the secret guard; the device shows it as inert text.
 *
 * The device reads these answers with the tolerant reader of the file reading; the requests a
 * bridge receives stay strict.
 */

/** The most documents, requirements, epics and stories one answer carries. */
export const DOCS_DOCUMENTS_MAX = 200;
export const DOCS_REQUIREMENTS_MAX = 800;
export const DOCS_EPICS_MAX = 100;
export const DOCS_STORIES_MAX = 600;
export const DOCS_DEVIATIONS_MAX = 50;
export const DOCS_UNCOVERED_MAX = 200;
/** The most characters of a title, of a requirement's text and of a longer text. */
export const DOCS_TITLE_MAX_CHARS = 200;
export const DOCS_REQUIREMENT_MAX_CHARS = 400;
export const DOCS_TEXT_MAX_CHARS = 2_000;
/** The most stories, tests, pull requests and deviations one requirement's trace carries. */
export const DOCS_TRACE_MAX = 100;
/** The most retrospectives and lessons an answer carries. */
export const DOCS_RETROS_MAX = 40;
export const DOCS_LESSONS_MAX = 120;

/**
 * Where the approval of a document stands: the latest `document` checkpoint that lists it decides.
 * `none`: no checkpoint lists it yet. A device shows a standing it does not know as `none`.
 */
export const DOC_STANDINGS = [
  "none",
  "to_approve",
  "approved",
  "changes_requested",
  "rejected",
] as const;
export type DocStanding = (typeof DOC_STANDINGS)[number];

/** Where a story stands, as the engine sees it. */
export const DOCS_STORY_STATUSES = ["todo", "in_progress", "in_review", "blocked", "done"] as const;
export type DocsStoryStatus = (typeof DOCS_STORY_STATUSES)[number];

const StoryRef = z.string().regex(/^[1-9]\d{0,5}-[1-9]\d{0,5}$/);
const RequirementRef = z.string().regex(TRACED_REQUIREMENT_PATTERN).max(16);

/** The request shapes (without the identifier, the version and the product, which the file reading adds). */
export const DocsListRequestFields = { op: z.literal("docs") } as const;
export const DocsTraceRequestFields = {
  op: z.literal("trace"),
  requirement: RequirementRef,
} as const;
export const DocsRetrosRequestFields = { op: z.literal("retros") } as const;

/** One document of the product: a file of `docs/` or `epics/` (the stories are told by the breakdown). */
export const DocsDocumentSchema = z.strictObject({
  /** The path from the product's folder, with `/`. */
  path: z.string().min(1).max(300),
  /** The header's kind (`prd`, `architecture`...), or `unknown` when the header is not valid. */
  kind: z.string().min(1).max(32),
  id: z.string().min(1).max(64).optional(),
  title: z.string().min(1).max(DOCS_TITLE_MAX_CHARS).optional(),
  /** The agent that owns it, or `creator`. */
  owner: z.string().min(1).max(64).optional(),
  standing: z.string().min(1).max(32),
  /** The requirements it defines (active and retired), when it defines any. */
  requirements: z.int().min(0).max(100_000).optional(),
  /** The documents and requirements its header links to. */
  links: z.array(z.string().min(1).max(64)).max(40).optional(),
});
export type DocsDocument = z.infer<typeof DocsDocumentSchema>;

export const DocsRequirementSchema = z.strictObject({
  id: RequirementRef,
  text: z.string().max(DOCS_REQUIREMENT_MAX_CHARS),
  /** The document that defines it. */
  path: z.string().min(1).max(300),
  /** Retired: the id stays reserved, the status below is not meaningful. */
  retired: z.boolean(),
  status: z.enum(REQUIREMENT_STATUSES),
  stories: z.array(StoryRef).max(DOCS_TRACE_MAX),
  /** The test files that cite it, or null when the tests could not be read. */
  tests: z.int().min(0).max(100_000).nullable(),
  pull_requests: z.int().min(0).max(100_000),
  /** Its open deviations. */
  deviations: z.int().min(0).max(100_000),
});
export type DocsRequirement = z.infer<typeof DocsRequirementSchema>;

export const DocsDeviationSchema = z.strictObject({
  id: z.string().regex(/^V-[0-9A-HJKMNP-TV-Z]{10}$/),
  story: StoryRef,
  requirements: z.array(z.string().min(1).max(16)).max(20),
  summary: z.string().max(DOCS_TITLE_MAX_CHARS),
  reported_by: z.string().min(1).max(64),
  reported_at: z.string().max(40),
});
export type DocsDeviation = z.infer<typeof DocsDeviationSchema>;

export const DocsBreakdownStorySchema = z.strictObject({
  id: StoryRef,
  title: z.string().min(1).max(DOCS_TITLE_MAX_CHARS).optional(),
  status: z.enum(DOCS_STORY_STATUSES),
  depends_on: z.array(StoryRef).max(40),
  requirements: z.array(RequirementRef).max(40),
});
export type DocsBreakdownStory = z.infer<typeof DocsBreakdownStorySchema>;

export const DocsEpicSchema = z.strictObject({
  /** `epic-2`. */
  id: z.string().regex(/^epic-[1-9]\d{0,5}$/),
  title: z.string().min(1).max(DOCS_TITLE_MAX_CHARS).optional(),
  /** The path of the epic's document, when it has one. */
  path: z.string().min(1).max(300).optional(),
  out_of_scope: z.array(RequirementRef).max(200),
  stories: z.array(DocsBreakdownStorySchema).max(DOCS_STORIES_MAX),
});
export type DocsEpic = z.infer<typeof DocsEpicSchema>;

export const DocsCoverageSchema = z.strictObject({
  /** The active functional and non-functional requirements. */
  total: z.int().min(0).max(100_000),
  /** Those a story carries. */
  covered: z.int().min(0).max(100_000),
  /** Those an epic leaves aside. */
  out_of_scope: z.int().min(0).max(100_000),
  /** The others, by id. */
  uncovered: z.array(RequirementRef).max(DOCS_UNCOVERED_MAX),
});
export type DocsCoverage = z.infer<typeof DocsCoverageSchema>;

export const DOCS_TESTS_STATES = ["read", "truncated", "unavailable"] as const;

const CountsSchema = z.strictObject({
  todo: z.int().min(0),
  in_development: z.int().min(0),
  in_review: z.int().min(0),
  delivered: z.int().min(0),
  deviation: z.int().min(0),
});

export const DocsListDataSchema = z.strictObject({
  op: z.literal("docs"),
  documents: z.array(DocsDocumentSchema).max(DOCS_DOCUMENTS_MAX),
  /** True when the product holds more documents than the bridge lists. */
  truncated: z.boolean(),
  requirements: z.array(DocsRequirementSchema).max(DOCS_REQUIREMENTS_MAX),
  /** How many active requirements stand at each status. */
  counts: CountsSchema,
  /** How the tests were read: all of them, a part, or not at all. */
  tests: z.enum(DOCS_TESTS_STATES),
  /** The open deviations. */
  deviations: z.array(DocsDeviationSchema).max(DOCS_DEVIATIONS_MAX),
  epics: z.array(DocsEpicSchema).max(DOCS_EPICS_MAX),
  /** Absent while no story exists: nothing is covered or not yet. */
  coverage: DocsCoverageSchema.optional(),
});

export const DocsTraceDeviationSchema = DocsDeviationSchema.extend({
  detail: z.string().max(DOCS_TEXT_MAX_CHARS).optional(),
  status: z.enum(["open", "resolved"]),
  resolved: z
    .strictObject({
      reason: z.string().max(DOCS_TEXT_MAX_CHARS),
      by: z.string().min(1).max(64),
      at: z.string().max(40),
    })
    .optional(),
});

export const DocsTraceDataSchema = z.strictObject({
  op: z.literal("trace"),
  requirement: z.strictObject({
    id: RequirementRef,
    text: z.string().max(DOCS_REQUIREMENT_MAX_CHARS),
    path: z.string().min(1).max(300),
    line: z.int().min(1).max(10_000_000),
    retired: z.boolean(),
    status: z.enum(REQUIREMENT_STATUSES),
    stories: z
      .array(
        z.strictObject({
          id: StoryRef,
          title: z.string().min(1).max(DOCS_TITLE_MAX_CHARS).optional(),
          status: z.enum(DOCS_STORY_STATUSES),
        }),
      )
      .max(DOCS_TRACE_MAX),
    tests: z
      .array(
        z.strictObject({
          path: z.string().min(1).max(300),
          /** 0: the file's name cites it. */
          line: z.int().min(0).max(10_000_000),
        }),
      )
      .max(DOCS_TRACE_MAX),
    pull_requests: z
      .array(
        z.strictObject({
          story: StoryRef,
          number: z.int().min(1).max(1_000_000_000),
        }),
      )
      .max(DOCS_TRACE_MAX),
    deviations: z.array(DocsTraceDeviationSchema).max(DOCS_TRACE_MAX),
  }),
  tests_state: z.enum(DOCS_TESTS_STATES),
});

/** Where a retrospective stands: the creator's answer to its checkpoint decides. */
export const RETRO_STATUSES = ["open", "approved", "changes_requested", "dismissed"] as const;
export type RetroStatus = (typeof RETRO_STATUSES)[number];

/**
 * What became of a proposed lesson: still `proposed` (nothing recorded), `active` (recorded and in
 * force), `retired` or `superseded` since, or `not_kept` (its retrospective was not approved).
 */
export const RETRO_LESSON_STATUSES = [
  "proposed",
  "active",
  "retired",
  "superseded",
  "not_kept",
] as const;
export type RetroLessonStatus = (typeof RETRO_LESSON_STATUSES)[number];

const LessonText = z.string().max(DOCS_TEXT_MAX_CHARS);
const LessonRef = z.string().regex(/^L-[0-9A-HJKMNP-TV-Z]{10}-[1-9][0-9]?$/);

export const DocsRetroSchema = z.strictObject({
  id: z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{10}$/),
  scope: z.strictObject({
    kind: z.enum(["epic", "sprint"]),
    id: z.string().min(1).max(16),
  }),
  at: z.string().max(40),
  proposed_by: z.string().min(1).max(64),
  status: z.enum(RETRO_STATUSES),
  summary: LessonText,
  lessons: z
    .array(
      z.strictObject({
        id: LessonRef,
        title: z.string().max(DOCS_TITLE_MAX_CHARS),
        text: LessonText,
        tags: z.array(z.string().min(1).max(32)).max(5),
        agents: z.array(z.string().min(1).max(64)).max(10),
        status: z.enum(RETRO_LESSON_STATUSES),
      }),
    )
    .max(12),
  retire: z.array(z.strictObject({ lesson: LessonRef, reason: LessonText })).max(12),
  actions: z
    .array(
      z.strictObject({
        id: z.string().min(1).max(32),
        text: LessonText,
        owner: z.string().min(1).max(64).optional(),
      }),
    )
    .max(12),
});
export type DocsRetro = z.infer<typeof DocsRetroSchema>;

/** A lesson in force: what the agents read at the start of a task. */
export const DocsMemoryLessonSchema = z.strictObject({
  id: LessonRef,
  title: z.string().max(DOCS_TITLE_MAX_CHARS),
  text: LessonText,
  tags: z.array(z.string().min(1).max(32)).max(5),
  agents: z.array(z.string().min(1).max(64)).max(10),
  at: z.string().max(40),
  /** The retrospective it comes from. */
  retro: z.string().regex(/^R-[0-9A-HJKMNP-TV-Z]{10}$/),
  /** True when it was also promoted to the common memory of the machine. */
  promoted: z.boolean(),
});
export type DocsMemoryLesson = z.infer<typeof DocsMemoryLessonSchema>;

export const DocsRetrosDataSchema = z.strictObject({
  op: z.literal("retros"),
  retrospectives: z.array(DocsRetroSchema).max(DOCS_RETROS_MAX),
  /** The lessons in force, newest first. */
  memory: z.array(DocsMemoryLessonSchema).max(DOCS_LESSONS_MAX),
  /**
   * The retrospectives whose content this machine could not read (the product's key is missing
   * here): they are counted, never guessed.
   */
  unreadable: z.int().min(0).max(100_000),
});

export type DocsListData = z.infer<typeof DocsListDataSchema>;
export type DocsTraceData = z.infer<typeof DocsTraceDataSchema>;
export type DocsRetrosData = z.infer<typeof DocsRetrosDataSchema>;
