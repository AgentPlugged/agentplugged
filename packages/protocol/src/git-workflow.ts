import { z } from "zod";

/**
 * The creator's Git workflow: which branches the work lands on, whether each story has
 * a branch of its own, what checks it (a CI, and where), how a story is merged (a pull request, or
 * by the engine) and whether a review comes before. The method proposes a solid workflow (the
 * recommendation of each choice) and follows the creator's own: nothing here is imposed.
 *
 * The workflow lives in `git` of `method.yaml` (what the creator can read and edit) and in the
 * journal (`git.workflow_set`, the authority the engine reads: the choice and who made it, never
 * an agent). Absent, nothing was chosen yet: the recommendation for a solo creator applies, which
 * is what the engine did before this story.
 */

/** Where the product's CI runs: not at all, on the creator's machine, or on a forge's servers. */
export const GIT_CI_MODES = ["none", "local", "remote"] as const;
export type GitCiMode = (typeof GIT_CI_MODES)[number];

/** How a story reaches its branch: through a pull request, or merged by the engine itself. */
export const GIT_MERGE_MODES = ["pr", "direct"] as const;
export type GitMergeMode = (typeof GIT_MERGE_MODES)[number];

/** A Git branch name (`main`, `dev`, `develop`, `release/next`): the engine pushes and reads it. */
export const GitBranchSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/, { message: "expected a branch name" })
  .refine((name) => !name.includes("..") && !name.includes("//") && !name.endsWith("/"), {
    message: "expected a branch name",
  })
  .refine((name) => !name.endsWith(".lock") && name !== "HEAD", {
    message: "expected a branch name",
  })
  // Git's own rules: no component starting with a dot or ending with `.lock`, no trailing dot.
  .refine(
    (name) =>
      !name.endsWith(".") &&
      name.split("/").every((part) => !part.startsWith(".") && !part.endsWith(".lock")),
    { message: "expected a branch name" },
  );

export type GitBranch = z.infer<typeof GitBranchSchema>;

/**
 * One line of text the creator declared (an environment's name or address): no control character,
 * no line separator, no invisible mark. Defined here, not shared with the agents' texts: this file
 * is read by `method-config`, which those texts read in turn.
 */
/** Line and paragraph separators, direction marks, zero-width characters and the byte order mark. */
const HIDDEN_CODES: ReadonlySet<number> = new Set([
  0x2028,
  0x2029,
  0xfeff,
  ...Array.from({ length: 5 }, (_, i) => 0x200b + i),
  ...Array.from({ length: 2 }, (_, i) => 0x200e + i),
  ...Array.from({ length: 5 }, (_, i) => 0x202a + i),
  ...Array.from({ length: 4 }, (_, i) => 0x2066 + i),
]);

function declaredLine(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      (text) => ![...text].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f),
      { message: "expected one line" },
    )
    .refine((text) => ![...text].some((char) => HIDDEN_CODES.has(char.charCodeAt(0))), {
      message: "expected plain text",
    });
}

/** An environment the product runs in (`staging`, `production`): a name and an address, as declared. */
export const GitEnvironmentSchema = z.strictObject({
  name: declaredLine(64).optional(),
  url: declaredLine(300).optional(),
});
export type GitEnvironment = z.infer<typeof GitEnvironmentSchema>;

/**
 * `git` of `method.yaml`. `integration` is the branch the stories land on (`dev`); `production` the
 * branch deployed to the public (`main`). Both absent: the main branch only, stories land on it.
 * `integration` alone: `production` is the main branch the repository has. `environments` names
 * what each runs on: `dev` is staging (the team's tests before the public), `main` is production.
 * Every other field absent means its recommendation: a branch per story, the CI read on the forge,
 * a pull request, a review before the merge.
 */
export const GitWorkflowSchema = z
  .strictObject({
    integration: GitBranchSchema.optional(),
    production: GitBranchSchema.optional(),
    story_branches: z.boolean().optional(),
    ci: z.enum(GIT_CI_MODES).optional(),
    merge: z.enum(GIT_MERGE_MODES).optional(),
    review: z.boolean().optional(),
    environments: z
      .strictObject({
        staging: GitEnvironmentSchema.optional(),
        production: GitEnvironmentSchema.optional(),
      })
      .optional(),
  })
  .superRefine((workflow, context) => {
    if (workflow.production !== undefined && workflow.integration === undefined) {
      context.addIssue({
        code: "custom",
        path: ["production"],
        message: "a production branch goes with an integration branch",
      });
    }
    // Staging is not the main branch: without a production branch named, `main` is production.
    if (
      workflow.production === undefined &&
      (workflow.integration === "main" || workflow.integration === "master")
    ) {
      context.addIssue({
        code: "custom",
        path: ["integration"],
        message: "the integration branch differs from the production branch",
      });
    }
    if (
      workflow.production !== undefined &&
      workflow.integration !== undefined &&
      workflow.production === workflow.integration
    ) {
      context.addIssue({
        code: "custom",
        path: ["integration"],
        message: "the integration branch differs from the production branch",
      });
    }
  });
export type GitWorkflow = z.infer<typeof GitWorkflowSchema>;

/**
 * The workflow with its defaults applied, as the engine reads it: every choice has a value.
 * `integration` and `production` stay undefined for the main branch only (the main branch the
 * repository has is both): `staged` says the two differ.
 */
