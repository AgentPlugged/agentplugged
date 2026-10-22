import {
  MAX_REVIEW_PASSES,
  type ReviewFinding,
  type ReviewKind,
  type ReviewSecurity,
  type ReviewVerdict,
  type SecurityReason,
  type SilentPart,
  type TriageDecision,
} from "@agentplugged/protocol";
import { currentDeveloper } from "../agents/agent-aliases.js";
import { isSkipped } from "../journey/journey-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { qaStackEntries } from "../qa/qa-rules.js";
import type { StackEntry } from "./review-lenses.js";

/**
 * The rules of a story's independent review, pure: the verdict of a review, whether a
 * story concerns security, the lines of a diff a comment may sit on, the passes of a review, and
 * whether the review is done.
 */

/** A finding as the projection keeps it: its id and how the developer sorted it. */
export interface ReviewFindingState extends ReviewFinding {
  readonly id: string;
  triage: FindingTriage | null;
}

/** How the story's developer sorted a finding. */
export interface FindingTriage {
  readonly decision: TriageDecision;
  readonly root_cause: string;
  readonly reason: string | null;
  readonly deferred: string | null;
  readonly by: string;
  readonly at: string;
  readonly event: string;
}

/** One review of a pass, as `story.reviewed` recorded it. */
export interface ReviewRecord {
  /** `R-…`. */
  readonly id: string;
  readonly kind: ReviewKind;
  readonly event: string;
  readonly by: string;
  readonly at: string;
  readonly verdict: ReviewVerdict;
  readonly summary: string;
  readonly findings: ReviewFindingState[];
  /** The lenses (or the judge) that gave no report: the review is possibly incomplete. */
  readonly silent?: readonly SilentPart[];
  /** How the judge ruled on the lenses' findings (the refuted ones are counted here only). */
  readonly ruled?: {
    readonly confirmed: number;
    readonly refuted: number;
    readonly undecided: number;
  };
  /** Among the refuted ones, those a reader had called blocking. */
  readonly refutedBlocking?: number;
}

/** One review of a closed pass posted on the pull request. */
export interface ReviewPublication {
  readonly forge: string;
  readonly pr: number;
  readonly comments: number;
  readonly notes: number;
  readonly by: string;
  readonly at: string;
  readonly event: string;
}

/**
 * One pass: the reviews of one commit given while the story was in review since `since` (its
 * last status, when it went to review). Closed once its quality review is in, and its security
 * review too when the pass needs one.
 */
export interface ReviewPass {
  readonly number: number;
  readonly since: string;
  readonly commit: string;
  reviews: Partial<Record<ReviewKind, ReviewRecord>>;
  /** Why it needs a security review, as its last review recorded it. */
  security: ReviewSecurity;
  complete: boolean;
  /** `approved`: closed without a failed review; `changes_requested`: with one. */
  outcome: "approved" | "changes_requested" | null;
  completed_at: string | null;
  /** The event of the review that closed it: only that call posts the pass. */
  closed_by: string | null;
  /** Its reviews posted on the pull request, by kind. */
  published: Partial<Record<ReviewKind, ReviewPublication>>;
}

/** `state.stories[id].review`: the passes of the story's review, in order. */
export interface StoryReview {
  passes: ReviewPass[];
}

/** The verdict of a review: a blocking finding fails it; a finding to fix reserves it. */
export function reviewVerdictOf(
  findings: readonly Pick<ReviewFinding, "severity">[],
): ReviewVerdict {
  if (findings.some((finding) => finding.severity === "blocking")) return "fail";
  if (findings.some((finding) => finding.severity === "should_fix"))
    return "pass_with_reservations";
  return "pass";
}

/** Dependency manifests and lockfiles, CI, containers, infrastructure and secrets' files. */
const SENSITIVE_FILES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lockb",
  "bun.lock",
  "deno.json",
  "deno.lock",
  "pipfile",
  "pipfile.lock",
  "pyproject.toml",
  "poetry.lock",
  "uv.lock",
  "setup.py",
  "setup.cfg",
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile",
  "gemfile.lock",
  "composer.json",
  "composer.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "packages.config",
  "directory.packages.props",
  "package.swift",
  "package.resolved",
  "podfile",
  "podfile.lock",
  "pubspec.yaml",
  "pubspec.lock",
  "mix.exs",
  "mix.lock",
  "jenkinsfile",
  ".gitlab-ci.yml",
  ".travis.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".pypirc",
  "nginx.conf",
  ".htaccess",
]);

