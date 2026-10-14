import type {
  DirectorySpec,
  EnvironmentProbe,
  EnvironmentRun,
  FoundCommand,
  MachineDescription,
  RunOptions,
} from "./environment-probe.js";

/** A program of the simulated machine. */
export interface MemoryCommand {
  /** Absolute path. */
  readonly path: string;
  /** What `--version` prints. */
  readonly version: string;
  /** False: only an install folder of the catalogue reveals it. */
  readonly onPath: boolean;
}

/**
 * `EnvironmentProbe` on a simulated machine (tests only, and processes that must not touch the
 * real one): programs, Git settings, ports, the keychain. Nothing is ever installed nor started;
 * `onRun` lets a test play what a package manager would do (add a program, set a login).
 */
export class MemoryEnvironment implements EnvironmentProbe {
  platform = "win32";
  node = "v24.1.0";
  memory = 16;
  /** Programs by name. */
  readonly commands = new Map<string, MemoryCommand>();
  /** Programs a `login` of the forge's tool has been run for (their `auth status` exits with 0). */
  readonly loggedIn = new Set<string>();
  repository = true;
  readonly config = new Map<string, string>();
  remote: { forge?: "github" | "gitlab"; host?: string } = { forge: "github", host: "github.com" };
  readonly ports = new Map<number, "free" | "busy" | "refused">();
  keychainWorks = true;
  presenceWorks = false;
  /** Variables of the process (proxy, …). */
  readonly variables = new Map<string, string>();
  folder = "/work/product";
  /** What `describeMachine` answers. */
  machine: MachineDescription = { arch: "x64", release: "10.0.0" };
  diskGb: number | undefined = 100;
  reserved: { from: number; to: number }[] | undefined;
  admin: boolean | undefined = false;
  longPaths: boolean | undefined;
  /** The system's own PATH folders (Windows registry); undefined: the system keeps none. */
  system: string[] | undefined;
  /** The folders of this process' PATH. */
  processFolders: string[] = [];
  /** Every program run with its output captured, and every one run in the terminal. */
  readonly runs: string[][] = [];
  readonly terminalRuns: string[][] = [];
  /** Plays a command: its result, or undefined to let the default answer. */
  onRun?: (command: readonly string[], terminal: boolean) => EnvironmentRun | undefined;

  /** A machine where everything is fine: Node, Git set up, GitHub CLI connected. */
  static healthy(): MemoryEnvironment {
    const machine = new MemoryEnvironment();
    machine.commands.set("git", {
      path: "/usr/bin/git",
      version: "git version 2.46.0",
      onPath: true,
    });
    machine.commands.set("gh", { path: "/usr/bin/gh", version: "gh version 2.60.0", onPath: true });
    machine.loggedIn.add("gh");
    machine.config.set("user.name", "Ada Lovelace");
    machine.config.set("user.email", "ada@example.com");
    return machine;
  }

  nodeVersion(): string {
    return this.node;
  }

  memoryGb(): number {
    return this.memory;
  }

  async find(
    names: readonly string[],
    extra: readonly DirectorySpec[] = [],
  ): Promise<FoundCommand | undefined> {
    for (const name of names) {
      const known = this.commands.get(name);
      if (known === undefined) continue;
      // Off PATH, it is found only when the catalogue names a folder for it.
      if (!known.onPath && !extra.some((spec) => spec.for === undefined || spec.for === name))
        continue;
      return { name, path: known.path, onPath: known.onPath };
    }
    return undefined;
  }

  directories(specs: readonly DirectorySpec[]): string[] {
    return specs.map((spec) => `/${spec.path.join("/")}`);
  }

  #byPath(path: string): [string, MemoryCommand] | undefined {
    return [...this.commands.entries()].find(([, command]) => command.path === path);
  }

  async run(command: readonly string[], _options?: RunOptions): Promise<EnvironmentRun> {
    this.runs.push([...command]);
    const played = this.onRun?.(command, false);
    if (played !== undefined) return played;
    return this.#answer(command);
  }

  async runInTerminal(
    command: readonly string[],
    _options?: RunOptions,
  ): Promise<{ status: number | null; missing?: boolean }> {
    this.terminalRuns.push([...command]);
    const played = this.onRun?.(command, true);
    const result = played ?? this.#answer(command);
    return { status: result.status, ...(result.missing === true ? { missing: true } : {}) };
  }

  #answer(command: readonly string[]): EnvironmentRun {
    const [program = "", ...args] = command;
    const known =
      this.#byPath(program) ??
      (this.commands.has(program)
        ? [program, this.commands.get(program) as MemoryCommand]
        : undefined);
    if (known === undefined) {
      return { status: null, stdout: "", stderr: `${program}: not found`, missing: true };
    }
    const [name, found] = known;
    if (args[0] === "--version") return { status: 0, stdout: found.version, stderr: "" };
    if (args[0] === "auth" && args[1] === "status") {
      return this.loggedIn.has(name)
        ? { status: 0, stdout: "Logged in", stderr: "" }
        : { status: 1, stdout: "", stderr: "You are not logged in" };
    }
    return { status: 0, stdout: "", stderr: "" };
  }

  async isRepository(): Promise<boolean> {
    return this.repository;
  }

  async gitConfig(key: string): Promise<string | undefined> {
    const value = this.config.get(key);
    return value === undefined || value === "" ? undefined : value;
  }

  async forge(): Promise<{ forge?: "github" | "gitlab"; host?: string }> {
    return this.remote;
  }

  async port(port: number): Promise<"free" | "busy" | "refused"> {
    return this.ports.get(port) ?? "free";
  }

  async keychain(): Promise<boolean> {
    return this.keychainWorks;
  }

  async presence(): Promise<boolean> {
    return this.presenceWorks;
  }

  env(name: string): string | undefined {
    const value = this.variables.get(name);
    return value === undefined || value === "" ? undefined : value;
  }

  envNames(): string[] {
    return [...this.variables.keys()];
  }

  describeMachine(): MachineDescription {
    return this.machine;
  }

  workingFolder(): string {
    return this.folder;
  }

  async diskFreeGb(): Promise<number | undefined> {
    return this.diskGb;
  }

  async reservedPortRanges(): Promise<{ from: number; to: number }[] | undefined> {
    return this.reserved;
  }

  async isAdministrator(): Promise<boolean | undefined> {
    return this.admin;
  }

  async longPathsEnabled(): Promise<boolean | undefined> {
    return this.longPaths;
  }

  async systemPath(): Promise<string[] | undefined> {
    return this.system;
  }

  processPath(): string[] {
    return this.processFolders;
  }

  async findIn(
    names: readonly string[],
    folders: readonly string[],
  ): Promise<FoundCommand | undefined> {
    for (const name of names) {
      const known = this.commands.get(name);
      if (known === undefined) continue;
      const cut = Math.max(known.path.lastIndexOf("/"), known.path.lastIndexOf("\\"));
      if (folders.includes(known.path.slice(0, cut))) {
        return { name, path: known.path, onPath: false };
      }
    }
    return undefined;
  }
}
