import { type GitWorkflow, recommendedGitWorkflow } from "@agentplugged/protocol";
import { existingCi, isWorkflowFile } from "../ci/ci-rules.js";
import type { CommandContext } from "../command.js";
import { type ForgeRepository, forgeRepositoryOf } from "../stories/story-forge.js";
import type { WorkflowDetection } from "../stories/story-workspace.js";

/**
 * What `init` reads of a product that already has a way of working, to propose it as the
 * default instead of replacing it: the branches (a staging branch next to the main one), the CI files
 * (and whether their jobs run on a self-hosted runner), branches that look like a story's, merges of
 * pull requests in the history, a protection of the main branch on the forge. Nothing is written and
 * nothing here is final: the creator answers, « garde » keeps what was found.
 */

/** The branch names that stand for a staging branch, most usual first. */
export const STAGING_BRANCH_NAMES = [
  "dev",
  "develop",
  "development",
  "staging",
  "integration",
] as const;

/** What was found, each fact the engine proposes a choice from. */
export interface DetectedFacts {
  readonly repository: boolean;
  /** The repository is on GitHub or GitLab. */
  readonly forge: boolean;
  readonly main: string | null;
  /** A staging branch next to the main one. */
  readonly staging: string | null;
  /** The CI files the repository has, and where they run. */
  readonly ci: { readonly files: readonly string[]; readonly where: "remote" | "local" | null };
  /** How many branches look like a story's (`feat/…`, `feature/…`). */
  readonly story_branches: number;
  /** The history holds merges of pull requests. */
  readonly pull_request_merges: boolean;
  /** The forge protects the main branch (a pull request is required): undefined when it could not be read. */
  readonly main_protected: boolean | undefined;
}

/** What the engine proposes: the workflow, and which of its choices come from the product itself. */
export interface DetectedWorkflow {
  /** True when the product already works in a way the engine recognised. */
  readonly existing: boolean;
  readonly workflow: GitWorkflow;
  /** The choices found in the product, the others being the recommendation. */
  readonly found: readonly ("branches" | "story_branches" | "ci" | "merge")[];
  readonly facts: DetectedFacts;
}

/** Whether a workflow file puts its jobs on a runner of the creator's own. */
function selfHosted(text: string): boolean {
  return /^\s*runs-on:\s*(?:\[[^\]]*self-hosted[^\]]*\]|self-hosted\b)/im.test(text);
}

/** The repository as the engine finds it, and the workflow it proposes for it. */
export async function detectGitWorkflow(
  context: Pick<CommandContext, "files" | "storyWorkspace" | "ciReader" | "storyForge">,
): Promise<DetectedWorkflow> {
  const empty: DetectedFacts = {
    repository: false,
    forge: false,
    main: null,
    staging: null,
    ci: { files: [], where: null },
    story_branches: 0,
    pull_request_merges: false,
    main_protected: undefined,
  };
  let detection: WorkflowDetection | undefined;
  try {
    detection = await context.storyWorkspace?.detectWorkflow?.();
  } catch {
    detection = undefined;
  }
  const repository = await context.ciReader?.repository().catch(() => null);
  const forge = repository?.forge != null;
  const files = await existingCi(context.files).catch(() => [] as string[]);
  const ciFiles = [...new Set([...(repository?.ci ?? []), ...files])];

  // Where the CI runs: a workflow of GitHub Actions that names a self-hosted runner is on the
  // creator's machine; any other CI file is on a forge's servers.
  let where: DetectedFacts["ci"]["where"] = null;
  if (ciFiles.length > 0) {
    where = "remote";
    for (const path of ciFiles.filter(isWorkflowFile)) {
      const text = await context.files.readText(path).catch(() => "");
      if (selfHosted(text)) where = "local";
    }
  }

  const main = detection?.repository === true ? detection.main : null;
  const branches = detection?.repository === true ? detection.branches : [];
  const staging =
    STAGING_BRANCH_NAMES.find((name) => name !== main && branches.includes(name)) ?? null;

  // The forge's protection of the main branch, when its tool is there to say.
  let mainProtected: boolean | undefined;
  const storyForge = context.storyForge;
  if (forge && main !== null && storyForge?.branchProtection !== undefined) {
    try {
      const inspected = await storyForge.inspect(main, main);
      const remote = inspected.repository
        ? (inspected.remotes.find((entry) => entry.name === "origin") ?? inspected.remotes[0])
        : undefined;
      const located = remote === undefined ? { host: undefined } : forgeRepositoryOf(remote.url);
      if ("forge" in located) {
        const onForge = located as ForgeRepository;
        if ((await storyForge.cli(onForge)) === "ready") {
          const state = await storyForge.branchProtection(onForge, main);
          mainProtected = state === "unknown" ? undefined : state === "protected";
        }
      }
    } catch {
      mainProtected = undefined;
    }
  }

  const facts: DetectedFacts = {
    ...empty,
    repository: detection?.repository === true,
    forge,
    main,
    staging,
    ci: { files: ciFiles, where },
    story_branches: detection?.repository === true ? detection.story_branches : 0,
    pull_request_merges: detection?.repository === true ? detection.pull_request_merges : false,
    main_protected: mainProtected,
  };

  // The recommendation, then what the product already says on top of it.
  const base = recommendedGitWorkflow({ forge });
  const found: Array<"branches" | "story_branches" | "ci" | "merge"> = [];
  let workflow: GitWorkflow = base;
  if (staging !== null && main !== null) {
    workflow = { ...workflow, integration: staging, production: main };
    found.push("branches");
  }
  if (facts.story_branches > 0) {
    workflow = { ...workflow, story_branches: true };
    found.push("story_branches");
  }
  if (where !== null) {
    workflow = { ...workflow, ci: where };
    found.push("ci");
  }
  if (forge && (facts.main_protected === true || facts.pull_request_merges)) {
    workflow = { ...workflow, merge: "pr" };
    found.push("merge");
  }
  return { existing: found.length > 0, workflow, found, facts };
}