/** Folders whose files run with rights: CI and automation. */
const SENSITIVE_FOLDERS = [
  ".github/",
  ".circleci/",
  ".buildkite/",
  ".woodpecker/",
  ".gitlab/",
  "migrations/",
  "migration/",
  "db/migrate/",
];

/** Names of files that are sensitive by their pattern. */
const SENSITIVE_NAMES = [
  /^dockerfile/,
  /^containerfile/,
  /^docker-compose.*\.ya?ml$/,
  /^compose.*\.ya?ml$/,
  /\.tf$/,
  /\.tfvars$/,
  /^\.env(?:\..*)?$/,
  /\.(?:pem|key|crt|p12|pfx|jks|keystore)$/,
  /\.csproj$/,
  /requirements.*\.txt$/,
  /^\.?secrets?\./,
  /\.sql$/,
  /^schema\.prisma$/,
];

/**
 * Words of a path that speak of security, matched whole (`auth`, not `authors`), and stems
 * matched at a word's start (`encrypt…`, `password…`): authentication, secrets, rights, payment,
 * untrusted input.
 */
const SENSITIVE_WORDS = new Set([
  "auth",
  "authn",
  "authz",
  "oidc",
  "saml",
  "sso",
  "login",
  "logout",
  "signin",
  "signup",
  "session",
  "sessions",
  "token",
  "tokens",
  "jwt",
  "secret",
  "secrets",
  "acl",
  "acls",
  "rbac",
  "csrf",
  "cors",
  "cookie",
  "cookies",
  "vault",
  "mfa",
  "totp",
  "otp",
  "payment",
  "payments",
  "billing",
  "checkout",
  "upload",
  "uploads",
  "security",
  "keychain",
  "keystore",
  "admin",
  "securite",
  "connexion",
  "motdepasse",
]);
const SENSITIVE_STEMS = [
  "authent",
  "authori",
  "oauth",
  "credential",
  "password",
  "passwd",
  "crypt",
  "encrypt",
  "decrypt",
  "cipher",
  "permission",
  "sanitiz",
];

/** The words of a path: its segments, split on `.`, `_`, `-` and camel case, in lower case. */
function pathWords(path: string): string[] {
  return path
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s/._-]+/)
    .filter((word) => word !== "");
}

/** True when a changed path concerns security, whatever the language of the product. */
export function sensitivePath(path: string): boolean {
  const lower = path.replaceAll("\\", "/").toLowerCase();
  const name = lower.split("/").at(-1) ?? lower;
  if (SENSITIVE_FILES.has(name)) return true;
  if (SENSITIVE_FOLDERS.some((folder) => lower.startsWith(folder) || lower.includes(`/${folder}`)))
    return true;
  if (SENSITIVE_NAMES.some((pattern) => pattern.test(name))) return true;
  return pathWords(path).some(
    (word) => SENSITIVE_WORDS.has(word) || SENSITIVE_STEMS.some((stem) => word.startsWith(stem)),
  );
}

/** Security words in French and English, compared without accents nor case. */
const SECURITY_WORDS =
  /\b(?:secu|vulnerab|cve\b|exploit|password|mots? de passe|secret|authent|authori[sz]|auth\b|oauth|login|log in|sign in|se connecter|page de connexion|identifiants de connexion|token|jeton|chiffrement|chiffrer|dechiffr|autoris|encrypt|decrypt|crypt|permission|access control|controle d.acces|droits? d.acces|payment|paiement|billing|facturation|upload|televers|personal data|donnees personnelles|pii\b|gdpr|rgpd|injection|xss|csrf|cookie)/;

/** True when a story's text speaks of security. */
export function securityWords(text: string): boolean {
  const plain = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return SECURITY_WORDS.test(plain);
}

