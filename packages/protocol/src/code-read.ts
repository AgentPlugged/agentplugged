import { z } from "zod";
import { FORGE_PROVIDERS, ForgeHostSchema } from "./forge-link.js";

/**
 * Reading the code of a product at its code platform, and opening it in an editor: the shapes the
 * requests and the answers of the file reading carry (`pulls`, `pull`, `pull_diff`, `editor`).
 *
 * The bridge reads the platform with the token it keeps (read only, `GET` only) and tells the
 * device only what is below: no token, no raw answer of the platform, no address taken from an
 * answer (the address of a pull request is built by the bridge from the host it is linked to). Every
 * text that comes from the platform (a title, a name, a remark, a line of a patch) is untrusted
 * content: the device shows it as inert text.
 *
 * The device reads these answers with the tolerant reader of the file reading; the requests a
 * bridge receives stay strict.
 */

/** The most pull requests one list carries. */
export const CODE_PULLS_MAX = 30;
/** The most steps, reviews and remarks one pull request carries. */
export const CODE_CHECKS_MAX = 60;
export const CODE_REVIEWS_MAX = 30;
export const CODE_REMARKS_MAX = 100;
/** The most files, and the most characters of one file's patch, one difference carries. */
export const CODE_DIFF_FILES_MAX = 100;
export const CODE_PATCH_MAX_CHARS = 40_000;
export const CODE_TEXT_MAX_CHARS = 2_000;
export const CODE_TITLE_MAX_CHARS = 200;

/** The number of a pull request (GitHub) or merge request (GitLab) in its repository. */
export const CodePullNumberSchema = z.int().min(1).max(1_000_000_000);

export const CODE_PULL_STATES = ["open", "draft", "merged", "closed"] as const;
export type CodePullState = (typeof CODE_PULL_STATES)[number];

/** Where the checks of a pull request stand; `unknown` when the bridge did not read them. */
export const CODE_CHECKS_STATES = ["passed", "failed", "running", "none", "unknown"] as const;
export type CodeChecksState = (typeof CODE_CHECKS_STATES)[number];

/** Where the review of a pull request stands; `unknown` when the bridge did not read it. */
export const CODE_REVIEW_STATES = [
  "approved",
  "changes_requested",
  "pending",
  "none",
  "unknown",
] as const;
export type CodeReviewState = (typeof CODE_REVIEW_STATES)[number];

/** The repository the pull requests are read from, as the machine knows it. */
export const CodeRepositorySchema = z.strictObject({
  provider: z.enum(FORGE_PROVIDERS),
  host: ForgeHostSchema,
  /** `owner/name` (GitLab: the group path, possibly nested). */
  path: z.string().min(3).max(200),
});
export type CodeRepository = z.infer<typeof CodeRepositorySchema>;

export const CodeChecksSummarySchema = z.strictObject({
  state: z.enum(CODE_CHECKS_STATES),
  passed: z.int().min(0).max(10_000),
  failed: z.int().min(0).max(10_000),
  total: z.int().min(0).max(10_000),
});
export type CodeChecksSummary = z.infer<typeof CodeChecksSummarySchema>;

export const CodePullSchema = z.strictObject({
  number: CodePullNumberSchema,
  title: z.string().max(CODE_TITLE_MAX_CHARS),
  state: z.enum(CODE_PULL_STATES),
  /** The platform's login of the author. */
  author: z.string().min(1).max(100).optional(),
  /** The branch the work is on, and the branch it aims at. */
  branch: z.string().max(200),
  base: z.string().max(200),
  /** The address of the pull request at the platform, built by the bridge. */
  url: z.string().max(400),
  created_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
  checks: CodeChecksSummarySchema,
  review: z.enum(CODE_REVIEW_STATES),
  additions: z.int().min(0).optional(),
  deletions: z.int().min(0).optional(),
  files: z.int().min(0).optional(),
});
export type CodePull = z.infer<typeof CodePullSchema>;

export const CODE_CHECK_STATES = ["passed", "failed", "running", "queued", "skipped"] as const;
export type CodeCheckState = (typeof CODE_CHECK_STATES)[number];

export const CodeCheckSchema = z.strictObject({
  name: z.string().min(1).max(120),
  state: z.enum(CODE_CHECK_STATES),
  /** How long the step took, in seconds, when the platform says. */
  seconds: z.int().min(0).max(1_000_000).optional(),
});
export type CodeCheck = z.infer<typeof CodeCheckSchema>;

export const CODE_REVIEW_VERDICTS = [
  "approved",
  "changes_requested",
  "commented",
  "dismissed",
] as const;
export type CodeReviewVerdict = (typeof CODE_REVIEW_VERDICTS)[number];

export const CodeReviewSchema = z.strictObject({
  author: z.string().min(1).max(100).optional(),
  verdict: z.enum(CODE_REVIEW_VERDICTS),
  body: z.string().max(CODE_TEXT_MAX_CHARS).optional(),
  at: z.iso.datetime().optional(),
});
export type CodeReview = z.infer<typeof CodeReviewSchema>;

