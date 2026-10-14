import type { WorkspaceFiles } from "../workspace-files.js";

/**
 * Port through which core reads the method shipped with the engine (`agents/`, `skills/`), with
 * paths relative to the method's root. The surface (CLI) provides it.
 */
export type MethodSource = Pick<WorkspaceFiles, "listFiles" | "readText" | "readBytes">;
