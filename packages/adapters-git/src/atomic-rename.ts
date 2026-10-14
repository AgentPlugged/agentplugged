import { rename } from "node:fs/promises";
import { AgentPluggedError } from "@agentplugged/core";
import { ErrorCode } from "@agentplugged/protocol";

/** The pauses, in milliseconds, before each new try: about a second and a half in all. */
const RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400, 700];

/** The errors Windows gives when another program (an AI tool, an editor, an antivirus) holds a file. */
const HELD_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);

export interface RenameOptions {
  /** The system's rename (tests give theirs). */
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly platform?: NodeJS.Platform;
  /** Waits for a pause (tests give theirs). */
  readonly wait?: (ms: number) => Promise<void>;
}

/**
 * Renames `from` over `to`, as the last step of an atomic write. On Windows a file another program
 * holds open cannot be replaced, and that is most often brief: the rename is tried again a few times
 * with growing pauses (about a second and a half in all). When the file stays held, the error names
 * the file and says that another program holds it. Elsewhere, and for any other error, the first
 * error is the answer.
 */
export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameOptions = {},
): Promise<void> {
  const move = options.rename ?? rename;
  const windows = (options.platform ?? process.platform) === "win32";
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (!windows || code === undefined || !HELD_CODES.has(code)) throw error;
      const pause = RETRY_DELAYS_MS[attempt];
      if (pause === undefined) {
        throw new AgentPluggedError(ErrorCode.UNEXPECTED, "error.file_in_use", {
          path: to,
          code,
        });
      }
      await wait(pause);
    }
  }
}
