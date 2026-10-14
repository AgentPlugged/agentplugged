import {
  DEFAULT_MERGE_METHOD,
  type MergeMethod,
  type MethodConfig,
  PullRequestSettingsSchema,
} from "@agentplugged/protocol";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import type { MainBranchReader } from "../rules/main-branch.js";
import { methodSection } from "../rules/method-section.js";

/** The pull request settings in force, and where they were read. */
export interface ResolvedPullRequestSettings {
  /** How the engine merges an approved story: `merge` by default. */
  readonly merge_method: MergeMethod;
  /** `main`: the main branch's `method.yaml`; `working_copy`: no main branch could be read. */
  readonly source: "main" | "working_copy";
  /** The main branch's `pr` section could not be read: the defaults apply. */
  readonly invalid: boolean;
}

/** The `pr` section of a `method.yaml` text: undefined when absent, `"invalid"` when unreadable. */
const sectionOf = (text: string) => methodSection(text, "pr", PullRequestSettingsSchema);

/**
 * The pull request settings in force, read like the rules: those of `method.yaml` on the
 * main branch when one can be read (an agent never changes the way its own work is merged by
 * editing its working copy); the working copy's only without a main branch, a reader, or when
 * the read fails. An invalid section gives the default.
 */
export async function resolvePullRequestSettings(
  working: MethodConfig,
  reader: MainBranchReader | undefined,
): Promise<ResolvedPullRequestSettings> {
  if (reader !== undefined) {
    const read = await reader.read(METHOD_CONFIG_PATH).catch(() => undefined);
    if (read?.found === true) {
      const section = read.text === undefined ? undefined : sectionOf(read.text);
      return section === "invalid"
        ? {
            merge_method: DEFAULT_MERGE_METHOD,
            source: "main",
            invalid: true,
          }
        : {
            merge_method: section?.merge_method ?? DEFAULT_MERGE_METHOD,
            source: "main",
            invalid: false,
          };
    }
  }
  return {
    merge_method: working.pr?.merge_method ?? DEFAULT_MERGE_METHOD,
    source: "working_copy",
    invalid: false,
  };
}
