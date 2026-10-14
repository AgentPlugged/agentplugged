/** Editor whose extension folder can reveal a tool. */
export type Editor = "vscode" | "cursor";

/** A command found in `PATH`. */
export interface CommandMatch {
  /** The name that matched, for example `gemini`. */
  readonly name: string;
  /** Absolute path of the executable. */
  readonly path: string;
  /**
   * False when the command was found in a folder its installer uses without adding it to `PATH`
   *; absent or true: it is on `PATH`.
   */
  readonly onPath?: boolean;
}

/** One installed extension folder. */
export interface ExtensionMatch {
  readonly editor: Editor;
  /** The `version` of its `package.json`, or undefined when it cannot be read. */
  readonly version: string | undefined;
}

/**
 * Port through which core looks at the machine for AI tools: processes, file system and
 * environment variables. Core never touches them directly. No method may throw for an
 * expected failure: a missing tool or a failed probe is reported as `undefined` or `[]`.
 */
export interface ToolProbe {
  /** The first of `names` found in `PATH`, in the given order. */
  which(names: readonly string[]): Promise<CommandMatch | undefined>;
  /**
   * Output of `<path> --version`. Undefined when the probe fails: start error, non-zero exit
   * code or time limit exceeded.
   */
  version(path: string): Promise<string | undefined>;
  /** Extension folders named `<prefix>-*` in the editors' extension folders. */
  extensions(prefix: string): Promise<ExtensionMatch[]>;
}
