import {
  type AgentFrontmatter,
  CHECKPOINT_EVENT_TYPES,
  ErrorCode,
  type FreeChange,
  isSilentJudge,
  isSilentLens,
  JUDGE_LENS,
  type LensReport,
  MAIN_SESSION_AGENT,
  MAX_REVIEW_FINDINGS,
  MAX_REVIEW_PASSES,
  MERGE_ORDER_EVENT_TYPES,
  type MethodConfig,
  type ProjectionState,
  REVIEW_DOMAINS,
  REVIEW_EVENT_TYPES,
  type ReviewFinding,
  type ReviewKind,
  type ReviewLens,
  type ReviewNotPossibleReason,
  type ReviewSecurity,
  reviewIdOf,
  type SilentPart,
  type StartReviewInput,
  StartReviewInputSchema,
  type StoryHeader,
  StoryReviewInputSchema,
  type SubmitReviewInput,
  SubmitReviewInputSchema,
  TriageReviewInputSchema,
} from "@agentplugged/protocol";
import { z } from "zod";
import {
  agentEventCommand,
  agentWriteContext,
  defined,
  invalidInput,
  type RecordedEvent,
} from "../agent-activity/agent-commands.js";
import { checkpointPayload, truncate } from "../checkpoints/checkpoint-rules.js";
import { branchHead } from "../ci/ci-check.js";
import { ciGreen, storyCiStatus } from "../ci/ci-rules.js";
import { ciPlan } from "../ci/ci-setup.js";
import { type CommandContext, type CommandResult, defineCommand, fail, ok } from "../command.js";
import { criteriaTrace, type StoryTrace } from "../criteria/criterion-trace.js";
import { currentState } from "../deferred/deferred-commands.js";
import type { DeferredItem } from "../deferred/deferred-rules.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_DIR } from "../init/layout.js";
import { isSkipped } from "../journey/journey-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import { storyIn } from "../projection/agent-reducers.js";
import { checkpointsOf } from "../projection/checkpoint-reducers.js";
import { conflictNote, refreshedMergeSummary } from "../projection/merge-order-reducers.js";
import {
  duplicateFindings,
  isReuseReport,
  type ReuseReport,
  reuseLines,
  reuseOf,
} from "../reuse/reuse.js";
import { weighedStoriesOf, weightDrift } from "../reuse/weight.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import { type StoryText, storyText } from "../stories/story-text.js";
import { activeDefinitions, loadDefinitions } from "../sync/sync-command.js";
import { writeGuardLine } from "../write-guard/write-line.js";
import { type ExportParts, exportPrompt, lensFileOf, passFileOf } from "./review-export.js";
import { type ForgePosting, forgeTarget, reviewDraft } from "./review-forge.js";
import { freeIdOf, readFree } from "./review-free.js";
import {
  type ChangeFile,
  type CreatorStack,
  changeFiles,
  chooseLenses,
  creatorStack,
  findingRefs,
  findingSeverities,
  isSensitiveChange,
  type LensChoice,
  lensDiff,
  lensDiffPathOf,
  mergeLensReports,
  planReaders,
  type Reader,
  type ReaderPass,
  readerPasses,
  STACK_SHOWN,
  stackText,
  validateJudge,
  validateLensReports,
} from "./review-lenses.js";
import {
  changesAfter,
  currentPass,
  findFinding,
  isStoryDeveloper,
  openMergeCheckpoint,
  parseDiff,
  passComplete,
  passNumberFor,
  passOutcome,
  REVIEW_LOOP_OPTIONS,
  type ReviewPass,
  refutedOf,
  reviewLoopReached,
  reviewOf,
  reviewVerdictOf,
  securityReasons,
  silentOf,
  stackEntriesOf,
  stackEntryOf,
  unpublishedKinds,
  untriagedFindings,
} from "./review-rules.js";
import {
  CHECKPOINT_SUMMARY_MAX,
  type UxFlow,
  uxFlows,
  type Walkthrough,
  walkCriteria,
  walkSlot,
  walkthrough,
} from "./review-walkthrough.js";

/**
 * The tools of a story's independent review: `start_review` gives a reviewer the diff
 * of the story's branch in a file, `submit_review` records the review (its verdict computed here)
 * and, once its pass is closed, opens the merge checkpoint or the loop's checkpoint and posts the
 * pass on the pull request; `triage_review` records how the developer sorts each finding;
 * `get_review` gives each one what it may read; `publish_review` posts a closed pass again.
 */

/** `REVIEW_NOT_POSSIBLE`: nothing written. */
export function reviewNotPossible(
  story: string,
  reason: ReviewNotPossibleReason,
  details: Readonly<Record<string, unknown>> = {},
): AgentPluggedError {
  return new AgentPluggedError(
    ErrorCode.REVIEW_NOT_POSSIBLE,
    `error.review_not_possible.${reason}`,
    { story, reason, ...details },
  );
}

/** What stands for the story in the refusals of a review that belongs to none. */
export const FREE = "free";

/** Folder of the diffs the engine writes for reviewers: never in Git, never writable by agents. */
export const REVIEW_DIFF_DIR = `${METHOD_DIR}/.cache/reviews`;

/** The longest diff file written, in UTF-16 units: beyond, it is cut and said so. */
export const MAX_DIFF_CHARS = 4_000_000;

/** The domain of each active agent (`metadata.domain`). */
async function activeDomains(
  context: CommandContext,
  config: MethodConfig,
): Promise<Map<string, string>> {
  const definitions = await loadDefinitions(context.files);
  if (definitions instanceof AgentPluggedError) throw definitions;
  const domains = new Map<string, string>();
  for (const definition of activeDefinitions(definitions, config)) {
    if (definition.kind !== "agent") continue;
    const domain = (definition.frontmatter as AgentFrontmatter).metadata?.domain;
    if (typeof domain === "string") domains.set(definition.name, domain);
  }
  return domains;
}

/** What a review needs of the repository: the head of the branch, and its diff. */
interface Reading {
  readonly head: string;
  readonly diff: string;
}

async function readBranch(
  context: CommandContext,
  id: string,
  story: StoryState,
): Promise<Reading | AgentPluggedError> {
  const started = story.started;
  const workspace = context.storyWorkspace;
  const source = context.storyDiff;
  if (started === undefined) return reviewNotPossible(id, "not_started");
  if (workspace === undefined || source === undefined) return reviewNotPossible(id, "no_diff");
  const head = await branchHead(workspace, id, started.branch).catch(
    (error: unknown) => error as AgentPluggedError,
  );
  if (head instanceof AgentPluggedError || typeof head !== "string") {
    return reviewNotPossible(id, "branch_missing", { branch: started.branch });
  }
  const diff = await source.diff(started.base, head, started.base_ref).catch(() => undefined);
  if (diff === undefined) return reviewNotPossible(id, "no_diff", { commit: head });
  return { head, diff };
}

/** The security a review records: the reasons, `unavailable` without a security reviewer. */
function reviewSecurity(
  paths: readonly string[],
  text: StoryText | undefined,
  domains: ReadonlyMap<string, string>,
  qaFlag: boolean,
  story?: StoryState,
): ReviewSecurity {
  const reviewer = text?.reviewer ?? null;
  const reasons = securityReasons({
    paths,
    text: text?.text ?? "",
    securityReviewer: reviewer !== null && domains.get(reviewer) === REVIEW_DOMAINS.security,
    qaFlag,
  });
  // A security reviewer other than the story's developer (never reviewing its own work).
  const available = [...domains].some(
    ([agent, domain]) => domain === REVIEW_DOMAINS.security && !isStoryDeveloper(story, agent),
  );
  return reasons.length > 0 && !available ? { reasons, unavailable: true } : { reasons };
}

/** The quality reviewer of the pass asked for a security review (or does now). */
function qaFlagOf(story: StoryState | undefined, commit: string, kind: ReviewKind, asked: boolean) {
  if (kind === "qa") return asked;
  return currentPass(story, commit)?.security.reasons.includes("qa_flag") === true;
}

/**
 * Why `agent` may not give the `kind` review of the story now, from the state, or undefined.
 * `head` is the branch's head when read.
 */
export function reviewProblem(input: {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly agent: string;
  readonly state: ProjectionState["state"];
  readonly known: boolean;
  readonly domains: ReadonlyMap<string, string>;
  readonly head?: string;
}): AgentPluggedError | undefined {
  const { id, kind, agent, state } = input;
  if (!input.known) return reviewNotPossible(id, "unknown_story");
  const story = storyIn(state, id);
  if (story?.started === undefined) return reviewNotPossible(id, "not_started");
  const checkpoints = Object.values(checkpointsOf(state));
  if (storyDoneAt(checkpoints, id, story) !== undefined) return reviewNotPossible(id, "done");
  // Independent: never the story's developer, whatever its domain.
  if (isStoryDeveloper(story, agent)) {
    return reviewNotPossible(id, "not_independent", { agent, developer: story.started.agent });
  }
  if (agent === MAIN_SESSION_AGENT || input.domains.get(agent) !== REVIEW_DOMAINS[kind]) {
    return reviewNotPossible(id, "not_reviewer", {
      agent,
      kind,
      domain: REVIEW_DOMAINS[kind],
    });
  }
  if (story.status !== "in_review") {
    return reviewNotPossible(id, "not_in_review", { status: story.status ?? "none" });
  }
  // With the story's CI skipped by the creator, the review covers the branch's head.
  const ciSkipped = isSkipped(state, "story_ci", id);
  const ci = storyCiStatus(story, undefined, ciSkipped);
  if (!ciGreen(ci)) return reviewNotPossible(id, "ci_not_green", { ci });
  const commit = ciSkipped ? (input.head ?? story.ci?.commit ?? "") : (story.ci?.commit as string);
  if (input.head !== undefined && input.head !== commit) {
    return reviewNotPossible(id, "head_moved", { commit, head: input.head });
  }
  const pass = currentPass(story, commit);
  if (pass !== undefined) {
    if (pass.complete || pass.reviews[kind] !== undefined) {
      return reviewNotPossible(id, "already_reviewed", { kind, pass: pass.number });
    }
    if (Object.values(pass.reviews).some((review) => review?.by === agent)) {
      return reviewNotPossible(id, "same_reviewer", { agent, pass: pass.number });
    }
  }
  return undefined;
}

