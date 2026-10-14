import {
  DEFAULT_INSTALL_MODE,
  type InstallMode,
  InstallSettingsSchema,
  type MethodConfig,
} from "@agentplugged/protocol";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import type { MainBranchReader } from "../rules/main-branch.js";
import { methodSection } from "../rules/method-section.js";

/** The main branch's `installs` section could not be read: the default applies, and the creator is told. */
export interface InstallSettingsWarning {
  readonly kind: "main_installs_invalid";
  readonly branch: string;
}

/** The installs mode in force, where it was read, and what went wrong reading it. */
export interface ResolvedInstallSettings {
  readonly mode: InstallMode;
  /** `main`: the main branch's `method.yaml`; `working_copy`: no main branch could be read. */
  readonly source: "main" | "working_copy";
  readonly warning: InstallSettingsWarning | null;
}

/**
 * The `installs` section of a `method.yaml` text: undefined when absent, `"invalid"` when the text
 * or the section cannot be read.
 */
const installsOf = (text: string) => methodSection(text, "installs", InstallSettingsSchema);

/**
 * The installs mode in force, read like the rules and the validation level:
 * the main branch's `method.yaml` when one can be read (the default when it sets none), so that an
 * agent never changes it by editing its own working copy; an unreadable section there gives the
 * default and a warning (a typo is no reason to validate every installation). The working
 * copy's only without a main branch, a reader, or when the read fails. The default is `visible`.
 */
export async function resolveInstallSettings(
  working: MethodConfig,
  reader: MainBranchReader | undefined,
): Promise<ResolvedInstallSettings> {
  if (reader !== undefined) {
    const read = await reader.read(METHOD_CONFIG_PATH).catch(() => undefined);
    if (read?.found === true) {
      const section = read.text === undefined ? undefined : installsOf(read.text);
      if (section === "invalid") {
        return {
          mode: DEFAULT_INSTALL_MODE,
          source: "main",
          warning: { kind: "main_installs_invalid", branch: read.branch },
        };
      }
      return { mode: section?.mode ?? DEFAULT_INSTALL_MODE, source: "main", warning: null };
    }
  }
  return {
    mode: working.installs?.mode ?? DEFAULT_INSTALL_MODE,
    source: "working_copy",
    warning: null,
  };
}