export interface ResolvedGitWorkflow {
  readonly integration: string | undefined;
  readonly production: string | undefined;
  /** Stories land on a branch that is not the production one (`main` + `dev`). */
  readonly staged: boolean;
  readonly story_branches: boolean;
  readonly ci: GitCiMode;
  readonly merge: GitMergeMode;
  readonly review: boolean;
  readonly environments: NonNullable<GitWorkflow["environments"]>;
}

/** The workflow's defaults: what the engine did before the creator could choose (and recommends). */
export const DEFAULT_GIT_WORKFLOW = {
  story_branches: true,
  ci: "remote",
  merge: "pr",
  review: true,
} as const satisfies Readonly<Partial<Record<keyof GitWorkflow, unknown>>>;

/** The workflow with its defaults applied (`undefined`: nothing was chosen yet). */
export function resolveGitWorkflow(workflow: GitWorkflow | undefined): ResolvedGitWorkflow {
  const integration = workflow?.integration;
  const production = workflow?.production;
  const storyBranches = workflow?.story_branches ?? DEFAULT_GIT_WORKFLOW.story_branches;
  return {
    integration,
    production,
    staged: integration !== undefined,
    story_branches: storyBranches,
    ci: workflow?.ci ?? DEFAULT_GIT_WORKFLOW.ci,
    // Without a branch of its own, a story has no pull request: it is worked on where it lands.
    merge: storyBranches ? (workflow?.merge ?? DEFAULT_GIT_WORKFLOW.merge) : "direct",
    review: workflow?.review ?? DEFAULT_GIT_WORKFLOW.review,
    environments: workflow?.environments ?? {},
  };
}

/** Where a workflow was chosen: at `init`, at the terminal (`profile`), or in the chat. */
export const GIT_WORKFLOW_SOURCES = ["init", "terminal", "chat"] as const;
export type GitWorkflowSource = (typeof GIT_WORKFLOW_SOURCES)[number];

/** Event types of the workflow, each at version 1. */
export const GIT_EVENT_TYPES = {
  /** The creator chose, or changed, their Git workflow (`init`, `profile`, the chat). */
  workflowSet: "git.workflow_set",
  /** What waited in staging went into production (the release, `main` + `dev`). */
  released: "git.released",
} as const;

/**
 * `payload` of `git.workflow_set`: the workflow chosen (whole, defaults not filled in), the one it
 * replaces (null: none was chosen), where it was chosen, and what the engine read of the repository
 * when it was (`forge`: the repository is on GitHub or GitLab). It is the engine's own record of
 * the creator's choice (`system`), written by `init` or `profile` and by the engine carrying out
 * the creator's approved `profile` action.
 */
export const GitWorkflowSetPayloadSchema = z.strictObject({
  workflow: GitWorkflowSchema,
  previous: GitWorkflowSchema.nullable(),
  source: z.enum(GIT_WORKFLOW_SOURCES),
  forge: z.boolean(),
  /** The main branch the repository has (`main`): where a story aims again once `integration` is dropped. */
  main: GitBranchSchema.optional(),
});
export type GitWorkflowSetPayload = z.infer<typeof GitWorkflowSetPayloadSchema>;

/**
 * `payload` of `git.released`: the release the engine carried out once the creator approved it,
 * written by the engine after the gesture succeeded (never before: an approved release that failed
 * leaves no trace of a release). `from` is the integration branch, `to` the production branch,
 * `commit` the integration branch's commit released, `stories` the stories it carried (merged
 * since the last release), `via` how it went in, and the pull request when there was one.
 */
export const GitReleasedPayloadSchema = z.strictObject({
  from: GitBranchSchema,
  to: GitBranchSchema,
  commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  merge_commit: z
    .string()
    .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
    .optional(),
  via: z.enum(["pr", "direct"]),
  pr: z.int().min(1).max(1_000_000_000).optional(),
  url: z.string().max(2048).optional(),
  stories: z.array(z.string().regex(/^\d{1,6}-\d{1,6}$/)).max(5000),
  checkpoint: z.string().regex(/^G-[0-9A-HJKMNP-TV-Z]{10}$/),
});
export type GitReleasedPayload = z.infer<typeof GitReleasedPayloadSchema>;

/** True when two workflows say the same (an absent one is none chosen). */
export function sameWorkflow(a: GitWorkflow | undefined, b: GitWorkflow | undefined): boolean {
  return JSON.stringify(normalizedWorkflow(a)) === JSON.stringify(normalizedWorkflow(b));
}

/** The workflow's fields in a fixed order, only those set: two workflows compare as text. */
function normalizedWorkflow(workflow: GitWorkflow | undefined): unknown {
  if (workflow === undefined) return null;
  const environment = (value: GitEnvironment | undefined) =>
    value === undefined ? null : [value.name ?? null, value.url ?? null];
  return [
    workflow.integration ?? null,
    workflow.production ?? null,
    workflow.story_branches ?? null,
    workflow.ci ?? null,
    workflow.merge ?? null,
    workflow.review ?? null,
    environment(workflow.environments?.staging),
    environment(workflow.environments?.production),
  ];
}

/**
 * The recommendation of each choice: what a solo creator is best served by, given
 * what the repository has. `forge`: the repository is on GitHub or GitLab.
 */
export function recommendedGitWorkflow(facts: { readonly forge: boolean }): GitWorkflow {
  return {
    story_branches: true,
    ci: facts.forge ? "remote" : "local",
    merge: facts.forge ? "pr" : "direct",
    review: true,
  };
}
