import type { ErrorCode } from "@agentplugged/protocol";

/** One problem found by `docs check`: `{ code, message_key, details }`, `details.path` and `line`. */
export interface DocsProblem {
  readonly code: ErrorCode;
  readonly message_key: string;
  readonly details: Readonly<Record<string, unknown>> & {
    readonly path: string;
    readonly line: number;
  };
}

/**
 * A warning of `docs check`: something it could not verify. Shown, never failing the
 * check. `message_key` is `docs.check.warning.<reason>`.
 */
export interface DocsWarning {
  readonly reason: string;
  readonly message_key: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/** A document as read: its workspace-relative path and its text. */
export interface DocumentFile {
  readonly path: string;
  readonly text: string;
}

/** What a base reference holds, or why there is none. */
export type DocsBaseRead =
  | {
      readonly found: true;
      /** The commit the reference names. */
      readonly commit: string;
      /** The Markdown files of the folders at that commit, at any depth (no symbolic link). */
      readonly files: readonly DocumentFile[];
    }
  | {
      readonly found: false;
      /**
       * `no_repository`: the folder is not in a Git repository (or Git is missing).
       * `no_commit`: the repository has no commit yet. `unknown_ref`: the reference names nothing.
       * Any other failure (Git refuses the repository, a timeout…) is thrown.
       */
      readonly reason: "no_repository" | "no_commit" | "unknown_ref";
    };

/**
 * Port through which `docs check` reads the documents of a base version (Git). Paths are relative
 * to the workspace root, with `/` as separator, like `WorkspaceFiles`.
 */
export interface DocsBase {
  read(ref: string, dirs: readonly string[]): Promise<DocsBaseRead>;
  /**
   * The texts of Git blobs, by id (the stories a checkpoint approved). A blob missing
   * from the repository, or a folder outside a repository, is left out of the map; any other
   * failure throws.
   */
  readBlobs(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /**
   * The blobs, among `ids`, that the history of the current branch (`HEAD`) ever held (story
   * 3.8: a frozen story is removed only from a branch that had it). Outside a repository, or
   * without a commit, none; any other failure throws.
   */
  blobsInHistory(ids: readonly string[]): Promise<ReadonlySet<string>>;
}
