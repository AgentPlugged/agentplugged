import type { ToolId } from "@agentplugged/protocol";

/**
 * What Noah can do when the bridge starts him without a head (the creator writes from the web view
 * or the phone), tool by tool. It is the companion of the compatibility matrix of `sync`: that one
 * tells what a tool reads from the project; this one tells what a run started by the bridge can
 * do. Where a mechanism is missing there is a fallback, never a silent failure: each fallback has a
 * cause in plain words and one action for the creator. English here; French in the catalog of
 * fallback reasons, by `runFallbackId`.
 *
 * Evidence: `tried` (a real run on the creator's machine), `source` (read in the tool's public
 * source code, and in the stream a real run gave), `documented` (the tool's official documentation,
 * not run here). A mechanism that is only `documented` or `source` is not proven in a session of
 * this product: Noah says so when it fails.
 */

export const RUN_MECHANISMS = [
  /** Started without a head, instruction on the input, activity and text read as they come. */
  "headless",
  /** Noah launches the agents himself as sub-agents of the tool, under the product's rules. */
  "sub_agents",
  /** A message written while Noah works reaches him at once. */
  "live_messages",
  /** Noah's session continues with the next message or system notice. */
  "resume",
  /** Noah can record the creator's validation with the session named before the start. */
  "validation_by_chat",
  /** The tools Noah has no contract for are withheld from his own session only. */
  "own_refusals",
  /** The files never read (keys, secret files) are kept from Noah and his sub-agents by the launch itself. */
  "read_floor",
  /** The tokens of the run are reported. */
  "usage",
  /** A cost in money is reported. */
  "cost",
] as const;
export type RunMechanism = (typeof RUN_MECHANISMS)[number];

/** The tools the bridge starts. */
export const RUN_TOOLS = [
  "claude-code",
  "codex",
  "antigravity",
  "cursor",
  "kimi",
] as const satisfies readonly ToolId[];
export type RunTool = (typeof RUN_TOOLS)[number];

export interface RunCell {
  readonly support: "native" | "fallback";
  readonly evidence: "tried" | "source" | "documented";
  /** Why a fallback is needed, in English. */
  readonly reason?: string;
  /** What the creator does about it, in one gesture, in English. */
  readonly action?: string;
}

const NATIVE_TRIED: RunCell = { support: "native", evidence: "tried" };
const NATIVE_DOC: RunCell = { support: "native", evidence: "documented" };
const NATIVE_SRC: RunCell = { support: "native", evidence: "source" };

const CHOOSE_CLAUDE =
  "Choose Claude Code for Noah in this product: `npx agentplugged agent edit noah --tool claude-code`.";
const CHOOSE_ANTIGRAVITY =
  "Choose Antigravity CLI for Noah in this product: `npx agentplugged agent edit noah --tool antigravity` (Claude Code also takes a message while he works).";

const VALIDATION_ACTION =
  "Validate the point with the validate button of the web view or the phone (one gesture): the decision is recorded and Noah is told. From his second message of a conversation on, he can record it himself.";

const VALIDATION_REASON =
  "this tool names its sessions itself: the session of a new conversation is known only once the run has started, after the creator's message was handed to Noah, so the engine cannot yet tie a validation said in words to that message.";

const OWN_REFUSALS_REASON =
  "this tool gives the agents it launches the same MCP tools as the session that launches them: the tools Noah has no contract for (`guard`, `checkpoint`, `story`, `review`, `plan`, `measure`, `memory`) cannot be withheld from his session alone. Only his role, the prompt and the engine's own checks hold him to his contract.";

const OWN_REFUSALS_ACTION =
  "Nothing to do for a routine use; for the strongest guarantee choose Claude Code for Noah: `npx agentplugged agent edit noah --tool claude-code`.";

const READ_FLOOR_REASON =
  "the bridge can pass the floor of files an agent never reads (keys, `.env` and secret files) on the command line of Claude Code only. For this tool it relies on the rules and hooks that `sync` wrote in the project, which the tool applies only in a folder it trusts, and the bridge also cannot narrow which MCP servers of the project the tool starts.";

const READ_FLOOR_ACTION =
  "Run `npx agentplugged sync` and approve the project once in the tool; for the strongest guarantee choose Claude Code for Noah: `npx agentplugged agent edit noah --tool claude-code`.";