/** What `start_review` gives the reviewer. */
export interface ReviewStart {
  /** The story, or null for a free review: then `commit` names the diff read. */
  readonly story: string | null;
  readonly kind: ReviewKind;
  /** Where its diff came from, and the intent it is judged against. */
  readonly source?: string;
  readonly intent?: string;
  /** The commit messages the assertions pass tries, when there are any (a file to read). */
  readonly statements?: string;
  /**
   * The project's declared test command (the `test` script of its package, run the way its package
   * manager runs scripts), to give to a reader who runs the tests. Absent when none is declared.
   */
  readonly test_command?: string;
  readonly pass: number;
  readonly commit: string;
  readonly base: string;
  /** The diff's file, from the product's root: read it, never write it. */
  readonly diff: string;
  readonly truncated: boolean;
  readonly files: readonly { path: string; added: number; removed: number }[];
  readonly story_file: string | null;
  readonly requirements: readonly string[];
  readonly security: {
    readonly required: boolean;
    readonly reasons: readonly string[];
    readonly unavailable: boolean;
  };
  /** The lenses to run, chosen by the engine from the change, and why. */
  readonly lenses: readonly LensChoice[];
  /**
   * Who reads what. One sub-agent per reader, each with its own part of the diff
   * (`diff`) and one report per lens it carries; `judge` when it also checks the criteria.
   */
  readonly readers: readonly (Reader & {
    readonly diff: string;
    /** What the engine proved of reuse (duplicates) and suspects (twins), for the form (or lone) reader. */
    readonly reuse?: readonly string[];
  })[];
  /** The story's acceptance criteria, numbered from 1 in this order (cut short). */
  readonly criteria: readonly string[];
  /** The writes the guard refused for this story, in one line; absent when it refused none. */
  readonly guard?: string;
  /**
   * Where each criterion stands, computed by the engine (`1:green 2:green(reported)
   * 3:untestable`): the judge takes it as it is and never recomputes it. `untestable`: the reasons
   * the developer gave for the criteria with no result to observe, which the review looks at.
   */
  readonly trace?: string;
  readonly untestable?: readonly string[];
  /** Your own findings of the earlier passes, with how they were sorted (the decision only). */
  readonly previous: readonly {
    readonly pass: number;
    readonly id: string;
    readonly severity: string;
    readonly title: string;
    readonly path: string | null;
    readonly line: number | null;
    readonly decision: string | null;
  }[];
}

/**
 * The test command the project declares: its `test` script, as its package manager runs it. A
 * reader runs that and nothing else to try the tests (a launcher such as `npx` is refused to
 * agents), so it is told here instead of guessing.
 */
async function declaredTestCommand(context: CommandContext): Promise<string | undefined> {
  try {
    const plan = await ciPlan(context.files);
    for (const step of plan.jobs.test) {
      if ("run" in step && /^(?:pnpm|npm|yarn) run test$/.test(step.run)) return step.run;
    }
  } catch {
    // A project the plan cannot read declares nothing the readers could be told.
  }
  return undefined;
}

/** The reviewer's own findings of the story's earlier passes, with the triage decision only. */
function ownFindings(story: StoryState | undefined, agent: string, kind: ReviewKind) {
  return (reviewOf(story)?.passes ?? []).flatMap((pass) => {
    const review = pass.reviews[kind];
    if (review === undefined || review.by !== agent || !pass.complete) return [];
    return review.findings.map((finding) => ({
      pass: pass.number,
      id: finding.id,
      severity: finding.severity,
      title: finding.title,
      path: finding.path ?? null,
      line: finding.line ?? null,
      decision: finding.triage?.decision ?? null,
    }));
  });
}

/**
 * The lenses a review of `kind` runs, chosen by the engine from the change. The
 * security lens is the security reviewer's: the quality review never carries it, the security
 * review carries only it.
 */
function lensesFor(
  kind: ReviewKind,
  files: readonly ChangeFile[],
  reasons: ReviewSecurity["reasons"],
  more: readonly ReviewLens[] = [],
  securityByQa = false,
): LensChoice[] {
  const chosen = chooseLenses(files, reasons, more);
  if (kind === "security") return chosen.filter((choice) => choice.lens === "security");
  // With no security reviewer to give it, the quality review carries the security lens.
  return chosen.filter((choice) => choice.lens !== "security" || securityByQa);
}

/** Where the engine keeps what it found of reuse for a review: one file per story and commit. */
function reusePathOf(story: string, commit: string): string {
  return `${REVIEW_DIFF_DIR}/${story}/reuse-${commit.slice(0, 12)}.json`;
}

/**
 * What the engine proved of the reuse of a change: read from the review's cache when
 * `start_review` already did the work, else computed (and kept) here. Never a failure: without the
 * means to read the repository, nothing is reported.
 */
async function reuseOfReview(
  context: CommandContext,
  story: string,
  commit: string,
  diff: string,
): Promise<ReuseReport | undefined> {
  const path = reusePathOf(story, commit);
  try {
    if (await context.files.exists(path)) {
      const cached = JSON.parse(await context.files.readText(path)) as {
        diff?: unknown;
        report?: unknown;
      };
      // Read back as data: the shape is checked, and the diff it was made for is the same.
      if (cached.diff === diff.length && isReuseReport(cached.report)) return cached.report;
    }
  } catch {
    // Unreadable cache: computed again.
  }
  const report = await reuseOf(context, parseDiff(diff), commit);
  // A report cut short by the time limit is not kept: the next reading looks again.
  if (report !== undefined && !report.partial) {
    await context.files
      .writeText(path, JSON.stringify({ diff: diff.length, report }))
      .catch(() => undefined);
  }
  return report;
}

/** The diff file of a review: one per story, kind and commit. */
export function diffPathOf(story: string, kind: ReviewKind, commit: string): string {
  return `${REVIEW_DIFF_DIR}/${story}/${kind}-${commit.slice(0, 12)}.diff`;
}

/** What preparing a review gives the commands that start it, export it or check it. */
interface Prepared {
  readonly start: ReviewStart;
  /** The whole diff (the file the reader gets may be cut). */
  readonly diff: string;
  /** The story's text, for a story's review. */
  readonly text?: StoryText;
  /** The commit messages the assertions pass tries (maybe empty). */
  readonly statements: string;
  /** The passes of the reader of verification gaps, decided by the engine. */
  readonly passes: readonly ReaderPass[];
}

/** Where a free review keeps what the engine read of it, next to the other diffs of the cache. */
export function freeDirOf(id: string): string {
  return `${REVIEW_DIFF_DIR}/free/${id.slice(0, 12)}`;
}

/** The commit messages a review tries as assertions: a file next to the diff. */
function statementsPathOf(diffPath: string): string {
  return diffPath.replace(/\.diff$/, ".statements.txt");
}

/** What a free review keeps for its submission: its commit, where it came from, its intent, its files. */
interface FreeMeta {
  readonly id: string;
  readonly source: string;
  readonly intent: string;
  readonly files: readonly ChangeFile[];
}

/** The readers of a review with the file of the diff each one reads. */
function readersFor(
  kind: ReviewKind,
  lenses: readonly LensChoice[],
  files: readonly ChangeFile[],
  reasons: ReviewSecurity["reasons"],
  path: string,
  passes: readonly ReaderPass[],
): ReviewStart["readers"] {
  return planReaders(kind, lenses, isSensitiveChange(files, reasons), passes).map((reader) => ({
    ...reader,
    diff: kind === "qa" ? lensDiffPathOf(path, reader.reader) : path,
  }));
}

/** Writes the diff, and for the quality review the part each reader reads (never more than it needs). */
async function writeDiffs(
  context: CommandContext,
  kind: ReviewKind,
  readers: ReviewStart["readers"],
  diff: string,
  path: string,
  tail: string,
): Promise<boolean> {
  const truncated = diff.length > MAX_DIFF_CHARS;
  await context.files.writeText(
    path,
    truncated
      ? `${diff.slice(0, MAX_DIFF_CHARS)}\n# agentplugged: diff cut at ${MAX_DIFF_CHARS} characters; ${tail}\n`
      : diff,
  );
  if (kind === "qa") {
    for (const reader of readers) {
      const part = lensDiff(diff, [...reader.lenses, ...(reader.judge ? [JUDGE_LENS] : [])]);
      await context.files.writeText(
        reader.diff,
        part.length > MAX_DIFF_CHARS
          ? `${part.slice(0, MAX_DIFF_CHARS)}\n# agentplugged: cut at ${MAX_DIFF_CHARS} characters; the whole diff is in ${path}\n`
          : part,
      );
    }
  }
  return truncated;
}