/** What `securityReasons` reads: the diff's paths, the story's text and header, the QA's ask. */
export interface SecurityInputs {
  readonly paths: readonly string[];
  readonly text: string;
  /** The story's header names a reviewer of the security domain. */
  readonly securityReviewer: boolean;
  /** The quality reviewer of this pass asked for a security review. */
  readonly qaFlag: boolean;
}

/** Why a story concerns security, in a stable order: empty when it does not. */
export function securityReasons(inputs: SecurityInputs): SecurityReason[] {
  const reasons: SecurityReason[] = [];
  if (inputs.paths.some(sensitivePath)) reasons.push("paths");
  if (securityWords(inputs.text)) reasons.push("words");
  if (inputs.securityReviewer) reasons.push("reviewer");
  if (inputs.qaFlag) reasons.push("qa_flag");
  return reasons;
}

/** True when the pass waits for a security review: a reason, and a security reviewer active. */
export function needsSecurity(security: ReviewSecurity): boolean {
  return security.reasons.length > 0 && security.unavailable !== true;
}

/** One file of a diff: its path on each side, its counts, and the lines a comment may sit on. */
export interface DiffFile {
  readonly path: string;
  readonly old_path: string | null;
  readonly added: number;
  readonly removed: number;
  /** The lines of the new side shown by the diff (added or context), with their old line. */
  readonly lines: ReadonlyMap<number, number | null>;
}

/** A path of a diff header (`a/x`, `b/x`, a quoted path), or null for `/dev/null`. */
function diffPath(raw: string, prefix: "a/" | "b/"): string | null {
  let text = raw.trim();
  if (text === "/dev/null") return null;
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      text = JSON.parse(text) as string;
    } catch {
      text = text.slice(1, -1);
    }
  }
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** The files of a unified diff (`git diff`), in order. */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let current:
    | {
        path: string;
        old_path: string | null;
        added: number;
        removed: number;
        lines: Map<number, number | null>;
      }
    | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const flush = () => {
    if (current !== undefined) files.push(current);
    current = undefined;
  };
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      flush();
      const match = /^diff --git (?:"?a\/)(.+?)"? (?:"?b\/)(.+?)"?$/.exec(line);
      current = {
        path: match?.[2] ?? "",
        old_path: match?.[1] ?? null,
        added: 0,
        removed: 0,
        lines: new Map(),
      };
      inHunk = false;
      continue;
    }
    if (current === undefined) continue;
    if (!inHunk && line.startsWith("--- ")) {
      current.old_path = diffPath(line.slice(4), "a/");
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const path = diffPath(line.slice(4), "b/");
      if (path !== null) current.path = path;
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      current.added += 1;
      current.lines.set(newLine, null);
      newLine += 1;
    } else if (line.startsWith("-")) {
      current.removed += 1;
      oldLine += 1;
    } else if (line.startsWith(" ")) {
      current.lines.set(newLine, oldLine);
      newLine += 1;
      oldLine += 1;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file"
    } else if (line === "") {
      // A blank line at the end of the text.
    } else {
      inHunk = false;
    }
  }
  flush();
  return files.filter((file) => file.path !== "");
}

/** The story's developer: the agent `story.started` records, and its successor. */
export function isStoryDeveloper(story: StoryState | undefined, agent: string): boolean {
  const started = story?.started?.agent;
  if (started === undefined) return false;
  return agent === started || currentDeveloper(agent) === currentDeveloper(started);
}

/** The review of a story, as the projection keeps it (none before the first review). */
export function reviewOf(story: StoryState | undefined): StoryReview | undefined {
  return story?.review;
}

/**
 * The pass a review of `commit` joins: the last pass, when it was given since the story's last
 * status (the same stay in review) on the same commit; undefined when the review opens a new one.
 */
export function currentPass(story: StoryState | undefined, commit: string): ReviewPass | undefined {
  const last = reviewOf(story)?.passes.at(-1);
  const since = story?.status_by?.at;
  if (last === undefined || since === undefined) return undefined;
  return last.since === since && last.commit === commit ? last : undefined;
}

/** The number the next review of `commit` gets: its pass's, or the next one. */
export function passNumberFor(story: StoryState | undefined, commit: string): number {
  const pass = currentPass(story, commit);
  if (pass !== undefined) return pass.number;
  return (reviewOf(story)?.passes.at(-1)?.number ?? 0) + 1;
}

