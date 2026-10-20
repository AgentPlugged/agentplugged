import { spawn } from "node:child_process";
import { win32 } from "node:path";
import {
  type Launcher,
  type RunBilling,
  type RunEvent,
  type RunOutcome,
  type RunRequest,
  RunRequestInvalid,
  type RunResult,
  type RunUsage,
  type ToolRun,
  type ToolTranslator,
} from "./contract.js";
import { LineSplitter } from "./lines.js";
import { type RunSettingsFile, writeRunSettings } from "./run-settings.js";

/** A run that outlasts this is stopped (the request may ask for less or more). */
export const DEFAULT_MAX_DURATION_MS = 30 * 60 * 1000;
/** How long a live input stays open after an answer that leaves it idle but fewer answers than messages. */
const IDLE_GRACE_MS = 15_000;
/** How long a process gets to end by itself after a polite stop before it is killed. */
const GRACE_MS = 3000;
/** How long the output gets to drain after the process exited (a grandchild may hold the pipe). */
const DRAIN_MS = 1000;
/** The end of the error output kept for the failure code, never forwarded as text. */
const STDERR_KEEP = 4000;

export interface StartToolRunOptions {
  readonly translator: ToolTranslator;
  readonly request: RunRequest;
  readonly launcher: Launcher;
  /** The whole environment of the process: nothing else is inherited. */
  readonly env: Readonly<Record<string, string>>;
  /** Defaults to the running platform. */
  readonly platform?: NodeJS.Platform;
  readonly clock?: () => number;
}

