import type { UsageSource } from "@agentplugged/protocol";

/**
 * A trace of an AI tool's session, as the machine keeps it: its text, and what the
 * tool says of who ran it. Given by an adapter that reads the tool's folders; `core` reads the
 * text (`readClaudeTranscript`, `readCodexRollout`, `readAntigravityTranscript`) and never a file.
 */
export interface TraceFile {
  readonly source: UsageSource;
  /** The session's identifier in the tool: the file's name without its extension. */
  readonly id: string;
  /** `main`: the creator's own conversation; `sub`: a session an agent ran for it. */
  readonly kind: "main" | "sub";
  /** A `sub` trace: the agent's id as the tool names it (Claude Code's `agentType`). */
  readonly agent_type?: string;
  /** A `sub` trace: the title the session was given when it started (« Lina · story 4-3 »). */
  readonly description?: string;
  /**
   * The story worktree the session ran in, as the journal recorded it (`story.started`'s
   * `worktree`), when it did: the adapter matched the session's folder to it.
   */
  readonly worktree?: string;
  /**
   * A tool whose trace does not name the model of a session (Antigravity's sub-agents): the one
   * the adapter found for it, the model its parent conversation ran on.
   */
  readonly model?: string;
  /**
   * True when the adapter did not read the file: it holds nothing newer than what was measured
   * (`since`), so `text` is empty and the session is not measured again.
   */
  readonly unchanged?: boolean;
  readonly text: string;
}

/** The traces of this machine's AI tools that belong to the product. */
export interface UsageTraces {
  /**
   * Every trace of the product's own folder, and of each of `worktrees` (the relative paths
   * `story.started` recorded). Never throws for a missing folder: nothing to read.
   */
  read(
    worktrees: readonly string[],
    /**
     * When the engine last read the session `<source>:<id>` (milliseconds), or undefined when it must
     * be read: a file not modified since is returned `unchanged`, without being read.
     */
    since?: (session: string) => number | undefined,
  ): Promise<readonly TraceFile[]>;
}

/** Traces held in memory: tests, and a machine without any tool. */
export class MemoryUsageTraces implements UsageTraces {
  constructor(private traces: readonly TraceFile[] = []) {}

  set(traces: readonly TraceFile[]): void {
    this.traces = traces;
  }

  async read(): Promise<readonly TraceFile[]> {
    return this.traces;
  }
}