/** The reviews of a closed pass not posted on the pull request yet, in order. */
export function unpublishedKinds(pass: ReviewPass): ReviewKind[] {
  if (!pass.complete) return [];
  return (["qa", "security"] as const).filter(
    (kind) => pass.reviews[kind] !== undefined && pass.published[kind] === undefined,
  );
}

/**
 * True when every review the pass needs is in. The creator may skip the security review of the story
 * (`securitySkipped`): the quality review then closes the pass.
 */
export function passComplete(
  pass: Pick<ReviewPass, "reviews" | "security">,
  securitySkipped = false,
): boolean {
  if (pass.reviews.qa === undefined) return false;
  return securitySkipped || !needsSecurity(pass.security) || pass.reviews.security !== undefined;
}

/** How a closed pass ends: changes requested when one of its reviews failed. */
export function passOutcome(pass: Pick<ReviewPass, "reviews">): "approved" | "changes_requested" {
  return Object.values(pass.reviews).some((review) => review?.verdict === "fail")
    ? "changes_requested"
    : "approved";
}

/** Every finding of the story's closed passes, in order. */
export function closedFindings(story: StoryState | undefined): ReviewFindingState[] {
  return (reviewOf(story)?.passes ?? [])
    .filter((pass) => pass.complete)
    .flatMap((pass) =>
      (["qa", "security"] as const).flatMap((kind) => pass.reviews[kind]?.findings ?? []),
    );
}

/** The findings of closed passes the developer has not sorted yet. */
export function untriagedFindings(story: StoryState | undefined): ReviewFindingState[] {
  return closedFindings(story).filter((finding) => finding.triage === null);
}

/** The finding `id` of the story, with its pass, or undefined. */
export function findFinding(
  story: StoryState | undefined,
  id: string,
): { finding: ReviewFindingState; pass: ReviewPass } | undefined {
  for (const pass of reviewOf(story)?.passes ?? []) {
    for (const kind of ["qa", "security"] as const) {
      const finding = pass.reviews[kind]?.findings.find((entry) => entry.id === id);
      if (finding !== undefined) return { finding, pass };
    }
  }
  return undefined;
}

/**
 * Whether a story's review is done: in review, its last pass given during this stay
 * in review, closed without a failed review, on the commit of its CI (and on `head` when known),
 * and every finding of its closed passes sorted.
 */
export function storyReviewDone(
  story: StoryState | undefined,
  head?: string,
  /** The creator skipped the story's CI: a review is not bound to the commit a CI read. */
  ciSkipped = false,
): boolean {
  if (story?.status !== "in_review" || story.started === undefined) return false;
  const last = reviewOf(story)?.passes.at(-1);
  if (last === undefined || !last.complete || last.outcome !== "approved") return false;
  if (last.since !== story.status_by?.at) return false;
  if (!ciSkipped && (story.ci === undefined || story.ci.commit !== last.commit)) return false;
  if (head !== undefined && head !== last.commit) return false;
  return untriagedFindings(story).length === 0;
}

/**
 * Every finding the creator may be shown for a story's merge: those of the closed
 * passes and of the pass `current` (the one being closed, or just closed), with how the developer
 * sorted each. `override` is a review not recorded yet: it takes the place of the pass's review
 * of its kind, so that the command and the reducer read the same list in the same order.
 */
export function stackEntriesOf(
  story: StoryState | undefined,
  current: number,
  override?: { readonly kind: ReviewKind; readonly findings: readonly ReviewFinding[] },
): StackEntry[] {
  const entry = stackEntryOf;
  const passes = reviewOf(story)?.passes ?? [];
  const earlier = passes
    // A pass left open is closed as it stands when the next one begins.
    .filter((pass) => pass.number < current)
    .flatMap((pass) =>
      (["qa", "security"] as const).flatMap((kind) =>
        (pass.reviews[kind]?.findings ?? []).map((finding) =>
          entry(finding, finding.triage?.decision ?? null),
        ),
      ),
    );
  const pass = passes.find((candidate) => candidate.number === current);
  const now = (["qa", "security"] as const).flatMap((kind) =>
    override?.kind === kind
      ? override.findings.map((finding) => entry(finding, null))
      : (pass?.reviews[kind]?.findings ?? []).map((finding) =>
          entry(finding, finding.triage?.decision ?? null),
        ),
  );
  // What failed in the acceptance QA in a browser is a finding of the story too.
  return [...earlier, ...now, ...qaStackEntries(story?.qa)];
}

