import type {
  DetectedWorkflow,
  GitView,
  WorkflowImplication,
  WorkflowRecorded,
} from "@agentplugged/core";
import type { MessageKey, Translate } from "@agentplugged/i18n";
import {
  GIT_CI_MODES,
  GIT_MERGE_MODES,
  GitBranchSchema,
  type GitCiMode,
  type GitMergeMode,
  type GitWorkflow,
  recommendedGitWorkflow,
  resolveGitWorkflow,
} from "@agentplugged/protocol";
import type { MenuOption } from "./menu.js";
import { askText, askYesNo, chooseOne, type Prompter } from "./prompt.js";

/**
 * The questions of the Git workflow, asked by `init` and `profile` and, in the chat, by
 * Noah: each choice in a short menu with the recommended option marked and a sentence that says why,
 * a word (« garde la recommandation ») for all of them at once, and what the product already does
 * proposed as the default instead of replaced. Nothing here is imposed: the creator may choose any
 * way of working Git, and the engine follows it.
 */

/** An option: its label, « (recommandé) » when it is, then the sentence that argues it. */
function option(t: Translate, key: string, recommended: boolean): MenuOption {
  const label = t(`workflow.${key}` as MessageKey);
  return {
    label: `${label}${recommended ? ` ${t("workflow.recommended")}` : ""}`,
    hint: t(`workflow.${key}.argument` as MessageKey),
  };
}

/** The workflow in one line, in the creator's words: what is chosen, whole. */
export function workflowLine(t: Translate, workflow: GitWorkflow): string {
  const flow = resolveGitWorkflow(workflow);
  const branches =
    flow.integration === undefined
      ? t("workflow.line.branches.main")
      : t("workflow.line.branches.staged", {
          integration: flow.integration,
          production: flow.production ?? "main",
        });
  return [
    branches,
    t(flow.story_branches ? "workflow.line.story_branches.yes" : "workflow.line.story_branches.no"),
    t(`workflow.line.ci.${flow.ci}` as MessageKey),
    t(`workflow.line.merge.${flow.merge}` as MessageKey),
    t(flow.review ? "workflow.line.review.yes" : "workflow.line.review.no"),
  ].join(" ; ");
}

/**
 * Asks the workflow. `detected` is what the product already does (or the recommendation when it does
 * nothing in particular), `current` the one recorded: the default of each question.
 */