/** The messages of the commits of a story's branch, or empty (Git cannot say, or the port is not given). */
async function commitMessages(
  context: CommandContext,
  story: StoryState,
  head: string,
): Promise<string> {
  const started = story.started;
  const source = context.storyDiff;
  if (started === undefined || source?.messages === undefined) return "";
  return (await source.messages(started.base, head, started.base_ref).catch(() => "")) ?? "";
}

/** A story's review: the diff of its branch, the lenses, the readers, the story's own criteria. */
async function prepareStory(
  context: CommandContext,
  input: StartReviewInput & { readonly story: string },
  domains: ReadonlyMap<string, string>,
): Promise<Prepared | AgentPluggedError> {
  const { agent, story: id, kind, more } = input;
  const now = (context.now ?? Date.now)();
  const state = await currentState(context);
  const text = await storyText(context, state, id, now);
  const known = text !== undefined;
  const early = reviewProblem({ id, kind, agent, state, known, domains });
  if (early !== undefined) return early;
  const story = storyIn(state, id) as StoryState;
  const reading = await readBranch(context, id, story);
  if (reading instanceof AgentPluggedError) return reading;
  const late = reviewProblem({ id, kind, agent, state, known, domains, head: reading.head });
  if (late !== undefined) return late;
  const files = parseDiff(reading.diff);
  const security = reviewSecurity(
    files.map((file) => file.path),
    text,
    domains,
    qaFlagOf(story, reading.head, kind, false),
  );
  const required = security.reasons.length > 0 && security.unavailable !== true;
  if (kind === "security" && !required) {
    return reviewNotPossible(id, "security_not_required", { reasons: security.reasons });
  }
  const followed = await criteriaTrace(context, state, id);
  const guardLine = writeGuardLine(story.write_guard);
  const path = diffPathOf(id, kind, reading.head);
  // Each lens, and the judge, reads its own part of the diff (never more than it needs).
  const changed = changeFiles(files);
  const lenses = lensesFor(kind, changed, security.reasons, more, security.unavailable === true);
  // The messages of the commits are assertions to try; the engine decides the short passes.
  const messages = kind === "qa" ? await commitMessages(context, story, reading.head) : "";
  const passes =
    kind === "qa" ? readerPasses(changed, (text?.criteria.length ?? 0) > 0 || messages !== "") : [];
  const readers = readersFor(kind, lenses, changed, security.reasons, path, passes);
  const truncated = await writeDiffs(
    context,
    kind,
    readers,
    reading.diff,
    path,
    `read the rest with git diff ${story.started?.base}...${reading.head}`,
  );
  const statements = messages === "" ? undefined : statementsPathOf(path);
  if (statements !== undefined) await context.files.writeText(statements, messages);
  const testCommand = kind === "qa" ? await declaredTestCommand(context) : undefined;
  // The engine proved the duplicates and suspects the twins, with no token spent;
  // the form reader (the lone reader of a small change) is told, in few lines.
  const reuse =
    kind === "qa" ? reuseLines(await reuseOfReview(context, id, reading.head, reading.diff)) : [];
  const reuseReader =
    readers.find((reader) => reader.reader === "form") ??
    readers.find((reader) => reader.reader === "whole");
  const told = readers.map((reader) =>
    reader === reuseReader && reuse.length > 0 ? { ...reader, reuse } : reader,
  );
  return {
    diff: reading.diff,
    ...(text === undefined ? {} : { text }),
    statements: messages,
    passes,
    start: {
      story: id,
      kind,
      pass: passNumberFor(story, reading.head),
      commit: reading.head,
      base: story.started?.base as string,
      diff: path,
      truncated,
      files: files.map((file) => ({ path: file.path, added: file.added, removed: file.removed })),
      story_file: text?.path ?? null,
      requirements: text?.requirements ?? [],
      security: {
        required,
        reasons: security.reasons,
        unavailable: security.unavailable === true,
      },
      lenses,
      readers: told,
      criteria: (text?.criteria ?? []).map((criterion) => truncate(criterion, 100)),
      ...(statements === undefined ? {} : { statements }),
      ...(testCommand === undefined ? {} : { test_command: testCommand }),
      // What the guard before a write refused for this story, in one line.
      ...(guardLine === undefined ? {} : { guard: guardLine }),
      ...(followed === undefined
        ? {}
        : {
            trace: followed.line,
            ...(followed.untestable.length === 0 ? {} : { untestable: followed.untestable }),
          }),
      previous: ownFindings(story, agent, kind),
    },
  };
}

/**
 * A free review: a change that belongs to no story, read with the same lenses and a
 * judge on the intent given in one sentence (its only criterion). The engine reads the diff itself,
 * names it by its hash, keeps what the submission needs in the cache and writes nothing in the journal.
 * With no security reviewer to give it, the quality review carries the security lens.
 */
async function prepareFree(
  context: CommandContext,
  input: StartReviewInput,
  domains: ReadonlyMap<string, string>,
): Promise<Prepared | AgentPluggedError> {
  const { agent, more } = input;
  const change = input.free as FreeChange;
  if (agent === MAIN_SESSION_AGENT || domains.get(agent) !== REVIEW_DOMAINS.qa) {
    return reviewNotPossible(FREE, "free_not_reviewer", { agent, domain: REVIEW_DOMAINS.qa });
  }
  const read = await readFree(context, change);
  if ("why" in read) return reviewNotPossible(FREE, "source_invalid", { why: read.why });
  const files = parseDiff(read.diff);
  if (files.length === 0) {
    return reviewNotPossible(FREE, "source_invalid", { why: "the diff holds no file" });
  }
  const intent = change.intent;
  const id = freeIdOf(read.diff, intent);
  const reasons = securityReasons({
    paths: files.map((file) => file.path),
    text: "",
    securityReviewer: false,
    qaFlag: false,
  });
  const changed = changeFiles(files);
  const lenses = lensesFor("qa", changed, reasons, more, reasons.length > 0);
  const dir = freeDirOf(id);
  const path = `${dir}/qa.diff`;
  const statementsText = read.messages.trim() === "" ? "" : read.messages;
  const passes = readerPasses(changed, true);
  const readers = readersFor("qa", lenses, changed, reasons, path, passes);
  const truncated = await writeDiffs(
    context,
    "qa",
    readers,
    read.diff,
    path,
    "the whole diff is the one you were given",
  );
  const statements = statementsText === "" ? undefined : statementsPathOf(path);
  if (statements !== undefined) await context.files.writeText(statements, statementsText);
  const testCommand = await declaredTestCommand(context);
  const meta: FreeMeta = { id, source: read.label, intent, files: changed };
  await context.files.writeText(`${dir}/meta.json`, JSON.stringify(meta));
  return {
    diff: read.diff,
    statements: statementsText,
    passes,
    start: {
      story: null,
      kind: "qa",
      source: read.label,
      intent,
      pass: 1,
      commit: id,
      base: read.label,
      diff: path,
      truncated,
      files: files.map((file) => ({ path: file.path, added: file.added, removed: file.removed })),
      story_file: null,
      requirements: [],
      security: { required: false, reasons, unavailable: reasons.length > 0 },
      lenses,
      readers,
      criteria: [truncate(intent, 100)],
      ...(statements === undefined ? {} : { statements }),
      ...(testCommand === undefined ? {} : { test_command: testCommand }),
      previous: [],
    },
  };
}

/** Prepares a review of a story, or a free one (no story, a source or a pasted diff). */
async function prepareReview(
  context: CommandContext,
  input: StartReviewInput,
): Promise<Prepared | AgentPluggedError> {
  const target = await agentWriteContext(context, input.agent);
  if (target instanceof AgentPluggedError) return target;
  const domains = await activeDomains(context, target.config);
  return input.story === undefined
    ? await prepareFree(context, input, domains)
    : await prepareStory(context, { ...input, story: input.story }, domains);
}