/** A finding as the creator's stack reads it, sorted or not. */
export function stackEntryOf(finding: ReviewFinding, decision: TriageDecision | null): StackEntry {
  return {
    severity: finding.severity,
    title: finding.title,
    path: finding.path,
    line: finding.line,
    criterion: finding.criterion,
    lens: finding.lens,
    recommendation: finding.recommendation,
    ruling: finding.ruling,
    cause: finding.cause,
    decision,
  };
}

/**
 * The lenses (or the judge) that gave no report in the pass `current` of the story:
 * what the creator is told when the stack is short, so that an empty stack is never taken for a
 * clean review. `override` is a review not recorded yet.
 */
export function silentOf(
  story: StoryState | undefined,
  current: number,
  override?: { readonly kind: ReviewKind; readonly silent?: readonly SilentPart[] },
): SilentPart[] {
  const pass = reviewOf(story)?.passes.find((candidate) => candidate.number === current);
  const parts = (["qa", "security"] as const).flatMap((kind) =>
    override?.kind === kind ? (override.silent ?? []) : (pass?.reviews[kind]?.silent ?? []),
  );
  return [...new Set(parts)];
}

/**
 * What the judge set aside in the pass `current` of the story, counted: the findings it
 * refuted, and those a reader had called blocking. `override` is a review not recorded yet.
 */
export function refutedOf(
  story: StoryState | undefined,
  current: number,
  override?: { readonly kind: ReviewKind; readonly total: number; readonly blocking: number },
): { total: number; blocking: number } {
  const pass = reviewOf(story)?.passes.find((candidate) => candidate.number === current);
  let total = 0;
  let blocking = 0;
  for (const kind of ["qa", "security"] as const) {
    if (override?.kind === kind) {
      total += override.total;
      blocking += override.blocking;
      continue;
    }
    total += pass?.reviews[kind]?.ruled?.refuted ?? 0;
    blocking += pass?.reviews[kind]?.refutedBlocking ?? 0;
  }
  return { total, blocking };
}

/** `ReviewDoneCondition` of the merge gate: the projection's story, by id. */
export function reviewDone(state: Readonly<Record<string, unknown>>, id: string): boolean {
  const stories = state.stories as Record<string, StoryState> | undefined;
  const story = stories !== undefined && Object.hasOwn(stories, id) ? stories[id] : undefined;
  return storyReviewDone(story, undefined, isSkipped(state, "story_ci", id));
}

/** The reason a refused merge answer records when the branch moved past the commit reviewed. */
export const HEAD_MOVED = "head_moved";

/**
 * True when the story's review is done on its last pass but the branch's `head` is another
 * commit: what would be merged was never reviewed, and only a new pass opens the merge again.
 */
export function reviewedHeadMoved(
  state: Readonly<Record<string, unknown>>,
  id: string,
  head: string | undefined,
): boolean {
  if (head === undefined) return false;
  const stories = state.stories as Record<string, StoryState> | undefined;
  const story = stories !== undefined && Object.hasOwn(stories, id) ? stories[id] : undefined;
  const ciSkipped = isSkipped(state, "story_ci", id);
  return storyReviewDone(story, undefined, ciSkipped) && !storyReviewDone(story, head, ciSkipped);
}

/**
 * The choices of the review loop's point besides approving (more passes) and refusing (out of
 * review): the same more passes, or merging the story as it is, the remaining findings accepted,
 * which skips the story's review for that story as a skip of the step would.
 */
export const REVIEW_LOOP_OPTIONS = { more: "more_passes", asIs: "merge_as_is" } as const;

/** True for the checkpoint the engine opens when a story's review loop reaches its limit. */
export function isReviewLoopCheckpoint(checkpoint: CheckpointState, story: string): boolean {
  return checkpoint.story === story && checkpoint.source === "review_loop";
}

/**
 * The passes closed with changes requested since the story's last loop checkpoint opened (all of
 * them without one): at `MAX_REVIEW_PASSES`, the creator is asked.
 */
