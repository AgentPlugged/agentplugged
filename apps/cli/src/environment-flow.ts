import { NodeToolProbe } from "@agentplugged/adapters-tools";
import {
  type AgentPluggedError,
  answerProblem,
  type CommandContext,
  type CommandRegistry,
  type Diagnosis,
  type DoctorItem,
  type DoctorReport,
  type DoctorResult,
  displayCommand,
  type EnvironmentProbe,
  type InstallChannel,
  type Localized,
  type MethodSource,
  type PlannedAsk,
  type PlannedFix,
  readInstallChannel,
  runFix,
  type SupportReport,
  type WorkspaceFiles,
  withAnswers,
} from "@agentplugged/core";
import type { Locale, Translate } from "@agentplugged/i18n";
import { GoBack } from "./menu.js";
import { askText, askYesNo, type Prompter } from "./prompt.js";

/**
 * The report of `doctor` and its repairs at the terminal: one line per point (✓ ready,
 * ⚠ to improve, ✗ blocking), then for each point the engine can repair, the exact command, one
 * answer, the command run, and the point read again. Nothing runs in silence, and nothing runs
 * without the creator's yes except the one repair the catalogue marks as harmless (`--yes`).
 */

/** A sentence in the creator's language. */
export function say(locale: Locale, text: Localized): string {
  return locale === "fr" ? text.fr : text.en;
}

const SYMBOL = { ok: "✓", warn: "⚠", fail: "✗" } as const;

/** The report: its groups, then one line per point, then the count. */
export function formatReport(t: Translate, locale: Locale, report: DoctorReport): string {
  const lines: string[] = [t("doctor.heading"), ""];
  for (const group of report.groups) {
    const items = report.items.filter((item) => item.group === group.id);
    if (items.length === 0) continue;
    lines.push(say(locale, group.title));
    for (const item of items) lines.push(`  ${SYMBOL[item.status]} ${say(locale, item.text)}`);
    lines.push("");
  }
  lines.push(summaryLine(t, report));
  return `${lines.join("\n")}\n`;
}

/**
 * The diagnosis of a failure: the cause the machine showed, or that none was found, then
 * what the failure shows by itself, what was read on the machine, and what is only supposed, each
 * under its own title, so that a fact is never taken for a supposition.
 */
export function formatDiagnosis(t: Translate, locale: Locale, diagnosis: Diagnosis): string {
  const lines: string[] = [t("doctor.diagnosis.title"), `  ${say(locale, diagnosis.headline)}`];
  if (diagnosis.failure.length > 0) {
    lines.push("", t("doctor.diagnosis.failure"));
    for (const text of diagnosis.failure) lines.push(`  - ${say(locale, text)}`);
  }
  if (diagnosis.observed.length > 0) {
    lines.push("", t("doctor.diagnosis.observed"));
    for (const item of diagnosis.observed) {
      lines.push(`  ${SYMBOL[item.status]} ${say(locale, item.text)}`);
    }
  }
  if (diagnosis.assumed.length > 0) {
    lines.push("", t("doctor.diagnosis.assumed"));
    for (const text of diagnosis.assumed) lines.push(`  - ${say(locale, text)}`);
  }
  if (diagnosis.next !== undefined) {
    lines.push("", t("doctor.diagnosis.next", { text: say(locale, diagnosis.next) }));
  }
  lines.push("", say(locale, diagnosis.doctor));
  return `${lines.join("\n")}\n`;
}

/**
 * The report to attach to a request for help, as Markdown: the system, the versions,
 * one line per check, then what was removed. Meant to be pasted into an issue or a message.
 */