export async function chooseGitWorkflow(
  t: Translate,
  prompter: Prompter,
  detected: DetectedWorkflow,
  current: GitWorkflow | undefined,
): Promise<GitWorkflow> {
  const recommended = recommendedGitWorkflow({ forge: detected.facts.forge });
  prompter.say(t("workflow.title"));
  // Already chosen: kept in one word, or changed point by point.
  if (current !== undefined) {
    prompter.say(t("workflow.current", { line: workflowLine(t, current) }));
    if (await askYesNo(t, prompter, t("workflow.prompt.keep_current"), true)) return current;
  } else if (detected.existing) {
    // A product with its own way of working: proposed as it is, never replaced.
    prompter.say(t("workflow.detected", { line: workflowLine(t, detected.workflow) }));
    if (await askYesNo(t, prompter, t("workflow.prompt.keep_detected"), true)) {
      return detected.workflow;
    }
  } else {
    prompter.say(t("workflow.intro", { line: workflowLine(t, recommended) }));
    if (await askYesNo(t, prompter, t("workflow.prompt.keep"), true)) return recommended;
  }
  const start = resolveGitWorkflow(
    current ?? (detected.existing ? detected.workflow : recommended),
  );

  // Branches: main alone, main + a staging branch, or the ones the creator names.
  const stagedName = start.integration ?? detected.facts.staging ?? "dev";
  const mainName = start.production ?? detected.facts.main ?? "main";
  const branchChoice = await chooseOne(t, prompter, {
    title: t("workflow.branches.title"),
    options: [
      option(t, "branches.main", true),
      option(t, "branches.staged", false),
      option(t, "branches.other", false),
    ],
    question: (fallback) => t("workflow.prompt.branches", { default: fallback }),
    fallback:
      start.integration === undefined
        ? 0
        : start.integration === "dev" && mainName === "main"
          ? 1
          : 2,
  });
  let integration: string | undefined;
  let production: string | undefined;
  if (branchChoice === 1) {
    integration = stagedName;
    production = mainName;
  } else if (branchChoice === 2) {
    const valid = (answer: string) =>
      GitBranchSchema.safeParse(answer).success ? undefined : t("workflow.prompt.branch_invalid");
    integration = await askText(
      t,
      prompter,
      t("workflow.prompt.integration", { default: stagedName }),
      {
        required: true,
        fallback: stagedName,
        check: valid,
      },
    );
    production = await askText(
      t,
      prompter,
      t("workflow.prompt.production", { default: mainName }),
      {
        required: true,
        fallback: mainName,
        check: (answer) =>
          answer === integration ? t("workflow.prompt.branch_same") : valid(answer),
      },
    );
  }

  const storyBranches =
    (await chooseOne(t, prompter, {
      title: t("workflow.story_branches.title"),
      options: [option(t, "story_branches.yes", true), option(t, "story_branches.no", false)],
      question: (fallback) => t("workflow.prompt.story_branches", { default: fallback }),
      fallback: start.story_branches ? 0 : 1,
    })) === 0;

  const ci: GitCiMode =
    GIT_CI_MODES[
      await chooseOne(t, prompter, {
        title: t("workflow.ci.title"),
        options: GIT_CI_MODES.map((mode) => option(t, `ci.${mode}`, mode === recommended.ci)),
        question: (fallback) => t("workflow.prompt.ci", { default: fallback }),
        fallback: GIT_CI_MODES.indexOf(start.ci),
      })
    ] ?? "remote";

  // Without a branch of its own a story has no pull request: nothing to ask.
  let merge: GitMergeMode = "direct";
  if (storyBranches) {
    merge =
      GIT_MERGE_MODES[
        await chooseOne(t, prompter, {
          title: t("workflow.merge.title"),
          options: GIT_MERGE_MODES.map((mode) =>
            option(t, `merge.${mode}`, mode === recommended.merge),
          ),
          question: (fallback) => t("workflow.prompt.merge", { default: fallback }),
          fallback: GIT_MERGE_MODES.indexOf(start.merge),
        })
      ] ?? "pr";
  }

  const review =
    (await chooseOne(t, prompter, {
      title: t("workflow.review.title"),
      options: [option(t, "review.yes", true), option(t, "review.no", false)],
      question: (fallback) => t("workflow.prompt.review", { default: fallback }),
      fallback: start.review ? 0 : 1,
    })) === 0;

  return {
    ...(integration === undefined ? {} : { integration }),
    ...(production === undefined ? {} : { production }),
    story_branches: storyBranches,
    ci,
    merge,
    review,
    // Addresses already declared are kept; Omar asks for the others when he writes the runbook.
    ...(start.environments.staging === undefined && start.environments.production === undefined
      ? {}
      : { environments: start.environments }),
  };
}

/** What changing the workflow means for the work in progress: one sentence each, said once. */
export function implicationLines(
  t: Translate,
  implications: readonly WorkflowImplication[],
): string[] {
  return implications.map((entry) => implicationLine(t, entry));
}

function implicationLine(t: Translate, entry: WorkflowImplication): string {
  switch (entry.code) {
    case "integration":
      return t("workflow.implication.integration", {
        branch: entry.branch,
        count: entry.stories,
      });
    case "production":
      return t("workflow.implication.production", { branch: entry.branch });
    case "story_branches":
      return t(
        entry.on
          ? "workflow.implication.story_branches.yes"
          : "workflow.implication.story_branches.no",
        {
          count: entry.stories,
        },
      );
    case "ci":
      return t(`workflow.implication.ci.${entry.mode}` as MessageKey);
    case "merge":
      return t(`workflow.implication.merge.${entry.mode}` as MessageKey);
    case "review":
      return t(entry.on ? "workflow.implication.review.yes" : "workflow.implication.review.no");
  }
}