export function failedPassesSinceLoop(
  story: StoryState | undefined,
  id: string,
  checkpoints: readonly CheckpointState[],
): number {
  const loops = checkpoints.filter((checkpoint) => isReviewLoopCheckpoint(checkpoint, id));
  const from = Math.max(
    Number.NEGATIVE_INFINITY,
    ...loops.map((checkpoint) => Date.parse(checkpoint.opened_at)),
  );
  return (reviewOf(story)?.passes ?? []).filter(
    (pass) =>
      pass.complete &&
      changesAfter(pass) &&
      pass.completed_at !== null &&
      Date.parse(pass.completed_at) > from,
  ).length;
}

/**
 * True when a closed pass ended without agreement: a failed review, or an approval with a finding
 * its developer chose to fix (the code changes again, and another pass follows).
 */
export function changesAfter(pass: ReviewPass): boolean {
  if (pass.outcome === "changes_requested") return true;
  return (["qa", "security"] as const).some((kind) =>
    (pass.reviews[kind]?.findings ?? []).some((finding) => finding.triage?.decision === "fix"),
  );
}

/**
 * True when the loop checkpoint must open now: the limit reached (counting `closing` passes about
 * to close with changes requested), none of the story open.
 */
export function reviewLoopReached(
  story: StoryState | undefined,
  id: string,
  checkpoints: readonly CheckpointState[],
  closing = 0,
): boolean {
  if (
    checkpoints.some(
      (checkpoint) => isReviewLoopCheckpoint(checkpoint, id) && checkpoint.status === "open",
    )
  ) {
    return false;
  }
  return failedPassesSinceLoop(story, id, checkpoints) + closing >= MAX_REVIEW_PASSES;
}

/** The story's open merge checkpoint, the one the engine opened (`source: merge`), if any. */
export function openMergeCheckpoint(
  checkpoints: readonly CheckpointState[],
  id: string,
): CheckpointState | undefined {
  return checkpoints.find(
    (checkpoint) =>
      checkpoint.type === "story" &&
      checkpoint.source === "merge" &&
      checkpoint.story === id &&
      checkpoint.status === "open",
  );
}

/**
 * A story's review as `get_state` shows it: no finding nor summary, and nothing of an
 * open pass but which kinds are in, so that no reviewer reads the other's conclusions there.
 */
export interface ReviewSummary {
  readonly passes: readonly {
    readonly number: number;
    readonly commit: string;
    readonly complete: boolean;
    readonly outcome: "approved" | "changes_requested" | null;
    /** Closed passes only: why it needed a security review (an open one says nothing). */
    readonly security: ReviewSecurity | null;
    /** The kinds given in the pass. */
    readonly given: readonly ReviewKind[];
    /** Closed passes only: each review's verdict, reviewer and number of findings. */
    readonly reviews: Partial<
      Record<
        ReviewKind,
        { readonly verdict: ReviewVerdict; readonly by: string; readonly findings: number }
      >
    >;
    readonly published: boolean;
  }[];
  /** Findings of closed passes left to sort. */
  readonly untriaged: number;
  /** True when the review is done (`storyReviewDone`). */
  readonly done: boolean;
}

export function reviewSummaryOf(story: StoryState): ReviewSummary | undefined {
  const review = reviewOf(story);
  if (review === undefined) return undefined;
  return {
    passes: review.passes.map((pass) => ({
      number: pass.number,
      commit: pass.commit,
      complete: pass.complete,
      outcome: pass.outcome,
      security: pass.complete ? pass.security : null,
      given: (["qa", "security"] as const).filter((kind) => pass.reviews[kind] !== undefined),
      reviews: pass.complete
        ? Object.fromEntries(
            (["qa", "security"] as const).flatMap((kind) => {
              const entry = pass.reviews[kind];
              return entry === undefined
                ? []
                : [
                    [
                      kind,
                      { verdict: entry.verdict, by: entry.by, findings: entry.findings.length },
                    ],
                  ];
            }),
          )
        : {},
      published: pass.complete && unpublishedKinds(pass).length === 0,
    })),
    untriaged: untriagedFindings(story).length,
    done: storyReviewDone(story),
  };
}