export function formatSupportReport(t: Translate, locale: Locale, report: SupportReport): string {
  const system = report.system;
  const lines: string[] = [
    t("doctor.report.title"),
    "",
    t("doctor.report.intro"),
    "",
    t("doctor.report.system"),
    `- ${t("doctor.report.engine", { version: report.engine })}`,
    `- ${t("doctor.report.os", { platform: system.platform, arch: system.arch, release: system.release })}`,
    `- Node.js: ${system.node}`,
    `- ${t("doctor.report.shell", { shell: system.shell })}`,
    `- ${t(system.interactive ? "doctor.report.terminal.interactive" : "doctor.report.terminal.script")}`,
    `- ${t(system.ci ? "doctor.report.ci.yes" : "doctor.report.ci.no")}`,
    "",
  ];
  if (report.versions.length > 0) {
    lines.push(t("doctor.report.versions"));
    for (const entry of report.versions) lines.push(`- ${entry.tool} ${entry.version}`);
    lines.push("");
  }
  lines.push(t("doctor.report.checks"));
  for (const check of report.checks) {
    lines.push(
      `- ${SYMBOL[check.status]} \`${check.id}\` (${check.outcome}): ${say(locale, check.text)}`,
    );
  }
  if (report.unreadable.length > 0) {
    lines.push("", `- ${t("doctor.report.unreadable", { list: report.unreadable.join(", ") })}`);
  }
  lines.push("", t("doctor.summary", report.counts), "", t("doctor.report.removed"));
  for (const entry of report.removed) lines.push(`- ${say(locale, entry)}`);
  lines.push(t("doctor.report.never_read"), "");
  return lines.join("\n");
}

/** The count of the report, in one line. */
export function summaryLine(t: Translate, report: DoctorReport): string {
  return report.counts.warn === 0 && report.counts.fail === 0
    ? t("doctor.summary.ready")
    : t("doctor.summary", report.counts);
}

/** The steps to follow by hand, numbered, copyable. */
export function formatSteps(t: Translate, locale: Locale, fix: PlannedFix): string {
  const steps = locale === "fr" ? fix.steps.fr : fix.steps.en;
  if (steps.length === 0) return "";
  return `${[t("doctor.steps.title"), ...steps.map((step, i) => `    ${i + 1}. ${step}`)].join("\n")}\n`;
}

/** The points a repair or steps are given for, worst first: what blocks, then what can improve. */
function pending(report: DoctorReport): DoctorItem[] {
  return report.items.filter((item) => item.status !== "ok" && item.fix !== undefined);
}

export interface RepairOptions {
  readonly t: Translate;
  readonly locale: Locale;
  readonly write: (text: string) => void;
  readonly probe: EnvironmentProbe;
  /** Reads the whole report again, or only some points. */
  readonly reread: (only?: readonly string[]) => Promise<DoctorReport | undefined>;
  /**
   * `ask`: the creator is at the terminal and answers each repair; `unattended`: no one answers, only
   * the repairs the catalogue marks harmless run; `none`: the report alone.
   */
  readonly mode: "ask" | "unattended" | "none";
  /** Who answers, in `ask` mode. */
  readonly prompter?: Prompter | undefined;
  /** Explains a repair that failed with what the machine shows. */
  readonly diagnose?:
    | ((failure: {
        readonly exit_code?: number;
        readonly output?: string;
      }) => Promise<Diagnosis | undefined>)
    | undefined;
}

/** What the repairs did: the report as it is now. */
export interface RepairOutcome {
  readonly report: DoctorReport;
  /** Some repair ran (so the report was read again). */
  readonly changed: boolean;
}

/** Longest chain of repairs followed by a new reading: Git, then what Git alone made possible. */
const MAX_ROUNDS = 3;