/** Stops a process and its descendants; resolves once the stop was issued. */
function killTree(pid: number, windows: boolean, signal: "polite" | "hard"): Promise<void> {
  if (windows) {
    return new Promise((resolve) => {
      try {
        const root = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
        const taskkill = win32.join(root, "System32", "taskkill.exe");
        spawn(taskkill, ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
          .on("error", () => resolve())
          .on("close", () => resolve());
      } catch {
        resolve();
      }
    });
  }
  try {
    // The child leads its own process group: the signal reaches everything it started.
    process.kill(-pid, signal === "polite" ? "SIGTERM" : "SIGKILL");
  } catch {
    // Already gone.
  }
  return Promise.resolve();
}

/**
 * Starts the official program of a tool in non-interactive mode and follows it: its output is cut
 * into lines, each line parsed as JSON and read by the tool's translator into normalized events;
 * the process is stopped on request or past its time, with everything it started; and the way it
 * ended is judged from what it said, not from its exit code alone.
 */
export function startToolRun(options: StartToolRunOptions): ToolRun {
  const { translator, request, launcher } = options;
  const windows = (options.platform ?? process.platform) === "win32";
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  // Refuses an unacceptable request before anything is started.
  const plan = translator.plan(request);
  // A live input needs a tool that takes messages on its input and says when it is idle.
  const live = request.liveInput === true;
  if (
    live &&
    (translator.capabilities.liveInput !== true ||
      translator.frame === undefined ||
      translator.begin().idle === undefined)
  ) {
    throw new RunRequestInvalid("liveInput: this tool cannot take messages while it runs");
  }
  // The rules of a launch that are too many for a command line travel in a file of the launch.
  let settingsFile: RunSettingsFile | undefined;
  let settingsFailed = false;
  if (plan.settings !== undefined) {
    try {
      settingsFile = writeRunSettings(plan.settings);
    } catch {
      settingsFailed = true;
    }
  }
  const reader = translator.begin();
  const listeners = new Set<(event: RunEvent) => void>();

  let session: string | undefined;
  let billing: RunBilling | undefined;
  let usage: RunUsage | undefined;
  let turn: Extract<RunEvent, { type: "turn.completed" }> | undefined;
  let denied = 0;
  const deniedTools: string[] = [];
  let stderr = "";
  let stopRequested = false;
  let timedOut = false;
  let spawnFailure: string | undefined;
  let exitCode: number | null = null;
  let exited = false;
  let finished = false;
  // Live input: the messages written so far (the prompt is the first), the answers read, and
  // whether the input is still open.
  let inputs = 1;
  let answers = 0;
  let inputOpen = live;
  let timer: NodeJS.Timeout | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let resolveDone: (result: RunResult) => void = () => {};
  const done = new Promise<RunResult>((resolve) => {
    resolveDone = resolve;
  });

  const emit = (event: RunEvent): void => {
    switch (event.type) {
      case "session.started":
        session = event.session;
        billing = event.billing ?? billing;
        break;
      case "usage":
        usage = event.usage;
        break;
      case "permission.denied":
        denied += 1;
        if (
          deniedTools.length < 5 &&
          !deniedTools.includes(event.tool) &&
          /^[A-Za-z0-9_.:-]{1,40}$/.test(event.tool)
        ) {
          deniedTools.push(event.tool);
        }
        break;
      case "turn.completed":
        turn = event;
        answers += 1;
        if (event.session !== undefined) session = event.session;
        if (event.usage !== undefined) usage = event.usage;
        break;
      default:
        break;
    }
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // A listener that fails never stops the run.
      }
    }
  };

  let closeInputWhenIdle: (ok: boolean) => void = () => {};
  let idleTimer: NodeJS.Timeout | undefined;
  const feed = (line: string): void => {
    // Any activity of the tool means it is not idle after all.
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // A line that is not JSON (a banner, a warning) carries nothing to report.
      return;
    }
    try {
      for (const event of reader.line(value)) {
        emit(event);
        // The input stays open for further messages until the tool has answered all it was given
        // and runs nothing in the background: from then on nothing can come, the program may end.
        if (event.type === "turn.completed") closeInputWhenIdle(event.ok);
      }
    } catch {
      emit({
        type: "error",
        code: "unreadable_line",
        message: "a line of the output was not understood",
      });
    }
  };

  const outcomeOf = (): { outcome: RunOutcome; failure?: string } => {
    if (spawnFailure !== undefined) return { outcome: "not_started", failure: spawnFailure };
    if (timedOut) return { outcome: "timeout", failure: "timeout" };
    if (stopRequested) return { outcome: "stopped" };
    if (turn !== undefined) {
      if (!turn.ok) return { outcome: "failed", failure: turn.failure ?? "turn_failed" };
      if (exitCode !== 0) return { outcome: "failed", failure: `exit_${exitCode ?? "signal"}` };
      return { outcome: "completed" };
    }
    // No turn ever ended: an exit code of 0 is not a success.
    return {
      outcome: "failed",
      failure: exitCode === 0 ? "no_result" : `exit_${exitCode ?? "signal"}`,
    };
  };

  const finish = (): void => {
    if (finished) return;
    finished = true;
    settingsFile?.remove();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (timer !== undefined) clearTimeout(timer);
    if (drainTimer !== undefined) clearTimeout(drainTimer);
    const { outcome, failure } = outcomeOf();
    const result: RunResult = {
      outcome,
      exitCode,
      ...(session === undefined ? {} : { session }),
      ...(turn?.text === undefined ? {} : { text: turn.text }),
      ...(usage === undefined ? {} : { usage }),
      ...(turn?.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
      ...(billing === undefined ? {} : { billing }),
      denied,
      deniedTools,
      ...(failure === undefined ? {} : { failure }),
      durationMs: Math.max(0, clock() - startedAt),
    };
    resolveDone(result);
  };

  let child: ReturnType<typeof spawn>;
  try {
    if (settingsFailed)
      throw Object.assign(new Error("settings"), { code: "settings_not_written" });
    const settingsArgs = settingsFile === undefined ? [] : ["--settings", settingsFile.path];
    child = spawn(launcher.file, [...launcher.prefixArgs, ...plan.args, ...settingsArgs], {
      cwd: request.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: launcher.verbatim === true,
      shell: false,
      detached: !windows,
    });
  } catch (error) {
    spawnFailure = error instanceof Error && "code" in error ? String(error.code) : "spawn_failed";
    emit({ type: "error", code: "not_started", message: "the program could not be started" });
    finish();
    return {
      pid: undefined,
      onEvent: () => () => {},
      stop: () => Promise.resolve(),
      done,
    };
  }

  const splitter = new LineSplitter();
  const stdout = child.stdout;
  stdout?.on("data", (chunk: Buffer) => {
    for (const line of splitter.push(chunk)) feed(line);
  });
  stdout?.on("end", () => {
    for (const line of splitter.end()) feed(line);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (text: string) => {
    stderr = (stderr + text).slice(-STDERR_KEEP);
  });
  child.stdin?.on("error", () => {});
  const frame = translator.frame;
  if (live && frame !== undefined) {
    child.stdin?.write(`${frame(request.prompt)}\n`);
    const closeInput = (): void => {
      if (!inputOpen) return;
      inputOpen = false;
      child.stdin?.end();
    };
    closeInputWhenIdle = (ok) => {
      if (!inputOpen) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = undefined;
      // A turn that failed ends the run whatever is still pending: nothing would wake it again.
      if (!ok) return closeInput();
      if (reader.idle?.() !== true) return;
      if (answers >= inputs) return closeInput();
      // Messages the tool took together get one answer: if nothing starts soon after an answer
      // that leaves nothing in the background, the input is closed anyway (see `feed`).
      idleTimer = setTimeout(closeInput, IDLE_GRACE_MS);
    };
  } else {
    child.stdin?.end(request.prompt);
  }

  const settle = (): void => {
    if (!exited || finished) return;
    // The output has had its time to drain: whatever still holds a pipe is let go.
    stdout?.destroy();
    child.stderr?.destroy();
    for (const line of splitter.end()) feed(line);
    if (turn === undefined && !stopRequested && !timedOut && spawnFailure === undefined) {
      if (exitCode !== 0 && stderr.trim() !== "") {
        emit({
          type: "error",
          code: "exit_without_result",
          message: "the program ended without a result",
        });
      }
    }
    finish();
  };

  child.on("error", (error) => {
    if (exited) return;
    spawnFailure = "code" in error ? String(error.code) : "spawn_failed";
    exited = true;
    emit({ type: "error", code: "not_started", message: "the program could not be started" });
    settle();
  });
  child.on("exit", (code) => {
    if (exited) return;
    exited = true;
    inputOpen = false;
    exitCode = code;
    // Give the output a moment to reach its end, then settle.
    if (stdout === null || stdout === undefined || stdout.destroyed || stdout.readableEnded)
      settle();
    else {
      stdout.once("close", settle);
      drainTimer = setTimeout(settle, DRAIN_MS);
    }
  });

  const pid = child.pid;
  const stopNow = async (): Promise<void> => {
    // A process that already exited has freed its id: nothing is killed through it.
    if (pid === undefined || exited) return;
    inputOpen = false;
    child.stdin?.destroy();
    await killTree(pid, windows, "polite");
    if (!windows) {
      // What ignored the polite signal is killed once the program is gone or the grace is over.
      await new Promise<void>((resolve) => {
        const hard = setTimeout(resolve, GRACE_MS);
        child.once("exit", () => {
          clearTimeout(hard);
          resolve();
        });
        if (exited) resolve();
      });
      await killTree(pid, windows, "hard");
    }
  };

  timer = setTimeout(() => {
    if (finished || exited) return;
    timedOut = true;
    void stopNow();
  }, request.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);

  let stopping: Promise<void> | undefined;
  return {
    pid,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    stop() {
      // After the program exited there is nothing to stop and the outcome stays what it was.
      if (finished || exited) return done.then(() => {});
      stopRequested = true;
      stopping ??= stopNow().then(async () => {
        await done;
      });
      return stopping;
    },
    send(text) {
      const stdin = child.stdin;
      if (!live || frame === undefined || !inputOpen || exited || finished || stopRequested) {
        return false;
      }
      if (stdin === null || stdin === undefined || !stdin.writable) return false;
      try {
        stdin.write(`${frame(text)}\n`);
      } catch {
        return false;
      }
      inputs += 1;
      return true;
    },
    done,
  };
}
