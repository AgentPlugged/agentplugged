/**
 * Port through which core reaches the product's folder. Paths are relative to the
 * workspace root and use `/` as separator. Core never touches the file system directly.
 */
export interface WorkspaceFiles {
  /** True when a file or folder exists at `path`. */
  exists(path: string): Promise<boolean>;
  /** Reads a UTF-8 text file. Fails when it does not exist or cannot be read. */
  readText(path: string): Promise<string>;
  /** Reads a file as raw bytes. Fails when it does not exist or cannot be read. */
  readBytes(path: string): Promise<Uint8Array>;
  /** Writes a UTF-8 text file atomically, creating missing parent folders. */
  writeText(path: string, content: string): Promise<void>;
  /** Writes raw bytes atomically, creating missing parent folders. */
  writeBytes(path: string, content: Uint8Array): Promise<void>;
  /** Creates a folder and its missing parents; does nothing when it already exists. */
  mkdir(path: string): Promise<void>;
  /**
   * Every file under the folder `dir`, at any depth, as workspace-relative paths sorted in code
   * point order. Empty when the folder does not exist. Symbolic links to folders are not followed.
   */
  listFiles(dir: string): Promise<string[]>;
  /**
   * The names of the entries (files and folders) directly in the folder `dir` (`""`: the root),
   * sorted in UTF-16 code unit order (`Array.prototype.sort`); empty when the folder does not
   * exist or cannot be read (missing, not a folder, no permission). Optional: callers without it
   * see no entry.
   */
  listEntries?(dir: string): Promise<string[]>;
  /** True when `path` itself is a symbolic link (optional: false when absent). */
  isSymbolicLink?(path: string): Promise<boolean>;
  /** Deletes a file, or an empty folder. Does nothing when nothing exists at `path`. */
  remove(path: string): Promise<void>;
  /**
   * Creates a UTF-8 text file that must not exist yet, whole or not at all (never replacing
   * anything, not even an entry created meanwhile): false when something is already at `path`.
   * Its parent folder must exist. Optional: callers without it cannot create exclusively.
   */
  createText?(path: string, content: string): Promise<boolean>;
}
