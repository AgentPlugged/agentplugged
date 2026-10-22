import { translatorFor } from "./translators.js";

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
  if (tool === "claude-code") {
    return {
      program: "claude",
      args: ["--resume", session],
      line: `claude --resume ${session}`,
    };
  }
  // Checked with the program itself (`codex resume --help`); the others have no verified command.
  if (tool === "codex") {
    return { program: "codex", args: ["resume", session], line: `codex resume ${session}` };
  }
  // Checked with the program's own help (`kimi --help`: `-S, --session [id]`).
  if (tool === "kimi") {
    return { program: "kimi", args: ["--session", session], line: `kimi --session ${session}` };
  }
  return undefined;
}

/** True when the tool can continue a session with a new message in its non-interactive mode. */
export function canContinueSession(tool: string): boolean {
  return translatorFor(tool)?.capabilities.canResume === true;
}

/**
 * True when a run of the tool can launch sub-agents and be driven to do so (the plan's
 * `subAgents`). A tool that cannot gets a Noah that hands over in the conversation, and says so.
 */
export function canLaunchSubAgents(tool: string): boolean {
  return translatorFor(tool)?.capabilities.subAgents === true;
}

/**
 * True when a message can be written to a run of the tool while it goes on (the request's
 * `liveInput`). For any other tool a message waits for the end of the run.
 */
export function canTakeLiveInput(tool: string): boolean {
  return translatorFor(tool)?.capabilities.liveInput === true;
}

/** True when the tool tells the agent's text in pieces as it is written (`partialText`). */
export function canStreamText(tool: string): boolean {
  return translatorFor(tool)?.capabilities.streamsText === true;
}

/** True when a run of the tool can be kept open while it waits for a next message (`keepWarmMs`). */
export function canKeepWarm(tool: string): boolean {
  const capabilities = translatorFor(tool)?.capabilities;
  return capabilities?.keepsWarm === true && capabilities.liveInput === true;
}

/** True when the tool reports how heavy the agent's own conversation is at the end of a turn. */
export function canReportContext(tool: string): boolean {
  return translatorFor(tool)?.capabilities.reportsContext === true;
}

/** True when a new session can be given its identifier before the run starts. */
export function canNameSession(tool: string): boolean {
  return translatorFor(tool)?.capabilities.namedSessions === true;
}
