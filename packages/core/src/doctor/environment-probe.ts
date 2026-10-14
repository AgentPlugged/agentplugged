/**
 * Port through which core looks at the machine for `doctor`: processes, files, ports,
 * memory, keychain. Core never touches them directly. No method may throw for an expected failure:
 * a missing program or a refused port is a value.
 */

/** A folder a tool's installer may leave a program in without adding it to `PATH`. */
export interface DirectorySpec {
  /** The command this folder is for; absent: any. */
  readonly for?: string;
  /** An environment variable that holds the base folder (`ProgramFiles`, `LOCALAPPDATA`)… */
  readonly env?: string;
  /** …or the home folder… */
  readonly home?: true;
  /** …or the root of the file system (not on Windows). */
  readonly root?: true;
  /** The folders below the base. */
  readonly path: readonly string[];
}

/** A program found on the machine. */
export interface FoundCommand {
  readonly name: string;
  /** Absolute path of the program. */
  readonly path: string;
  /** False when only an install folder named by the catalogue revealed it. */
  readonly onPath: boolean;
}

/** What a command printed, and whether it could be started at all. */
export interface EnvironmentRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the program could not be started (not installed). */
  readonly missing?: boolean;
  /** True when it was stopped at its time limit. */
  readonly timedOut?: boolean;
}

export interface RunOptions {
  readonly cwd?: string;
  /** Time limit in milliseconds. */
  readonly timeoutMs?: number;
}

/** What a support report says of the machine, and what it must never say. */
export interface MachineDescription {
  /** `x64`, `arm64`. */
  readonly arch: string;
  /** The system's own version string (`10.0.26200`, a kernel release). */
  readonly release: string;
  /** The account's home folder; undefined when the system does not say. */
  readonly home?: string;
  /** The account's name; undefined when the system does not say. */
  readonly user?: string;
}

/** The port of the machine, for the checks and the repairs. */
export interface EnvironmentProbe {
  /** `process.platform`. */
  readonly platform: string;
  /** `process.version`, `v24.1.0`. */
  nodeVersion(): string;
  /** The machine's memory, in gigabytes. */
  memoryGb(): number;
  /** The first of `names` found on `PATH`, else in `extra`; undefined when none is. */
  find(
    names: readonly string[],
    extra?: readonly DirectorySpec[],
  ): Promise<FoundCommand | undefined>;
  /** The folders `specs` name on this machine (those whose base is unknown are left out). */
  directories(specs: readonly DirectorySpec[]): string[];
  /** Runs a program without a shell, output captured, never a prompt. */
  run(command: readonly string[], options?: RunOptions): Promise<EnvironmentRun>;
  /**
   * Runs a program with the creator's terminal as its standard input and output (a sign-in in the
   * browser, a password, an installer's own questions); resolves with the exit code.
   */
  runInTerminal(
    command: readonly string[],
    options?: RunOptions,
  ): Promise<{
    readonly status: number | null;
    readonly missing?: boolean;
  }>;
  /** True when the working folder is inside a Git repository. */
  isRepository(): Promise<boolean>;
  /** A key of the Git configuration as the engine's Git reads it (`user.name`); undefined when unset. */
  gitConfig(key: string): Promise<string | undefined>;
  /** The forge of the `origin` remote: `github`, `gitlab`, or none known; with its host. */
  forge(): Promise<{ readonly forge?: "github" | "gitlab"; readonly host?: string }>;
  /** Whether something can listen on `port` here. */
  port(port: number): Promise<"free" | "busy" | "refused">;
  /** Whether the system keychain answers. Reads nothing secret. */
  keychain(): Promise<boolean>;
  /** Whether Windows Hello (the platform authenticator) is available. */
  presence(): Promise<boolean>;
  /** An environment variable of this process; undefined when unset or empty. */
  env(name: string): string | undefined;
  /** The names (never the values) of the environment variables this process holds. */
  envNames(): string[];
  /** The machine as a support report describes it: architecture, system, home folder, account. */
  describeMachine(): MachineDescription;
  /** The product's folder, as an absolute path. */
  workingFolder(): string;
  /** Free space, in gigabytes, on the disk of the working folder; undefined when unreadable. */
  diskFreeGb(): Promise<number | undefined>;
  /**
   * The TCP port ranges the system keeps for itself (Windows: `netsh interface ipv4 show
   * excludedportrange protocol=tcp`); undefined when the system has none to tell or cannot say.
   */
  reservedPortRanges(): Promise<
    readonly { readonly from: number; readonly to: number }[] | undefined
  >;
  /** Whether the process has administrator rights; undefined when it cannot be known. */
  isAdministrator(): Promise<boolean | undefined>;
  /** Windows only: whether the system accepts paths longer than 260 characters; undefined: unknown. */
  longPathsEnabled(): Promise<boolean | undefined>;
  /**
   * The folders of the `PATH` the system itself holds (Windows: the machine's and the account's, as
   * a program opened now would receive them), which a program opened earlier does not have yet;
   * undefined where the system keeps no such list.
   */
  systemPath(): Promise<readonly string[] | undefined>;
  /** The folders of the `PATH` this process holds. */
  processPath(): readonly string[];
  /** The first of `names` found in one of these absolute folders; undefined when none is. */
  findIn(names: readonly string[], folders: readonly string[]): Promise<FoundCommand | undefined>;
}

/** The extensions Windows runs when `PATHEXT` says nothing. */
export const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** An environment variable; case-insensitive on Windows, like the system. */
export function envValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  windows: boolean,
): string | undefined {
  const exact = env[name];
  if (exact !== undefined || !windows) return exact;
  const upper = name.toUpperCase();
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === upper);
  return key === undefined ? undefined : env[key];
}