export const startReviewCommand = defineCommand<ReviewStart>({
  name: "start_review",
  audience: "agent",
  description:
    "Start your independent review of a story in review: `kind` is `qa` for the quality reviewer, `security` for the security reviewer; `story` is `<epic>-<story>`; `agent` your own id. The story must be started, in review, not done, with a green (or waived) CI on the head of its branch; you must be an active agent of the review's domain (quality, security), never the story's developer nor `main`. The engine writes the diff of the story's branch since its base to a file (`diff`, from the product's root) and gives the changed files, the story's file, its requirements, whether it concerns security (`security`: `required`, `reasons`: paths, words, reviewer, qa_flag), your own findings of the earlier passes with how the developer sorted them, and the `lenses` to run, each chosen by the engine from the change's risk with `why`, and the story's numbered `criteria`; `more` adds lenses the creator asked for. Read the diff file, the story and the documents it cites — never the other reviewer's notes or comments, never the author's reasoning — then call submit_review with the same `commit`. Refused with REVIEW_NOT_POSSIBLE (unknown_story, not_started, done, not_independent, not_reviewer, not_in_review, ci_not_green: read the CI first, head_moved: the branch moved since its CI was read, already_reviewed, same_reviewer, security_not_required: this story needs no security review, branch_missing, no_diff). Nothing is written in the journal. A free review of a change that belongs to no story: instead of `story`, give `free`: its `intent` in one sentence (the judge's only criterion) and a `source` (`uncommitted`, a range `<from>..<to>`, `branch:<name>` against the main branch, `pr:<number>`) or a pasted `diff`; only the quality review (`kind` qa), by an agent of the quality domain. The engine reads the diff itself and returns the same lenses and readers, with `commit` naming the diff read; refused with source_invalid (and why) or free_not_reviewer. Readers whose entry has `passes` run those short passes after their lenses, and `statements` is the file of the commit messages they try. `test_command` is the project's declared test command: a reader who runs the tests runs that, never a launcher such as `npx`, and reads the changes with `git diff`, `git log` or `git show` from the product's folder (no `-C`).",
  inputSchema: StartReviewInputSchema,
  async run(context, input) {
    const parsed = StartReviewInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("start_review", parsed.error));
    try {
      const prepared = await prepareReview(context, parsed.data);
      return prepared instanceof AgentPluggedError ? fail(prepared) : ok(prepared.start);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** What `export_review` gives: the request that stands alone, written in a file. */
export interface ReviewExport {
  readonly story: string | null;
  readonly kind: ReviewKind;
  /** The commit (or, for a free review, the hash of the diff) the answer is submitted for. */
  readonly commit: string;
  /** The file of the request, from the product's root: give its text to the other tool. */
  readonly prompt: string;
  readonly lenses: readonly ReviewLens[];
  readonly chars: number;
  /** The change touches something sensitive (why, as for a security review): say it before the text leaves. */
  readonly sensitive?: readonly string[];
}

/** The reference files of the review skill, read from the product. */
const SKILL_REFERENCES = `${METHOD_DIR}/skills/review-story/references`;

/** The texts the request carries, or the file that is missing. */
async function exportParts(
  context: CommandContext,
  lenses: readonly ReviewLens[],
  passes: readonly ReaderPass[],
  withJudge: boolean,
): Promise<ExportParts | string> {
  const read = async (name: string) => {
    const path = `${SKILL_REFERENCES}/${name}`;
    return (await context.files.exists(path)) ? await context.files.readText(path) : undefined;
  };
  const format = await read("format.md");
  const judge = withJudge ? await read("judge.md") : "";
  const lens: Partial<Record<ReviewLens, string>> = {};
  const pass: Partial<Record<ReaderPass, string>> = {};
  for (const name of lenses) {
    const text = await read(lensFileOf(name));
    if (text === undefined) return lensFileOf(name);
    lens[name] = text;
  }
  for (const name of passes) {
    const text = await read(passFileOf(name));
    if (text === undefined) return passFileOf(name);
    pass[name] = text;
  }
  if (format === undefined) return "format.md";
  if (judge === undefined) return "judge.md";
  return { format, judge, lens, pass };
}

export const exportReviewCommand = defineCommand<ReviewExport>({
  name: "export_review",
  audience: "agent",
  description:
    "Write your review request as a text that stands alone, to give to another tool or another model that cannot read the repository (a cross review, or no sub-agents here): the same input as start_review (a story, or `free`), the same refusals. The engine writes the request in a file (`prompt`, from the product's root): the criteria (or the intent), the lenses and passes to run, the judge, the shape of the answer, the commit messages and the diff itself; nothing is written in the journal. Give that text to the other tool; its answer (one JSON object: `summary`, `lenses`, `judge`) comes back through submit_review with the `commit` returned here, taken as it comes: the engine checks it like any other review.",
  inputSchema: StartReviewInputSchema,
  async run(context, input) {
    const parsed = StartReviewInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("export_review", parsed.error));
    try {
      const prepared = await prepareReview(context, parsed.data);
      if (prepared instanceof AgentPluggedError) return fail(prepared);
      const { start } = prepared;
      const lenses = start.lenses.map((choice) => choice.lens);
      const withJudge = start.kind === "qa";
      const parts = await exportParts(context, lenses, prepared.passes, withJudge);
      if (typeof parts === "string") {
        return fail(
          reviewNotPossible(start.story ?? FREE, "source_invalid", {
            why: `${SKILL_REFERENCES}/${parts} is missing: run sync`,
          }),
        );
      }
      const storyFile =
        start.story_file === null || !(await context.files.exists(start.story_file))
          ? undefined
          : await context.files.readText(start.story_file);
      const prompt = exportPrompt({
        subject:
          start.story === null
            ? `${start.source ?? "a change"}, free review`
            : `story ${start.story}${prepared.text === undefined ? "" : `: ${prepared.text.title}`}`,
        criteria: start.intent === undefined ? start.criteria : [start.intent],
        story: storyFile,
        lenses,
        passes: prepared.passes,
        judge: withJudge,
        statements: prepared.statements,
        diff: prepared.diff,
        parts,
      });
      const path = start.diff.replace(/\.diff$/, ".prompt.md");
      await context.files.writeText(path, prompt);
      return ok({
        story: start.story,
        kind: start.kind,
        commit: start.commit,
        prompt: path,
        lenses,
        chars: prompt.length,
        ...(start.security.reasons.length === 0 ? {} : { sensitive: start.security.reasons }),
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** What `submit_review` reads before the write. */
interface SubmitPrepared {
  readonly domains: ReadonlyMap<string, string>;
  readonly text: StoryText | undefined;
  readonly reading: Reading | AgentPluggedError | undefined;
  readonly paths: readonly string[];
  readonly files: readonly ChangeFile[];
  /** The duplicates the engine proved in the added code (the quality review in lenses). */
  readonly reuse?: ReuseReport;
  /** Where the criteria stand, and the journeys of the UX specification, for the walk. */
  readonly trace?: StoryTrace;
  readonly flows?: readonly UxFlow[];
}

/** The findings of a submitted review and what the journal keeps of the lenses that gave them. */
interface Assembled {
  readonly findings: readonly ReviewFinding[];
  readonly meta: {
    readonly lenses?: readonly { lens: ReviewLens; findings: number }[];
    readonly merged?: number;
    readonly asked?: readonly ReviewLens[];
    readonly judge?: { met: number; partly: number; unmet: number };
    /** How the judge ruled on the lenses' findings; the refuted ones, kept for the audit. */
    readonly ruled?: { confirmed: number; refuted: number; undecided: number };
    readonly refuted?: readonly {
      lens: ReviewLens;
      severity: ReviewFinding["severity"];
      title: string;
      at?: string;
    }[];
    /** The lenses (or the judge) that gave no report. */
    readonly silent?: readonly SilentPart[];
  };
}

/** What the engine knows of a change to check the reports of its review. */
interface ReportContext {
  /** What stands for the story in a refusal. */
  readonly label: string;
  readonly files: readonly ChangeFile[];
  readonly reasons: ReviewSecurity["reasons"];
  /** No security reviewer is active: the quality review carries the security lens. */
  readonly securityByQa: boolean;
  /** Acceptance criteria to judge: the story's, or the one intent of a free review. */
  readonly criteria: number;
  /** What the engine proved itself (the duplicates): no reviewer can leave it out. */
  readonly engine: readonly ReviewFinding[];
}

/**
 * The findings of a review. Plain: the reviewer's own. With lenses: the reports are
 * checked (every lens the engine chose, whole sections, real criteria, the judge), then merged;
 * a report that is not whole is refused with what is missing. The engine, not the agent, merges
 * and counts, so the verdict follows from the strictest report.
 */
function assemble(
  input: SubmitReviewInput,
  prepared: SubmitPrepared | undefined,
  story: StoryState | undefined,
): Assembled | AgentPluggedError {
  if (input.lenses === undefined && input.judge === undefined) {
    return { findings: input.findings, meta: {} };
  }
  const security = reviewSecurity(
    prepared?.paths ?? [],
    prepared?.text,
    prepared?.domains ?? new Map(),
    qaFlagOf(story, input.commit, input.kind, false),
  );
  return assembleReports(input, {
    label: input.story as string,
    files: prepared?.files ?? [],
    reasons: security.reasons,
    securityByQa: security.unavailable === true,
    criteria: prepared?.text?.criteria.length ?? 0,
    engine: input.kind === "qa" ? duplicateFindings(prepared?.reuse) : [],
  });
}

/**
 * Checks the reports of a review against what the engine asked, then merges them (
 * 18.2): the lenses it chose, whole sections, real criteria, the judge's ruling on every finding;
 * a lens or the judge declared `silent` owes no report but is recorded, so that the review says it
 * is possibly incomplete. Shared by the story's review and the free one.
 */
function assembleReports(
  input: Pick<SubmitReviewInput, "kind" | "lenses" | "judge">,
  context: ReportContext,
): Assembled | AgentPluggedError {
  const chosen = lensesFor(input.kind, context.files, context.reasons, [], context.securityByQa);
  const required = chosen.map((choice) => choice.lens);
  const given = input.lenses ?? [];
  const reports = given.filter((entry): entry is LensReport => !isSilentLens(entry));
  const judgeSilent = input.judge !== undefined && isSilentJudge(input.judge);
  const judge = input.judge === undefined || isSilentJudge(input.judge) ? undefined : input.judge;
  const silent: SilentPart[] = [
    ...new Set<SilentPart>([
      ...given.filter(isSilentLens).map((entry) => entry.lens),
      ...(judgeSilent ? [JUDGE_LENS] : []),
    ]),
  ];
  const problems = [
    ...validateLensReports(reports, {
      kind: input.kind,
      required,
      criteria: context.criteria,
      securityByQa: context.securityByQa,
      silent,
    }),
    ...(input.kind === "security"
      ? [
          ...(judge === undefined ? [] : ["judge_not_allowed"]),
          ...(judgeSilent ? ["silent_not_asked:judge"] : []),
        ]
      : judgeSilent
        ? []
        : validateJudge(judge, context.criteria, findingRefs(reports), findingSeverities(reports))),
  ];
  if (problems.length > 0) {
    return reviewNotPossible(context.label, "report_invalid", {
      problems: problems.slice(0, 20).join(", "),
    });
  }
  const merged = mergeLensReports(reports, judge, context.engine);
  return {
    findings: merged.findings,
    meta: {
      lenses: merged.lenses,
      merged: merged.merged,
      asked: required,
      ...(merged.judge === undefined ? {} : { judge: merged.judge }),
      ...(merged.ruled === undefined ? {} : { ruled: merged.ruled }),
      ...(merged.refuted.length === 0
        ? {}
        : { refuted: merged.refuted.slice(0, MAX_REVIEW_FINDINGS) }),
      ...(silent.length === 0 ? {} : { silent }),
    },
  };
}

/**
 * The merge checkpoint the engine opens once a story's review is done (source `merge`).
 * A merge into the main branch is undone by a `git revert`, so it is reversible and of a medium
 * risk: one answer of the creator validates it (a stack of merges comes).
 */
function mergeCheckpoint(
  id: string,
  title: string,
  pass: number,
  commit: string,
  note = "",
  stack?: CreatorStack,
  walk?: Walkthrough,
) {
  // The walk takes the room the rest leaves, beside the stack and never repeating it.
  const compose = (read: string) =>
    `The independent review of story ${id} is done (pass ${pass}, commit ${commit.slice(0, 12)}), on a green CI.${stackText(stack)}${read === "" ? "" : ` ${read}`}${note} Approve and the engine merges its pull request into the main branch with your forge's tool, then removes its worktree (a git revert of the merge undoes it); ask for changes to send it back to its developer with your note.`;
  return {
    ...checkpointPayload({
      type: "story",
      risk: "medium",
      title: truncate(`Merge story ${id}: ${title}`, 120),
      summary: truncate(
        compose(walk === undefined ? "" : walkSlot(walk, compose(""))),
        CHECKPOINT_SUMMARY_MAX,
      ),
    }),
    source: "merge" as const,
  };
}

/** The journeys of the UX specification, when the product has one (else none: never a failure). */
async function uxFlowsOf(context: CommandContext): Promise<UxFlow[]> {
  const path = `${METHOD_DIR}/docs/ux.md`;
  try {
    return (await context.files.exists(path)) ? uxFlows(await context.files.readText(path)) : [];
  } catch {
    return [];
  }
}

/** The walk through the change a merge checkpoint carries, drawn from what the review already holds. */
function walkFor(
  story: StoryState | undefined,
  prepared: SubmitPrepared | undefined,
  entries: ReturnType<typeof stackEntriesOf>,
): Walkthrough | undefined {
  const reading = prepared?.reading;
  if (reading === undefined || reading instanceof AgentPluggedError) return undefined;
  return walkthrough({
    files: parseDiff(reading.diff),
    findings: entries,
    criteria: walkCriteria(prepared?.text?.listed ?? [], prepared?.trace),
    reuse: prepared?.reuse,
    guarded: [...(story?.write_guard?.paths ?? []), ...(story?.scope_widened ?? [])],
    flows: prepared?.flows,
    requirements: prepared?.text?.requirements,
  });
}

/** The checkpoint of a review loop that reached its limit (source `review_loop`). */
function loopCheckpoint(id: string, blocking: number) {
  return {
    ...checkpointPayload({
      type: "permission",
      risk: "medium",
      title: truncate(
        `Review loop of story ${id}: ${MAX_REVIEW_PASSES} passes without agreement`,
        120,
      ),
      summary: truncate(
        `Story ${id} went through ${MAX_REVIEW_PASSES} review passes that each ended with changes to make (${blocking} blocking finding(s) in the last one). The reviewer and the developer do not agree. Approve to allow ${MAX_REVIEW_PASSES} more passes, merge it as it is with the remaining findings accepted, or refuse to keep the story out of review while you settle it with its developer.`,
        2000,
      ),
      blocks: [{ action: "story.review", story: id }],
      options: [
        {
          id: REVIEW_LOOP_OPTIONS.more,
          label: `${MAX_REVIEW_PASSES} more review passes`,
          consequence: "The developer fixes again and the reviewer reviews the new commit.",
        },
        {
          id: REVIEW_LOOP_OPTIONS.asIs,
          label: "Merge as it is, remaining findings accepted",
          consequence:
            "The story's review is skipped for this story: its merge is proposed without another pass, the findings left stay as they are.",
        },
      ],
      recommendation: REVIEW_LOOP_OPTIONS.more,
    }),
    source: "review_loop" as const,
  };
}

/** The story of a submission that has one (the free review is recorded apart). */
const storyOf = (input: { readonly story?: string | undefined }): string => input.story as string;

const recordReview = agentEventCommand<typeof SubmitReviewInputSchema, SubmitPrepared>({
  name: "submit_review",
  description:
    "Submit your independent review of a story, after start_review: the same `kind` and `commit`, a `summary` of your review, and your `findings` (each: `severity` blocking, should_fix or minor; a one-line `title`; an optional `detail`; the `path` of the file as the diff names it and the `line` of its new side, when it is about a line). The engine computes the verdict (a blocking finding fails the review; one to fix gives pass with reservations; else pass), records the review, and the quality reviewer may ask for a security review (`security: true`). The judge's report also rules on each finding of the lenses (`judge.findings`: `<lens>#<rank>`, `confirmed` with its final severity, `refuted` with the place that proves it, `undecided`): a refuted finding is counted and never shown, an undecided one never blocks; a lens (`{lens, silent: true}`) or the judge (`{silent: true}`) that gave nothing is declared in its place, and the review then says it is possibly incomplete. Without a `story`, the `commit` start_review returned names a free review, recorded in the journal with no story. Once the pass has every review it needs (quality, and security when the story concerns it), it is closed: with a failed review, the story goes back to its developer, who sorts each finding (triage_review); without one, the engine opens the story's merge checkpoint. After 2 passes closed with a failed review, the engine stops the loop and opens a checkpoint for the creator: one question about the disagreement. A closed pass is posted on the pull request by the engine, a comment on each finding's line (`published`: posted, skipped with the reason, or failed: call publish_review later). Never post or read comments on the pull request yourself. Refused with REVIEW_NOT_POSSIBLE like start_review, and head_moved when `commit` is not the head of the branch any more. With `lenses` (one report per lens `start_review` gave, the security review only the security lens) and `judge` (the fresh-context pass, quality only), leave `findings` empty: the engine refuses reports that are not whole (`report_invalid`, with what is missing), merges the same finding seen twice at its strictest severity, links each to its criterion, and computes the verdict. Returns the review's id (`review`: R-…), its verdict and its pass.",
  inputSchema: SubmitReviewInputSchema,
  needsState: () => true,
  replanned: true,
  prepare: async (input, context, _agents, config) => {
    const id = storyOf(input);
    const domains = await activeDomains(context, config);
    const state = await currentState(context);
    const now = (context.now ?? Date.now)();
    const text = await storyText(context, state, id, now);
    const story = storyIn(state, id);
    const reading = story?.started === undefined ? undefined : await readBranch(context, id, story);
    const files =
      reading === undefined || reading instanceof AgentPluggedError ? [] : parseDiff(reading.diff);
    // The duplicates are the engine's finding of the quality review in lenses.
    const readable =
      input.lenses !== undefined &&
      reading !== undefined &&
      !(reading instanceof AgentPluggedError);
    const reuse = readable
      ? await reuseOfReview(context, id, reading.head, reading.diff)
      : undefined;
    // What the walk through the change is drawn from, read once for the pass.
    const trace = readable ? await criteriaTrace(context, state, id) : undefined;
    const flows = readable ? await uxFlowsOf(context) : [];
    return {
      domains,
      text,
      reading,
      paths: files.map((file) => file.path),
      files: changeFiles(files),
      ...(reuse === undefined ? {} : { reuse }),
      ...(trace === undefined ? {} : { trace }),
      ...(flows.length === 0 ? {} : { flows }),
    };
  },
  events: (input, state, prepared) => {
    const projected = state ?? {};
    const story = storyIn(projected, storyOf(input));
    const security = reviewSecurity(
      prepared?.paths ?? [],
      prepared?.text,
      prepared?.domains ?? new Map(),
      qaFlagOf(story, input.commit, input.kind, input.security === true),
    );
    // `check` already refused a report that is not whole: here the findings are the merged ones.
    const assembled = assemble(input, prepared, story);
    const given = assembled instanceof AgentPluggedError ? input.findings : assembled.findings;
    const meta: Assembled["meta"] = assembled instanceof AgentPluggedError ? {} : assembled.meta;
    const verdict = reviewVerdictOf(given);
    const events: {
      type: string;
      story: string;
      payload: Record<string, unknown>;
    }[] = [
      {
        type: REVIEW_EVENT_TYPES.reviewed,
        story: storyOf(input),
        payload: {
          kind: input.kind,
          commit: input.commit,
          summary: input.summary,
          findings: given.map((finding) => defined({ ...finding })),
          verdict,
          security,
          ...meta,
        },
      },
    ];
    // Where the pass stands once this review joins it.
    const pass = currentPass(story, input.commit);
    const reviews = { ...(pass?.reviews ?? {}), [input.kind]: { verdict } };
    const closing = { reviews, security } as Pick<ReviewPass, "reviews" | "security">;
    if (passComplete(closing, isSkipped(projected, "story_security", storyOf(input)))) {
      const checkpoints = Object.values(checkpointsOf(projected));
      const number = passNumberFor(story, input.commit);
      if (passOutcome(closing) === "approved") {
        const note = conflictNote(story, checkpointsOf(projected));
        const drift = weightDrift(weighedStoriesOf(projected));
        const entries = stackEntriesOf(story, number, { kind: input.kind, findings: given });
        const stack = creatorStack(
          entries,
          STACK_SHOWN,
          silentOf(story, number, { kind: input.kind, silent: meta.silent ?? [] }),
          refutedOf(story, number, {
            kind: input.kind,
            total: meta.ruled?.refuted ?? 0,
            blocking: (meta.refuted ?? []).filter((entry) => entry.severity === "blocking").length,
          }),
        );
        const walk = walkFor(story, prepared, entries);
        const open = openMergeCheckpoint(checkpoints, storyOf(input));
        if (open === undefined) {
          events.push({
            type: CHECKPOINT_EVENT_TYPES.opened,
            story: storyOf(input),
            payload: mergeCheckpoint(
              storyOf(input),
              prepared?.text?.title ?? storyOf(input),
              number,
              input.commit,
              `${note}${drift === undefined ? "" : ` ${drift}`}`,
              stack,
              walk,
            ),
          });
        } else if (
          story?.status_by !== null &&
          story?.status_by !== undefined &&
          Date.parse(open.opened_at) < Date.parse(story.status_by.at)
        ) {
          // The story came back to review on a new commit while its merge checkpoint
          // stayed open: the creator is shown this pass and this commit, not the old ones.
          const bare = {
            story: storyOf(input),
            pass: number,
            commit: input.commit,
            note,
            stack: stackText(stack),
          };
          const read = walk === undefined ? "" : walkSlot(walk, refreshedMergeSummary(bare));
          events.push({
            type: MERGE_ORDER_EVENT_TYPES.mergeRefreshed,
            story: storyOf(input),
            payload: {
              checkpoint: open.id,
              pass: number,
              commit: input.commit,
              summary: refreshedMergeSummary({ ...bare, walkthrough: read }),
              ...(read === "" ? {} : { walkthrough: read }),
            },
          });
        }
      } else {
        if (reviewLoopReached(story, storyOf(input), checkpoints, 1)) {
          const blocking = given.filter((finding) => finding.severity === "blocking").length;
          events.push({
            type: CHECKPOINT_EVENT_TYPES.opened,
            story: storyOf(input),
            payload: loopCheckpoint(storyOf(input), blocking),
          });
        }
      }
    }
    return { events };
  },
  check: (input, state, { prepared }) => {
    const domains = prepared?.domains ?? new Map<string, string>();
    const known = prepared?.text !== undefined;
    const reading = prepared?.reading;
    if (reading instanceof AgentPluggedError) {
      return (
        reviewProblem({
          id: storyOf(input),
          kind: input.kind,
          agent: input.agent,
          state,
          known,
          domains,
        }) ?? reading
      );
    }
    const problem = reviewProblem({
      id: storyOf(input),
      kind: input.kind,
      agent: input.agent,
      state,
      known,
      domains,
      ...(reading === undefined ? {} : { head: reading.head }),
    });
    if (problem !== undefined) return problem;
    if (reading !== undefined && input.commit !== reading.head) {
      return reviewNotPossible(storyOf(input), "head_moved", {
        commit: input.commit,
        head: reading.head,
      });
    }
    const story = storyIn(state, storyOf(input));
    if (input.kind === "security") {
      const security = reviewSecurity(
        prepared?.paths ?? [],
        prepared?.text,
        domains,
        qaFlagOf(story, input.commit, "security", false),
      );
      if (security.reasons.length === 0) {
        return reviewNotPossible(storyOf(input), "security_not_required", { reasons: [] });
      }
    }
    const assembled = assemble(input, prepared, story);
    if (assembled instanceof AgentPluggedError) return assembled;
    return undefined;
  },
});

/** What `submit_review` returns: the event, the review and its pass, and the forge's posting. */
export interface ReviewSubmitted extends RecordedEvent {
  readonly review: string;
  readonly verdict: string;
  readonly pass: number;
  readonly complete: boolean;
  readonly outcome: "approved" | "changes_requested" | null;
  readonly security: ReviewSecurity;
  /**
   * The forge's posting of the pass: by this call when its review closed the pass;
   * `posted_by_other` when another review's call closed it; `pass_open` while it is open.
   */
  readonly published: ForgePosting | { readonly status: "pass_open" | "posted_by_other" };
  /** The findings the judge refuted (counted, never shown), and the lenses that said nothing. */
  readonly refuted?: number;
  readonly incomplete?: readonly SilentPart[];
}

/** The pass that holds the review `id` of the story. */
function passOfReview(story: StoryState | undefined, id: string): ReviewPass | undefined {
  return reviewOf(story)?.passes.find((pass) =>
    Object.values(pass.reviews).some((review) => review?.id === id),
  );
}

/** Internal input of the posting's record: the agent that triggered the posting. */
const PublishedInputSchema = z.strictObject({
  agent: z.string(),
  story: z.string(),
  pass: z.number().int().min(1),
  kind: z.enum(["qa", "security"]),
  forge: z.enum(["github", "gitlab"]),
  pr: z.number().int().min(1),
  comments: z.number().int().min(0),
  notes: z.number().int().min(0),
});

const recordPublication = agentEventCommand({
  name: "publish_review",
  description: "",
  inputSchema: PublishedInputSchema,
  events: ({ story, pass, kind, forge, pr, comments, notes }) => ({
    events: [
      {
        type: REVIEW_EVENT_TYPES.published,
        story,
        payload: { pass, kind, forge, pr, comments, notes },
      },
    ],
  }),
  check: ({ story, pass, kind }, state) => {
    const found = reviewOf(storyIn(state, story))?.passes.find((entry) => entry.number === pass);
    if (found === undefined || !unpublishedKinds(found).includes(kind)) {
      return reviewNotPossible(story, "already_reviewed", { pass });
    }
    return undefined;
  },
});

/**
 * Posts a closed pass on the story's pull request, one review per kind, then records it. Never
 * a pass already posted, never an open one.
 */
export async function publishPass(
  context: CommandContext,
  agent: string,
  id: string,
  story: StoryState | undefined,
  pass: ReviewPass,
): Promise<ForgePosting> {
  const target = await forgeTarget(context, story);
  if ("status" in target) return target;
  const post = target.forge.postReview?.bind(target.forge);
  if (post === undefined) return { status: "skipped", reason: "no_forge" };
  const started = story?.started;
  const text =
    started === undefined
      ? undefined
      : await context.storyDiff?.diff(started.base, pass.commit, started.base_ref);
  const diff = text === undefined ? [] : parseDiff(text);
  // One review at a time, each recorded once the forge took it: never posted twice.
  for (const kind of unpublishedKinds(pass)) {
    const review = pass.reviews[kind];
    if (review === undefined) continue;
    let drafted = reviewDraft(pass, review, diff);
    try {
      await post(target.repository, target.number, drafted.draft);
    } catch (error) {
      // The forge may refuse a line its own diff does not show (GitHub answers 422 for the whole
      // review): posted again with every finding in the text, else failed.
      if (drafted.comments === 0) return { status: "failed", message: oneLineMessage(error) };
      const flat = reviewDraft(pass, review, diff, false);
      try {
        await post(target.repository, target.number, flat.draft);
        drafted = flat;
      } catch {
        return { status: "failed", message: oneLineMessage(error) };
      }
    }
    const recorded = await recordPublication.run(context, {
      agent,
      story: id,
      pass: pass.number,
      kind,
      forge: target.repository.forge,
      pr: target.number,
      comments: drafted.comments,
      notes: drafted.notes,
    });
    if (!recorded.ok) {
      return {
        status: "failed",
        message: `posted on the pull request, but not recorded (${recorded.error.code})`,
      };
    }
  }
  return { status: "posted", forge: target.repository.forge, pr: target.number };
}

function oneLineMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The security reasons of a change that belongs to no story: its paths alone speak. */
function freeReasons(files: readonly ChangeFile[]): ReviewSecurity["reasons"] {
  return securityReasons({
    paths: files.map((file) => file.path),
    text: "",
    securityReviewer: false,
    qaFlag: false,
  });
}

/** What the engine kept of a free review at its start, or undefined. */
async function readFreeMeta(context: CommandContext, id: string): Promise<FreeMeta | undefined> {
  const path = `${freeDirOf(id)}/meta.json`;
  try {
    if (!(await context.files.exists(path))) return undefined;
    const meta = JSON.parse(await context.files.readText(path)) as Partial<FreeMeta>;
    const files = Array.isArray(meta.files) ? meta.files : undefined;
    if (
      meta.id !== id ||
      typeof meta.source !== "string" ||
      typeof meta.intent !== "string" ||
      files === undefined ||
      !files.every(
        (file) =>
          typeof file?.path === "string" &&
          typeof file.added === "number" &&
          typeof file.removed === "number",
      )
    ) {
      return undefined;
    }
    return { id, source: meta.source, intent: meta.intent, files };
  } catch {
    return undefined;
  }
}

/** The reports of a free review, checked and merged against what the engine asked at its start. */
function assembleFree(input: SubmitReviewInput, meta: FreeMeta): Assembled | AgentPluggedError {
  const reasons = freeReasons(meta.files);
  return assembleReports(input, {
    label: FREE,
    files: meta.files,
    reasons,
    securityByQa: reasons.length > 0,
    criteria: 1,
    engine: [],
  });
}

/** What `submit_review` gives back for a free review: its id, verdict and the stack to tell the creator. */
export interface FreeReviewSubmitted extends RecordedEvent {
  readonly review: string;
  readonly verdict: string;
  readonly stack: CreatorStack;
  /** Findings the judge refuted: counted, never shown. */
  readonly refuted: number;
  /** The lenses (or the judge) that gave no report: said, so that a short stack is not taken for a clean review. */
  readonly incomplete: readonly SilentPart[];
}

interface FreePrepared {
  readonly domains: ReadonlyMap<string, string>;
  readonly meta: FreeMeta | undefined;
}

/** Records a free review in the journal with no story. */
const recordFree = agentEventCommand<typeof SubmitReviewInputSchema, FreePrepared>({
  name: "submit_free_review",
  description: "",
  inputSchema: SubmitReviewInputSchema,
  prepare: async (input, context, _agents, config) => ({
    domains: await activeDomains(context, config),
    meta: await readFreeMeta(context, input.commit),
  }),
  events: (input, _state, prepared) => {
    const meta = prepared?.meta;
    const assembled = meta === undefined ? undefined : assembleFree(input, meta);
    if (meta === undefined || assembled === undefined || assembled instanceof AgentPluggedError) {
      // Refused by `check` before anything is written: the plan only has to exist.
      return { events: [{ type: REVIEW_EVENT_TYPES.freeReviewed, payload: {} }] };
    }
    return {
      events: [
        {
          type: REVIEW_EVENT_TYPES.freeReviewed,
          payload: {
            commit: input.commit,
            source: meta.source,
            intent: meta.intent,
            files: meta.files.length,
            summary: input.summary,
            findings: assembled.findings.map((finding) => defined({ ...finding })),
            verdict: reviewVerdictOf(assembled.findings),
            ...assembled.meta,
          },
        },
      ],
    };
  },
  check: (input, _state, { prepared }) => {
    if (
      input.agent === MAIN_SESSION_AGENT ||
      prepared?.domains.get(input.agent) !== REVIEW_DOMAINS.qa
    ) {
      return reviewNotPossible(FREE, "free_not_reviewer", {
        agent: input.agent,
        domain: REVIEW_DOMAINS.qa,
      });
    }
    if (input.kind !== "qa") {
      return reviewNotPossible(FREE, "free_not_reviewer", {
        agent: input.agent,
        domain: REVIEW_DOMAINS.qa,
      });
    }
    if (prepared.meta === undefined) {
      return reviewNotPossible(FREE, "free_unknown", { commit: input.commit });
    }
    const assembled = assembleFree(input, prepared.meta);
    return assembled instanceof AgentPluggedError ? assembled : undefined;
  },
});

async function submitFree(
  context: CommandContext,
  input: Readonly<Record<string, unknown>>,
  parsed: SubmitReviewInput,
): Promise<CommandResult<FreeReviewSubmitted>> {
  const recorded = await recordFree.run(context, input);
  if (!recorded.ok) return recorded;
  const meta = await readFreeMeta(context, parsed.commit);
  const assembled = meta === undefined ? undefined : assembleFree(parsed, meta);
  if (assembled === undefined || assembled instanceof AgentPluggedError) {
    return fail(
      new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
        reason: "submit_review: the free review was written but cannot be read back",
      }),
    );
  }
  const silent = assembled.meta.silent ?? [];
  return ok({
    ...recorded.value,
    review: reviewIdOf(recorded.value.id),
    verdict: reviewVerdictOf(assembled.findings),
    stack: creatorStack(
      assembled.findings.map((finding) => stackEntryOf(finding, null)),
      STACK_SHOWN,
      silent,
      {
        total: assembled.meta.ruled?.refuted ?? 0,
        blocking: (assembled.meta.refuted ?? []).filter((entry) => entry.severity === "blocking")
          .length,
      },
    ),
    refuted: assembled.meta.ruled?.refuted ?? 0,
    incomplete: silent,
  });
}

export const submitReviewCommand = defineCommand<ReviewSubmitted | FreeReviewSubmitted>({
  ...recordReview,
  async run(context, input) {
    const given = SubmitReviewInputSchema.safeParse(input);
    // No story, a free review: recorded in the journal with no story.
    if (given.success && given.data.story === undefined) {
      return await submitFree(context, input, given.data);
    }
    const result = await recordReview.run(context, input);
    if (!result.ok) return result;
    const parsed = SubmitReviewInputSchema.parse(input);
    const state = await currentState(context);
    const story = storyIn(state, storyOf(parsed));
    const id = reviewIdOf(result.value.id);
    const pass = passOfReview(story, id);
    const record = pass?.reviews[parsed.kind];
    if (pass === undefined || record === undefined) {
      return fail(
        new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
          reason: "submit_review: the review was written but not applied",
        }),
      );
    }
    // Only the review that closed the pass posts it: two reviewers ending at once post it once.
    const published =
      pass.complete && pass.closed_by === result.value.id
        ? await publishPass(context, parsed.agent, storyOf(parsed), story, pass).catch(
            (error: unknown): ForgePosting => ({
              status: "failed",
              message: oneLineMessage(error),
            }),
          )
        : pass.complete
          ? ({ status: "posted_by_other" } as const)
          : ({ status: "pass_open" } as const);
    return ok({
      ...result.value,
      review: id,
      verdict: record.verdict,
      pass: pass.number,
      complete: pass.complete,
      outcome: pass.outcome,
      security: pass.security,
      published,
      // The findings the judge refuted are counted, a silent lens is said.
      ...(record.ruled === undefined || record.ruled.refuted === 0
        ? {}
        : { refuted: record.ruled.refuted }),
      ...(record.silent === undefined ? {} : { incomplete: record.silent }),
    });
  },
});

const triageReview = agentEventCommand({
  name: "triage_review",
  description:
    "Sort the findings of your story's closed review passes: you are the story's developer. Each item names a `finding` (R-…-n, from get_review), its `decision` (`fix`: you fix it on the story's branch; `defer`: you recorded it first with defer_work, linked to the story, and give its `deferred` id D-…; `reject`: with its `reason`), and its `root_cause` in one line: findings of one cause carry the same words. Sort before you send the story back to review: the merge waits until every finding is sorted. A `fix` on a pass that approved the story sends it back to you (in progress): fix it, then send it to review again for a new pass, since the commit reviewed is no longer the one to merge. Refused with REVIEW_NOT_POSSIBLE (not_developer, unknown_finding, pass_open: a pass not closed yet, already_triaged, deferred_unknown, done, not_started).",
  inputSchema: TriageReviewInputSchema,
  needsState: () => true,
  events: ({ story: id, items }, state) => {
    const events: { type: string; story: string; payload: Record<string, unknown> }[] = [
      {
        type: REVIEW_EVENT_TYPES.triaged,
        story: id,
        payload: { items: items.map((item) => defined({ ...item })) },
      },
    ];
    // A fix on a pass that approved the story is a pass without agreement too: when it is the
    // one that reaches the limit, the creator is asked, as after failed passes.
    const projected = state ?? {};
    const story = storyIn(projected, id);
    const fixedPasses = new Set(
      items
        .filter((item) => item.decision === "fix")
        .map((item) => findFinding(story, item.finding)?.pass)
        .filter(
          (pass): pass is ReviewPass =>
            pass !== undefined && pass.outcome === "approved" && !changesAfter(pass),
        ),
    );
    const checkpoints = Object.values(checkpointsOf(projected));
    if (
      story?.status === "in_review" &&
      fixedPasses.size > 0 &&
      reviewLoopReached(story, id, checkpoints, fixedPasses.size)
    ) {
      events.push({
        type: CHECKPOINT_EVENT_TYPES.opened,
        story: id,
        payload: loopCheckpoint(id, 0),
      });
    }
    return { events };
  },
  check: ({ agent, story: id, items }, state) => {
    const story = storyIn(state, id);
    if (story?.started === undefined) return reviewNotPossible(id, "not_started");
    const checkpoints = Object.values(checkpointsOf(state));
    if (storyDoneAt(checkpoints, id, story) !== undefined) return reviewNotPossible(id, "done");
    if (!isStoryDeveloper(story, agent)) {
      return reviewNotPossible(id, "not_developer", { agent, developer: story.started.agent });
    }
    const deferred = (state.deferred as Record<string, DeferredItem> | undefined) ?? {};
    for (const item of items) {
      const found = findFinding(story, item.finding);
      if (found === undefined)
        return reviewNotPossible(id, "unknown_finding", { finding: item.finding });
      if (!found.pass.complete)
        return reviewNotPossible(id, "pass_open", { finding: item.finding });
      if (found.finding.triage !== null) {
        return reviewNotPossible(id, "already_triaged", { finding: item.finding });
      }
      if (item.deferred !== undefined) {
        const entry = Object.hasOwn(deferred, item.deferred) ? deferred[item.deferred] : undefined;
        if (
          entry === undefined ||
          entry.status !== "open" ||
          (entry.story !== id && !entry.locks.includes(id))
        ) {
          return reviewNotPossible(id, "deferred_unknown", { deferred: item.deferred });
        }
      }
    }
    return undefined;
  },
});

export const triageReviewCommand = triageReview;

/** One finding as `get_review` shows it. */
export interface ReviewFindingView {
  readonly id: string;
  readonly kind: ReviewKind;
  readonly pass: number;
  readonly severity: string;
  readonly title: string;
  readonly detail: string | null;
  readonly path: string | null;
  readonly line: number | null;
  /** The lens that found it, the criterion it threatens, the advice, the other lenses. */
  readonly lens: string | null;
  readonly criterion: number | null;
  readonly recommendation: string | null;
  readonly also: readonly string[] | null;
  /** `undecided` when the judge could not settle it; `story` when the story itself is the cause. */
  readonly ruling: string | null;
  readonly cause: string | null;
  readonly triage: {
    readonly decision: string;
    /** The developer's words: null for a reviewer. */
    readonly root_cause: string | null;
    readonly reason: string | null;
    readonly deferred: string | null;
  } | null;
}

/** What `get_review` gives. */
export interface ReviewRead {
  readonly story: string;
  /** `developer`: everything of the closed passes; `reviewer`: your own reviews only. */
  readonly as: "developer" | "reviewer";
  readonly passes: readonly {
    readonly number: number;
    readonly commit: string;
    readonly complete: boolean;
    readonly outcome: string | null;
    readonly security: ReviewSecurity;
    readonly reviews: readonly {
      readonly id: string;
      readonly kind: ReviewKind;
      readonly by: string;
      readonly verdict: string;
      readonly summary: string;
    }[];
    readonly published: boolean;
  }[];
  readonly findings: readonly ReviewFindingView[];
  /** What the creator is shown: blocking first, one line each; the fixed ones counted (the developer reads it). */
  readonly stack?: CreatorStack;
  /** The file that says what to do with the findings whose cause is the story. */
  readonly amend?: string;
  /** The findings left to sort, by id. */
  readonly untriaged: readonly string[];
  /** The sorted findings grouped by their root cause. */
  readonly root_causes: readonly {
    readonly root_cause: string;
    readonly findings: readonly string[];
  }[];
}

/** The review of a story as `agent` may read it, or why not. */
export function reviewRead(
  state: ProjectionState["state"],
  id: string,
  agent: string,
): ReviewRead | AgentPluggedError {
  const story = storyIn(state, id);
  if (story?.started === undefined) return reviewNotPossible(id, "not_started");
  const developer = isStoryDeveloper(story, agent);
  const passes = reviewOf(story)?.passes ?? [];
  const reviewer =
    !developer &&
    agent !== MAIN_SESSION_AGENT &&
    passes.some((pass) => Object.values(pass.reviews).some((review) => review?.by === agent));
  if (!developer && !reviewer) return reviewNotPossible(id, "not_allowed", { agent });
  // The developer reads closed passes only; a reviewer, its own reviews only.
  const visible = (pass: ReviewPass, by: string) => (developer ? pass.complete : by === agent);
  const findings: ReviewFindingView[] = [];
  const views = passes.map((pass) => {
    const reviews = (["qa", "security"] as const).flatMap((kind) => {
      const review = pass.reviews[kind];
      if (review === undefined || !visible(pass, review.by)) return [];
      for (const finding of review.findings) {
        findings.push({
          id: finding.id,
          kind,
          pass: pass.number,
          severity: finding.severity,
          title: finding.title,
          detail: finding.detail ?? null,
          path: finding.path ?? null,
          line: finding.line ?? null,
          lens: finding.lens ?? null,
          criterion: finding.criterion ?? null,
          recommendation: finding.recommendation ?? null,
          also: finding.also ?? null,
          ruling: finding.ruling === "undecided" ? "undecided" : null,
          cause: finding.cause ?? null,
          triage:
            finding.triage === null
              ? null
              : {
                  decision: finding.triage.decision,
                  root_cause: developer ? finding.triage.root_cause : null,
                  // The author's reasoning stays with the developer.
                  reason: developer ? finding.triage.reason : null,
                  deferred: finding.triage.deferred,
                },
        });
      }
      return [
        { id: review.id, kind, by: review.by, verdict: review.verdict, summary: review.summary },
      ];
    });
    return {
      number: pass.number,
      commit: pass.commit,
      complete: pass.complete,
      outcome: pass.outcome,
      security: pass.security,
      reviews,
      published: unpublishedKinds(pass).length === 0,
    };
  });
  const causes = new Map<string, string[]>();
  for (const finding of findings) {
    if (finding.triage === null || finding.triage.root_cause === null) continue;
    const list = causes.get(finding.triage.root_cause) ?? [];
    list.push(finding.id);
    causes.set(finding.triage.root_cause, list);
  }
  const untriaged = developer ? untriagedFindings(story).map((finding) => finding.id) : [];
  return {
    story: id,
    as: developer ? "developer" : "reviewer",
    passes: views,
    findings,
    ...(developer
      ? {
          stack: creatorStack(
            stackEntriesOf(story, passes.filter((pass) => pass.complete).at(-1)?.number ?? 0),
            STACK_SHOWN,
            silentOf(story, passes.filter((pass) => pass.complete).at(-1)?.number ?? 0),
            refutedOf(story, passes.filter((pass) => pass.complete).at(-1)?.number ?? 0),
          ),
        }
      : {}),
    // A finding whose cause is the story is not patched in the code: where to read how.
    ...(developer &&
    findings.some((finding) => finding.cause === "story" && finding.triage === null)
      ? { amend: `${METHOD_DIR}/skills/review-story/references/amend-story.md` }
      : {}),
    untriaged,
    root_causes: [...causes].map(([root_cause, ids]) => ({ root_cause, findings: ids })),
  };
}

export const getReviewCommand = defineCommand<ReviewRead>({
  name: "get_review",
  audience: "agent",
  description:
    "Read a story's review. The story's developer reads every closed pass: the reviews, their findings (R-…-n), how each was sorted, the findings left to sort (`untriaged`) and the root causes; a reviewer reads only its own reviews, never the other reviewer's. Any other agent: REVIEW_NOT_POSSIBLE not_allowed.",
  inputSchema: StoryReviewInputSchema,
  async run(context, input) {
    const parsed = StoryReviewInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("get_review", parsed.error));
    try {
      const target = await agentWriteContext(context, parsed.data.agent);
      if (target instanceof AgentPluggedError) return fail(target);
      const read = reviewRead(await currentState(context), parsed.data.story, parsed.data.agent);
      return read instanceof AgentPluggedError ? fail(read) : ok(read);
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** What `publish_review` did, pass by pass. */
export interface ReviewPublished {
  readonly story: string;
  readonly passes: readonly { readonly pass: number; readonly published: ForgePosting }[];
}

export const publishReviewCommand = defineCommand<ReviewPublished>({
  name: "publish_review",
  audience: "agent",
  description:
    "Post on the pull request the closed review passes of a story the forge did not take yet, when submit_review said `published: failed` or `skipped` (the forge was not linked, or the pull request not open). For the story's developer or one of its reviewers. A pass already posted is never posted again; an open pass never is.",
  inputSchema: StoryReviewInputSchema,
  async run(context, input) {
    const parsed = StoryReviewInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("publish_review", parsed.error));
    const { agent, story: id } = parsed.data;
    try {
      const target = await agentWriteContext(context, agent);
      if (target instanceof AgentPluggedError) return fail(target);
      const state = await currentState(context);
      const read = reviewRead(state, id, agent);
      if (read instanceof AgentPluggedError) return fail(read);
      const story = storyIn(state, id);
      const passes: { pass: number; published: ForgePosting }[] = [];
      for (const pass of reviewOf(story)?.passes ?? []) {
        if (unpublishedKinds(pass).length === 0) continue;
        passes.push({
          pass: pass.number,
          published: await publishPass(context, agent, id, story, pass),
        });
      }
      return ok({ story: id, passes });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/** The review's tools, exposed as MCP tools after the others. */
export const reviewAgentCommands = [
  startReviewCommand,
  submitReviewCommand,
  exportReviewCommand,
  triageReviewCommand,
  getReviewCommand,
  publishReviewCommand,
] as const;