function commandLines(display: string): string {
  return display
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** A typed answer, checked; the end of the input cancels like every other question. */
async function askAnswers(
  t: Translate,
  prompter: Prompter,
  asks: readonly PlannedAsk[],
  locale: Locale,
): Promise<Record<string, string>> {
  const answers: Record<string, string> = {};
  for (const ask of asks) {
    const question = `${say(locale, ask.say)}${ask.default === "" ? "" : ` [${ask.default}]`}${locale === "fr" ? " : " : ": "}`;
    const answer = await askText(t, prompter, question, {
      required: true,
      ...(ask.default === "" ? {} : { fallback: ask.default }),
      check: (typed) => (answerProblem(ask, typed) ? t("doctor.fix.answer_invalid") : undefined),
    });
    answers[ask.name] = (answer ?? ask.default).trim();
  }
  return answers;
}

/**
 * Proposes the repairs of the report, one after the other, and runs those the creator accepts. A
 * point with steps only gets its steps when it blocks. Returns the report read again after the
 * last repair that ran.
 */
export async function repair(report: DoctorReport, options: RepairOptions): Promise<RepairOutcome> {
  const { t, locale, write, mode, prompter } = options;
  let current = report;
  let changed = false;
  const offered = new Set<string>();
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    let ran = false;
    for (const item of pending(current)) {
      if (offered.has(item.id)) continue;
      offered.add(item.id);
      const fix = item.fix as PlannedFix;
      if (fix.kind === "steps") {
        // A blocking point says what to do; the others wait for `doctor`.
        if (item.status === "fail" && mode !== "none") {
          write(`${formatSteps(t, locale, fix)}`);
        }
        continue;
      }
      if (mode === "none") continue;
      // A repair that needs answers is never run unattended.
      if (mode === "unattended" && (!fix.unattended || fix.asks.length > 0)) continue;
      write(`\n${t("doctor.fix.title", { text: say(locale, item.text) })}\n`);
      write(`${t("doctor.fix.command")}\n${commandLines(fix.display)}\n`);
      if (fix.interactive && fix.asks.length === 0) write(`${t("doctor.fix.interactive")}\n`);
      let answers: Record<string, string> = {};
      if (mode === "ask") {
        if (prompter === undefined) continue;
        try {
          const yes = await askYesNo(
            t,
            prompter,
            t(fix.recommended ? "doctor.fix.ask.yes" : "doctor.fix.ask.no"),
            fix.recommended,
          );
          if (!yes) {
            write(`${t("doctor.fix.declined")}\n`);
            if (fix.steps.en.length > 0 && item.status === "fail")
              write(formatSteps(t, locale, fix));
            continue;
          }
          if (fix.asks.length > 0) answers = await askAnswers(t, prompter, fix.asks, locale);
        } catch (error) {
          // Escape: not this one.
          if (error instanceof GoBack) {
            write(`${t("doctor.fix.declined")}\n`);
            continue;
          }
          throw error;
        }
      }
      const commands = withAnswers(fix, answers);
      if (fix.asks.length > 0) {
        // What will run, with the answers in it.
        write(
          `${t("doctor.fix.command_filled")}\n${commandLines(commands.map(displayCommand).join("\n"))}\n`,
        );
      }
      write(`${t("doctor.fix.running")}\n`);
      const result = await runFix(
        options.probe,
        commands,
        mode === "ask" ? "terminal" : "captured",
      );
      if (result.status !== 0) {
        write(
          `${
            result.missing
              ? t("doctor.fix.failed.missing")
              : result.timedOut
                ? t("doctor.fix.failed.timeout")
                : t("doctor.fix.failed", { code: result.status ?? "?" })
          }\n`,
        );
        if (result.output !== "" && mode !== "ask")
          write(`    ${result.output.split("\n").join("\n    ")}\n`);
        // What the machine shows about this failure, apart from what is only supposed.
        const why = await options.diagnose?.({
          ...(result.status === null ? {} : { exit_code: result.status }),
          ...(result.output === "" ? {} : { output: result.output }),
        });
        if (why !== undefined && why.cause !== "unknown") {
          write(`\n${formatDiagnosis(t, locale, why)}\n`);
        }
        if (fix.steps.en.length > 0) write(formatSteps(t, locale, fix));
        continue;
      }
      ran = true;
      changed = true;
      const again = await options.reread([item.id]);
      const now = again?.items[0];
      if (now === undefined || now.status === "ok") {
        write(
          `${t("doctor.fix.fixed", { text: now === undefined ? "" : say(locale, now.text) })}\n`,
        );
      } else {
        if (fix.done !== undefined) write(`  ${say(locale, fix.done)}\n`);
        else write(`${t("doctor.fix.still", { text: say(locale, now.text) })}\n`);
      }
    }
    if (!ran) break;
    // What the repair made possible (a repository needs Git first) is read again.
    const fresh = await options.reread();
    if (fresh === undefined) break;
    current = fresh;
  }
  return { report: current, changed };
}