const KIMI_VALIDATION_REASON =
  "Kimi Code CLI tells the identifier of a new session only at the end of a turn that went well, so the engine cannot tie a validation said in words to the creator's first message of a conversation (nor to any message of a conversation whose first run was cut short).";

const KIMI_READ_FLOOR_REASON =
  "the non-interactive mode of Kimi Code CLI approves every tool call and its command line takes no rule: the floor of files never read (keys, `.env` and secret files) is not passed to it. Noah's own session is held to the reading tools and the engine's MCP server (never the shell), but the agents he launches work under their own definitions, shell included, and the product's guards reach them only through the hook in the creator's own Kimi settings. The bridge also trusts the product's folder for this run only, so every MCP server of the project starts.";

const KIMI_READ_FLOOR_ACTION =
  "Install the guards once, yourself: `npx agentplugged kimi-hooks install`; for the strongest guarantee choose Claude Code for Noah: `npx agentplugged agent edit noah --tool claude-code`.";

const NO_COST_ACTION =
  "Nothing to do: the work goes on. Read the consumption on the tool's own usage page; the engine never estimates it.";

export const RUN_COMPATIBILITY: Readonly<Record<RunTool, Readonly<Record<RunMechanism, RunCell>>>> =
  {
    "claude-code": {
      headless: NATIVE_TRIED,
      sub_agents: NATIVE_TRIED,
      live_messages: NATIVE_TRIED,
      resume: NATIVE_TRIED,
      validation_by_chat: NATIVE_TRIED,
      own_refusals: NATIVE_TRIED,
      read_floor: NATIVE_TRIED,
      usage: NATIVE_TRIED,
      cost: NATIVE_TRIED,
    },
    codex: {
      // `codex exec --json`: tried (a real run gave the stream of a failed turn); the events of the
      // other turns are read from the tool's open source and from the documentation.
      headless: NATIVE_SRC,
      // The sub-agent events (`collab_tool_call`) are in the stream the program writes; no run of
      // this product has launched one.
      sub_agents: NATIVE_SRC,
      live_messages: {
        support: "fallback",
        evidence: "documented",
        reason:
          '`codex exec` reads its instruction once and has no input that stays open while it works, and it waits for its sub-agents before it answers: a message written meanwhile cannot reach Noah at once. It is kept ("Noah is busy, your request is kept") and given to him in one message when his answer ends.',
        action: CHOOSE_ANTIGRAVITY,
      },
      resume: NATIVE_SRC,
      validation_by_chat: {
        support: "fallback",
        evidence: "documented",
        reason: VALIDATION_REASON,
        action: VALIDATION_ACTION,
      },
      own_refusals: {
        support: "fallback",
        evidence: "documented",
        reason: OWN_REFUSALS_REASON,
        action: OWN_REFUSALS_ACTION,
      },
      read_floor: {
        support: "fallback",
        evidence: "documented",
        reason: READ_FLOOR_REASON,
        action: READ_FLOOR_ACTION,
      },
      usage: NATIVE_SRC,
      cost: {
        support: "fallback",
        evidence: "source",
        reason:
          "Codex reports tokens at the end of a turn and no cost in money (the account's plan bills it).",
        action: NO_COST_ACTION,
      },
    },
    antigravity: {
      headless: NATIVE_DOC,
      sub_agents: NATIVE_DOC,
      live_messages: NATIVE_DOC,
      resume: NATIVE_DOC,
      validation_by_chat: {
        support: "fallback",
        evidence: "documented",
        reason: VALIDATION_REASON,
        action: VALIDATION_ACTION,
      },
      own_refusals: {
        support: "fallback",
        evidence: "documented",
        reason: OWN_REFUSALS_REASON,
        action: OWN_REFUSALS_ACTION,
      },
      read_floor: {
        support: "fallback",
        evidence: "documented",
        reason: READ_FLOOR_REASON,
        action: READ_FLOOR_ACTION,
      },
      usage: NATIVE_DOC,
      cost: {
        support: "fallback",
        evidence: "documented",
        reason: "Antigravity CLI reports tokens and no cost in money.",
        action: NO_COST_ACTION,
      },
    },
    cursor: {
      headless: {
        support: "native",
        evidence: "documented",
      },
      sub_agents: {
        support: "fallback",
        evidence: "documented",
        reason:
          "Cursor's documentation does not say that sub-agents work in its non-interactive mode, and that mode can write only with `--force`, which allows every command not explicitly denied: the bridge never passes it. Noah therefore runs read-only: he reads the state, answers, records the handover with `agent.delegate`, and tells the creator which agent takes over and that the step goes on in the tool's own chat (mode `conversation`).",
        action: CHOOSE_CLAUDE,
      },
      live_messages: {
        support: "fallback",
        evidence: "documented",
        reason:
          'Cursor\'s non-interactive mode has no input that stays open while it works: a message written meanwhile is kept ("Noah is busy, your request is kept") and given to him in one message when his answer ends.',
        action: CHOOSE_ANTIGRAVITY,
      },
      resume: NATIVE_DOC,
      validation_by_chat: {
        support: "fallback",
        evidence: "documented",
        reason: VALIDATION_REASON,
        action: VALIDATION_ACTION,
      },
      own_refusals: {
        support: "fallback",
        evidence: "documented",
        reason: OWN_REFUSALS_REASON,
        action: OWN_REFUSALS_ACTION,
      },
      read_floor: {
        support: "fallback",
        evidence: "documented",
        reason: READ_FLOOR_REASON,
        action: READ_FLOOR_ACTION,
      },
      usage: {
        support: "fallback",
        evidence: "documented",
        reason:
          "Cursor reports no token and no cost in its output, and keeps none on the machine: the engine measures nothing of a run and never estimates it.",
        action: NO_COST_ACTION,
      },
      cost: {
        support: "fallback",
        evidence: "documented",
        reason: "Cursor reports no cost in money.",
        action: NO_COST_ACTION,
      },
    },
    kimi: {
      // `kimi -p … --output-format stream-json`: read from the tool's public source and
      // documentation; a real run without a sign-in gave the stream of a start that failed (the
      // version line, then the error on the error output, exit code 1). A turn that goes well has
      // never been run here.
      headless: NATIVE_SRC,
      // The `Agent` tool with `run_in_background`: in the non-interactive mode the run stays open
      // until the background agents report, and their reports steer Noah in new turns.
      sub_agents: NATIVE_SRC,
      live_messages: {
        support: "fallback",
        evidence: "documented",
        reason:
          'Kimi Code CLI takes its instruction as an argument and has no input that stays open while it works: a message written meanwhile is kept ("Noah is busy, your request is kept") and given to him in one message when his run ends.',
        action: CHOOSE_ANTIGRAVITY,
      },
      resume: NATIVE_SRC,
      validation_by_chat: {
        support: "fallback",
        evidence: "source",
        reason: KIMI_VALIDATION_REASON,
        action: VALIDATION_ACTION,
      },
      // The main agent of the run is defined by a file written for the launch (its tools and its
      // refusals); the agents it launches have their own files.
      own_refusals: NATIVE_SRC,
      read_floor: {
        support: "fallback",
        evidence: "source",
        reason: KIMI_READ_FLOOR_REASON,
        action: KIMI_READ_FLOOR_ACTION,
      },
      usage: {
        support: "fallback",
        evidence: "source",
        reason:
          "Kimi Code CLI writes no token and no cost in its output, and the format of the sessions it keeps on the machine is not documented: the engine measures nothing of a run and never estimates it.",
        action: NO_COST_ACTION,
      },
      cost: {
        support: "fallback",
        evidence: "source",
        reason: "Kimi Code CLI reports no cost in money.",
        action: NO_COST_ACTION,
      },
    },
  };

/** The identifier of a fallback, the key of its French text (`.action` for the action). */
export function runFallbackId(tool: RunTool, mechanism: RunMechanism): string {
  return `run.${tool}.${mechanism}`;
}

export interface RunFallback {
  readonly id: string;
  readonly tool: RunTool;
  readonly mechanism: RunMechanism;
  readonly evidence: RunCell["evidence"];
  readonly reason: string;
  readonly action: string;
}

/** The fallbacks of one tool's bridge run, in the order of the mechanisms. */
export function runFallbacksFor(tool: RunTool): RunFallback[] {
  const cells = RUN_COMPATIBILITY[tool];
  const result: RunFallback[] = [];
  for (const mechanism of RUN_MECHANISMS) {
    const cell = cells[mechanism];
    if (cell.support !== "fallback") continue;
    result.push({
      id: runFallbackId(tool, mechanism),
      tool,
      mechanism,
      evidence: cell.evidence,
      reason: cell.reason ?? "",
      action: cell.action ?? "",
    });
  }
  return result;
}
