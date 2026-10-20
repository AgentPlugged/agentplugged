/**
 * How the creator reopens a session of an AI tool in the tool's own terminal program, on the
 * machine where the agent worked. The command is built here, from a session identifier that is
 * checked character by character, and never from a text the creator or the agent wrote.
 */

/** What the creator types: the program and its arguments, and the line to show. */
export interface TerminalCommand {
  readonly program: string;
  readonly args: readonly string[];
  /** The command as one line to copy; every argument is made of safe characters only. */
  readonly line: string;
}

/** A session identifier as the tools write them: letters, digits, dashes and underscores. */
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/;

/**
 * The command that reopens `session` in the terminal program of `tool`, or undefined when the
 * tool has no such command (yet) or the identifier is not a plain one.
 */
export function terminalCommandFor(tool: string, session: string): TerminalCommand | undefined {
  if (!SAFE_SESSION.test(session)) return undefined;
  if (tool !== "claude-code") return undefined;
  return {
    program: "claude",
    args: ["--resume", session],
    line: `claude --resume ${session}`,
  };
}

/** True when the tool can continue a session with a new message in its non-interactive mode. */
export function canContinueSession(tool: string): boolean {
  return tool === "claude-code";
}

/**
 * True when a run of the tool can launch sub-agents and be driven to do so (the plan's
 * `subAgents`). The other tools keep their present behaviour until their own trial says what
 * they can do.
 */
export function canLaunchSubAgents(tool: string): boolean {
  return tool === "claude-code";
}

/**
 * True when a message can be written to a run of the tool while it goes on (the request's
 * `liveInput`). For any other tool a message waits for the end of the run.
 */
export function canTakeLiveInput(tool: string): boolean {
  return tool === "claude-code";
}