/** What the flows need of the surface: its streams and whether someone answers. */
export interface FlowEnvironment {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly engineVersion: string;
  readonly stdout: (text: string) => void;
  readonly interactive?: boolean | undefined;
  readonly stdin?: NodeJS.ReadableStream | undefined;
}

/** Who answers, created on first use. */
export interface FlowPrompts {
  get(): Prompter;
}

function someoneAnswers(environment: FlowEnvironment): boolean {
  return environment.interactive === true && environment.stdin !== undefined;
}

/** The report as JSON, for scripts: each point in both languages, with the repair it has. */
export function doctorJson(report: DoctorResult, channel: InstallChannel | "npm" = "npm"): string {
  return `${JSON.stringify(
    {
      format: 1,
      install_channel: channel,
      platform: report.platform,
      blocking: report.blocking,
      counts: report.counts,
      ...(report.diagnosis === undefined
        ? {}
        : {
            diagnosis: {
              matched: report.diagnosis.matched,
              cause: report.diagnosis.cause,
              headline: report.diagnosis.headline,
              failure: report.diagnosis.failure,
              observed: report.diagnosis.observed.map((item) => ({
                id: item.id,
                status: item.status,
                text: item.text,
              })),
              assumed: report.diagnosis.assumed,
              ...(report.diagnosis.next === undefined ? {} : { next: report.diagnosis.next }),
            },
          }),
      points: report.items.map((item) => ({
        id: item.id,
        group: item.group,
        status: item.status,
        outcome: item.outcome,
        text: item.text,
        ...(item.fix === undefined
          ? {}
          : {
              fix: {
                kind: item.fix.kind,
                ...(item.fix.kind === "run" ? { command: item.fix.display.split("\n") } : {}),
                automatic: item.fix.kind === "run" && !item.fix.interactive,
                steps: item.fix.steps,
              },
            }),
      })),
    },
    null,
    2,
  )}\n`;
}

/** Reads what a failure points to on the machine; undefined when it cannot be read. */
function diagnoser(
  registry: CommandRegistry,
  context: CommandContext,
): (failure: {
  readonly exit_code?: number;
  readonly output?: string;
}) => Promise<Diagnosis | undefined> {
  return async (failure) => {
    const result = await registry.run("doctor", context, { only: [], failure });
    return result.ok ? (result.value as DoctorResult).diagnosis : undefined;
  };
}

/** Reads the machine again, whole or only some points; undefined when the catalogue cannot be read. */
function rereader(
  registry: CommandRegistry,
  context: CommandContext,
): (only?: readonly string[]) => Promise<DoctorReport | undefined> {
  return async (only) => {
    const again = await registry.run("doctor", context, only === undefined ? {} : { only });
    return again.ok ? (again.value as DoctorReport) : undefined;
  };
}

/**
 * The first step of `init`: looks at the machine before anything is written, says what
 * it found and, at a terminal, proposes the repairs one by one (a key each). A script gets the report;
 * `--yes` also lets the one harmless repair run. Never stops the installation: the report it returns
 * says whether a blocking point remains.
 */