/** What recording the workflow did, after the choice: the line, the branch, the sentences. */
export function formatWorkflowResult(
  t: Translate,
  workflow: GitWorkflow,
  recorded: WorkflowRecorded | undefined,
): string {
  const lines = [t("workflow.summary", { line: workflowLine(t, workflow) })];
  const flow = resolveGitWorkflow(workflow);
  if (flow.merge === "direct" && flow.ci !== "none")
    lines.push(`  ${t("workflow.note.direct_ci")}`);
  if (recorded === undefined || recorded.event === "no_journal") {
    lines.push(`  ${t("workflow.not_recorded")}`);
  }
  if (recorded?.branch !== undefined) {
    if (recorded.branch.status === "created") {
      lines.push(
        t("workflow.branch.created", { branch: recorded.branch.name, from: recorded.branch.from }),
      );
    } else if (recorded.branch.status === "missing_source" || recorded.branch.status === "failed") {
      lines.push(t("workflow.branch.missing", { branch: recorded.branch.name }));
    }
  }
  if (recorded !== undefined)
    lines.push(...implicationLines(t, recorded.implications).map((line) => `  ${line}`));
  if ((recorded?.retargeted.length ?? 0) > 0) {
    lines.push(
      `  ${t("workflow.retargeted", { stories: (recorded?.retargeted ?? []).join(", ") })}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** The staging line `next` shows when something waits there. */
export function stagingLine(t: Translate, git: GitView): string | undefined {
  const staging = git.staging;
  if (staging === undefined || staging.waiting.length === 0) return undefined;
  return t("workflow.staging.waiting", {
    count: staging.waiting.length,
    branch: staging.branch,
    production: staging.production ?? "main",
    days: staging.oldest_days ?? 0,
    advice: t(`workflow.staging.advice.${staging.advice}` as MessageKey),
  });
}

/** The options of `init` and `profile` that say a Git workflow, as typed. */
export interface WorkflowOptions {
  /** `recommended`: « garde la recommandation » in one word, for everything. */
  readonly workflow?: string | undefined;
  /** `main`, `main+dev`, or `<production>+<integration>`. */
  readonly branches?: string | undefined;
  readonly storyBranches?: string | undefined;
  readonly ci?: string | undefined;
  readonly merge?: string | undefined;
  readonly review?: string | undefined;
}

/** True when any option of the workflow is given. */
export function hasWorkflowOptions(options: WorkflowOptions): boolean {
  return Object.values(options).some((value) => value !== undefined);
}

const YES_NO: Readonly<Record<string, boolean>> = {
  yes: true,
  oui: true,
  y: true,
  o: true,
  true: true,
  no: false,
  non: false,
  n: false,
  false: false,
};

/**
 * The workflow the options describe: `--workflow recommended` (or `keep`) the recommendation, else
 * the one recorded (or recommended) with each option given on top of it. A string says what is wrong
 * with an option; undefined: no option was given.
 */
export function workflowFromOptions(
  options: WorkflowOptions,
  base: {
    readonly current: GitWorkflow | undefined;
    readonly forge: boolean;
    readonly main: string;
  },
): GitWorkflow | string | undefined {
  if (!hasWorkflowOptions(options)) return undefined;
  const recommended = recommendedGitWorkflow({ forge: base.forge });
  if (options.workflow !== undefined) {
    const word = options.workflow.trim().toLowerCase();
    if (word !== "recommended" && word !== "keep") return `--workflow ${options.workflow}`;
    // Alone, the recommendation; with other options, they refine it.
    if (
      !Object.entries(options).some(([key, value]) => key !== "workflow" && value !== undefined)
    ) {
      return recommended;
    }
  }
  const start = options.workflow !== undefined ? recommended : (base.current ?? recommended);
  let { integration, production } = start;
  if (options.branches !== undefined) {
    const text = options.branches.trim();
    if (text.toLowerCase() === "main") {
      integration = undefined;
      production = undefined;
    } else if (text.toLowerCase() === "main+dev") {
      integration = "dev";
      production = base.main;
    } else {
      const [prod, stage, ...extra] = text.split("+");
      if (
        prod === undefined ||
        stage === undefined ||
        extra.length > 0 ||
        !GitBranchSchema.safeParse(prod).success ||
        !GitBranchSchema.safeParse(stage).success ||
        prod === stage
      ) {
        return `--branches ${options.branches}`;
      }
      production = prod;
      integration = stage;
    }
  }
  const yesNo = (value: string | undefined, flag: string): boolean | undefined | string => {
    if (value === undefined) return undefined;
    const answer = YES_NO[value.trim().toLowerCase()];
    return answer ?? `--${flag} ${value}`;
  };
  const storyBranches = yesNo(options.storyBranches, "story-branches");
  if (typeof storyBranches === "string") return storyBranches;
  const review = yesNo(options.review, "review");
  if (typeof review === "string") return review;
  let ci = start.ci;
  if (options.ci !== undefined) {
    const mode = options.ci.trim().toLowerCase() as GitCiMode;
    if (!(GIT_CI_MODES as readonly string[]).includes(mode)) return `--ci ${options.ci}`;
    ci = mode;
  }
  let merge = start.merge;
  if (options.merge !== undefined) {
    const mode = options.merge.trim().toLowerCase() as GitMergeMode;
    if (!(GIT_MERGE_MODES as readonly string[]).includes(mode)) return `--merge ${options.merge}`;
    merge = mode;
  }
  return {
    ...(integration === undefined ? {} : { integration }),
    ...(production === undefined ? {} : { production }),
    story_branches: storyBranches ?? start.story_branches ?? true,
    ci: ci ?? "remote",
    merge: merge ?? "pr",
    review: review ?? start.review ?? true,
    ...(start.environments === undefined ? {} : { environments: start.environments }),
  };
}