/** A remark anchored to a line of a file of the pull request. */
export const CodeRemarkSchema = z.strictObject({
  id: z.string().min(1).max(40),
  author: z.string().min(1).max(100).optional(),
  path: z.string().min(1).max(1024),
  /** The line of the file: after the change (`new`) or before it (`old`, a removed line). */
  line: z.int().min(1).max(10_000_000),
  side: z.enum(["new", "old"]),
  body: z.string().max(CODE_TEXT_MAX_CHARS),
  at: z.iso.datetime().optional(),
});
export type CodeRemark = z.infer<typeof CodeRemarkSchema>;

export const CODE_FILE_STATUSES = ["added", "modified", "deleted", "renamed"] as const;

/**
 * One file of a difference. `patch` is the platform's unified difference without its header (it
 * starts at the first `@@` line), each line that looked like a secret replaced by the fixed
 * notice; absent for a binary or a very large file.
 */
export const CodeDiffFileSchema = z.strictObject({
  path: z.string().min(1).max(1024),
  from: z.string().min(1).max(1024).optional(),
  status: z.enum(CODE_FILE_STATUSES),
  additions: z.int().min(0),
  deletions: z.int().min(0),
  patch: z.string().max(CODE_PATCH_MAX_CHARS).optional(),
  /** The patch is cut at the longest the bridge sends. */
  truncated: z.literal(true).optional(),
  /** The platform shows no text for this file (binary, or too large for it). */
  unavailable: z.literal(true).optional(),
  /** The file is a secret's by its name: its difference is never sent. */
  protected: z.literal(true).optional(),
});
export type CodeDiffFile = z.infer<typeof CodeDiffFileSchema>;

/** The editors a link can open. The scheme of each is fixed on the device; nothing is run. */
export const CODE_EDITORS = [
  "vscode",
  "cursor",
  "windsurf",
  "vscodium",
  "zed",
  "idea",
  "webstorm",
  "pycharm",
] as const;
export type CodeEditor = (typeof CODE_EDITORS)[number];

export const CODE_PLATFORMS = ["windows", "macos", "linux", "other"] as const;

/** The working copy an editor is opened on: the product's own folder, or a story's branch. */
export const CodeEditorRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("worktree") }),
  z.strictObject({ kind: z.literal("workspace"), branch: z.string().min(1).max(200) }),
]);

/** The request shapes (without the identifier, the version and the product, which the file reading adds). */
export const CodePullsRequestFields = {
  op: z.literal("pulls"),
} as const;
export const CodePullRequestFields = {
  op: z.literal("pull"),
  number: CodePullNumberSchema,
} as const;
export const CodeDiffRequestFields = {
  op: z.literal("pull_diff"),
  number: CodePullNumberSchema,
} as const;
export const CodeEditorRequestFields = {
  op: z.literal("editor"),
  ref: CodeEditorRefSchema,
} as const;

/** What an answer carries. */
export const CodePullsDataSchema = z.strictObject({
  op: z.literal("pulls"),
  repository: CodeRepositorySchema,
  pulls: z.array(CodePullSchema).max(CODE_PULLS_MAX),
  /** True when the platform has more than the bridge lists. */
  truncated: z.boolean(),
});
export const CodePullDataSchema = z.strictObject({
  op: z.literal("pull"),
  repository: CodeRepositorySchema,
  pull: CodePullSchema,
  checks: z.array(CodeCheckSchema).max(CODE_CHECKS_MAX),
  reviews: z.array(CodeReviewSchema).max(CODE_REVIEWS_MAX),
  remarks: z.array(CodeRemarkSchema).max(CODE_REMARKS_MAX),
});
export const CodeDiffDataSchema = z.strictObject({
  op: z.literal("pull_diff"),
  repository: CodeRepositorySchema,
  number: CodePullNumberSchema,
  files: z.array(CodeDiffFileSchema).max(CODE_DIFF_FILES_MAX),
  /** True when the pull request changes more files than the bridge sends. */
  truncated: z.boolean(),
});
export const CodeEditorDataSchema = z.strictObject({
  op: z.literal("editor"),
  /** The folder of the working copy on the machine. */
  folder: z.string().min(1).max(1024),
  /** The branch checked out there, when it is on one. */
  branch: z.string().min(1).max(200).optional(),
  /** The system of the machine, so that a device of another system knows the link is not for it. */
  platform: z.enum(CODE_PLATFORMS),
  /** The editors found on the machine, best known first. */
  detected: z.array(z.enum(CODE_EDITORS)).max(CODE_EDITORS.length),
});

/** The stable codes of a refusal that only the code reading gives. */
export const CODE_ERROR_CODES = [
  /** No platform is linked on the machine for the host of the repository. */
  "NOT_LINKED",
  /** The product's repository has no address at GitHub or GitLab. */
  "NO_REMOTE",
  /** The platform no longer takes the token (revoked, expired). */
  "FORGE_REFUSED",
  /** The platform did not answer, or answered something the bridge cannot read. */
  "FORGE_UNREACHABLE",
  /** The platform asks to wait (rate limit). */
  "FORGE_BUSY",
] as const;