export async function machineStep(
  environment: FlowEnvironment,
  t: Translate,
  locale: Locale,
  registry: CommandRegistry,
  files: WorkspaceFiles,
  method: MethodSource,
  probe: EnvironmentProbe | undefined,
  options: {
    readonly yes: boolean;
    readonly prompts: FlowPrompts;
    readonly onError: (error: AgentPluggedError) => void;
  },
): Promise<DoctorReport | undefined> {
  if (probe === undefined) return undefined;
  const context: CommandContext = {
    files,
    tools: new NodeToolProbe({ env: environment.env }),
    method,
    actor: "human",
    engineVersion: environment.engineVersion,
    environment: probe,
  };
  const reread = rereader(registry, context);
  const first = await registry.run("doctor", context, {});
  if (!first.ok) {
    // The catalogue cannot be read: said, and the installation goes on.
    options.onError(first.error);
    return undefined;
  }
  const report = first.value as DoctorReport;
  environment.stdout(formatReport(t, locale, report));
  const mode = someoneAnswers(environment) ? "ask" : options.yes ? "unattended" : "none";
  const outcome = await repair(report, {
    t,
    locale,
    write: environment.stdout,
    probe,
    reread,
    mode,
    prompter: mode === "ask" ? options.prompts.get() : undefined,
    diagnose: diagnoser(registry, context),
  });
  if (outcome.changed) environment.stdout(`\n${summaryLine(t, outcome.report)}\n`);
  if (outcome.report.counts.warn > 0 || outcome.report.counts.fail > 0) {
    environment.stdout(`\n${t("doctor.later")}\n`);
  }
  environment.stdout("\n");
  return outcome.report;
}

/**
 * `doctor` at the terminal: the report, then the repairs one by one when someone
 * answers; the exit code says whether a blocking point remains. `--json` gives the report alone.
 */
export async function runDoctorCommand(
  environment: FlowEnvironment,
  t: Translate,
  locale: Locale,
  registry: CommandRegistry,
  context: CommandContext,
  report: DoctorResult,
  options: { readonly json: boolean; readonly prompts: FlowPrompts },
): Promise<number> {
  // The report to attach to a request for help; it only looks, whoever reads it.
  if (report.support !== undefined) {
    environment.stdout(formatSupportReport(t, locale, report.support));
    return 0;
  }
  // how the method was installed (the store noted by `init --channel`, else npm).
  const channel = (await readInstallChannel(context.files)) ?? "npm";
  if (options.json) {
    environment.stdout(doctorJson(report, channel));
    return report.blocking ? 1 : 0;
  }
  const probe = context.environment;
  // A failure given: the cause comes first, then the usual report.
  if (report.diagnosis !== undefined) {
    environment.stdout(`${formatDiagnosis(t, locale, report.diagnosis)}\n`);
  }
  environment.stdout(formatReport(t, locale, report));
  environment.stdout(`${t(`doctor.channel.${channel}`)}

`);
  const mode = probe !== undefined && someoneAnswers(environment) ? "ask" : "none";
  let final = report;
  if (probe !== undefined) {
    const outcome = await repair(report, {
      t,
      locale,
      write: environment.stdout,
      probe,
      reread: rereader(registry, context),
      mode,
      prompter: mode === "ask" ? options.prompts.get() : undefined,
      diagnose: diagnoser(registry, context),
    });
    final = outcome.report;
    if (outcome.changed) environment.stdout(`\n${summaryLine(t, outcome.report)}\n`);
  }
  // Without a terminal, the steps of the points that wait are given too.
  if (mode === "none") {
    for (const item of final.items) {
      if (item.status !== "ok" && item.fix !== undefined && item.fix.steps.en.length > 0) {
        environment.stdout(`\n${say(locale, item.text)}\n${formatSteps(t, locale, item.fix)}`);
      }
    }
  }
  if (final.counts.warn > 0 || final.counts.fail > 0) {
    environment.stdout(`\n${t("doctor.later")}\n`);
  }
  return final.blocking ? 1 : 0;
}
