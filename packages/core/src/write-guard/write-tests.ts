import {
  TEST_FILE_MAX_LINES,
  TEST_FILE_MAX_LINES_FLOOR,
  type TestGuardRow,
  TestSettingsSchema,
} from "@agentplugged/protocol";
import type { CommandContext } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { METHOD_CONFIG_PATH } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { isTestPath } from "../reuse/code-files.js";
import { methodSection } from "../rules/method-section.js";
import { lineCount, readTests } from "./test-rules.js";
import { absolutePath, inside, productRootOf } from "./write-index.js";

/**
 * The rule `test` of the guard before a write: a write to a file of tests that isolates
 * a test, disables one with no reason, waits a fixed time, asserts what cannot fail, or makes the
 * file too large is refused, with one line. It needs nothing from the journal, so like the secret
 * rule it is decided before the journal is read and never waits for it. The words are read as the
 * duplicate detector reads them, in any language (`test-rules.ts`).
 */

/** What a write to a test file came to: a refusal (the row of the grid, one line), or a doubt. */
export interface TestVerdict {
  readonly refusal?: { readonly row: TestGuardRow; readonly message: string };
  /** The rules saw only part of the text: nothing was refused, and the write goes through in doubt. */
  readonly doubt?: boolean;
}

/** What a write is, as far as the rule needs it. */
interface TestWrite {
  readonly tool: string;
  readonly path: string;
  readonly text: string;
  readonly cwd: string | undefined;
}

/**
 * The path relative to the product (or to the working copy of one of its stories, which lives next
 * to it in `<product>.worktrees/<story>/`), or undefined outside both.
 */
function placed(
  write: TestWrite,
  root: string | undefined,
  platform: string | undefined,
): string | undefined {
  if (root === undefined) return write.path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
  const absolute = absolutePath(write.path, write.cwd, root);
  if (absolute === undefined) return undefined;
  const product = productRootOf(root);
  for (const base of [root, product]) {
    const relative = inside(absolute, base, platform);
    if (relative !== undefined && relative !== "") return relative;
  }
  const copy = inside(absolute, `${product.replace(/[\\/]+$/, "")}.worktrees`, platform);
  const rest = copy?.split("/").slice(1).join("/");
  return rest === undefined || rest === "" ? undefined : rest;
}

/**
 * The length from which a test file is too large: `tests.max_lines` of `method.yaml`, read on the
 * main branch like the rules and the validation level (an agent never raises it by editing its own
 * working copy), the working copy's only when no main branch can be read; else 1 000.
 */
async function limitOf(context: CommandContext): Promise<number> {
  try {
    const read = await context.mainBranch?.read(METHOD_CONFIG_PATH).catch(() => undefined);
    if (read?.found === true) {
      const section =
        read.text === undefined ? undefined : methodSection(read.text, "tests", TestSettingsSchema);
      return section === undefined || section === "invalid"
        ? TEST_FILE_MAX_LINES
        : (section.max_lines ?? TEST_FILE_MAX_LINES);
    }
    const loaded = await loadMethodConfig(context.files);
    if (loaded instanceof AgentPluggedError) return TEST_FILE_MAX_LINES;
    return loaded.config.tests?.max_lines ?? TEST_FILE_MAX_LINES;
  } catch {
    return TEST_FILE_MAX_LINES;
  }
}

const ADVICE: Readonly<Record<Exclude<TestGuardRow, "oversize">, string>> = {
  focused: "isolates a test, so the others stop running. Remove the only/focus mark.",
  skipped:
    "disables a test with no reason. Write why in a comment on that line, or delete the test.",
  hard_wait:
    "waits a fixed time. Wait for the event or the condition instead, or write why in a comment on that line.",
  tautology: "asserts something that cannot fail. Assert a real result of the code under test.",
};

/**
 * What the write to `write.path` comes to for the rules of the tests: nothing (not a test file, or
 * nothing wrong), a refusal, or a doubt. `root` is the product's folder, when known. A refusal is one
 * line: the row, the line, what to do, and that nothing was written; further breaches are counted,
 * not listed. Only a whole file (`Write`) has a line number of the file and a size.
 */
export async function testVerdict(
  context: CommandContext,
  write: TestWrite,
  root: string | undefined,
): Promise<TestVerdict> {
  const relative = placed(write, root, context.platform);
  if (relative === undefined || !isTestPath(relative, root !== undefined)) return {};
  const whole = write.tool === "Write";
  const { violations, partial } = readTests(relative, write.text);
  // The size of a file is known only when the write is the whole file, and it is a test file by its
  // name: a data file or a helper in a folder of tests may be long.
  let large: { lines: number; limit: number } | undefined;
  if (whole && isTestPath(relative, false)) {
    const lines = lineCount(write.text);
    if (lines > TEST_FILE_MAX_LINES_FLOOR) {
      const limit = await limitOf(context);
      if (lines > limit) large = { lines, limit };
    }
  }
  const total = violations.length + (large === undefined ? 0 : 1);
  const more = total > 1 ? ` (+${total - 1} more)` : "";
  const first = violations[0];
  if (first !== undefined) {
    const place = whole ? `line ${first.line}` : `in the new text, line ${first.line}`;
    return {
      refusal: {
        row: first.row,
        message: `AgentPlugged refused this write: rule test (${first.row}), ${place} ${ADVICE[first.row as Exclude<TestGuardRow, "oversize">]}${more} Nothing was written.`,
      },
    };
  }
  if (large !== undefined) {
    return {
      refusal: {
        row: "oversize",
        message: `AgentPlugged refused this write: rule test (oversize), the file has ${large.lines} lines, over the limit of ${large.limit} (tests.max_lines). Split it by behaviour. Nothing was written.`,
      },
    };
  }
  return partial ? { doubt: true } : {};
}
