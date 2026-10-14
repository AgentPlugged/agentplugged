import { EnvironmentCheckIdSchema, ErrorCode } from "@agentplugged/protocol";
import { z } from "zod";
import { invalidInput } from "../agent-activity/agent-commands.js";
import { defineCommand, fail, ok } from "../command.js";
import { AgentPluggedError } from "../errors.js";
import { readDoctorCatalog } from "./catalog.js";
import { type Diagnosis, diagnoseFailure, type Failure, FailureSchema } from "./diagnose.js";
import { isAutomatic } from "./fixes.js";
import { type DoctorItem, type DoctorReport, runDoctor } from "./report.js";
import { buildSupportReport, type SupportReport } from "./support-report.js";

/**
 * `doctor`, the creator's command: looks at the machine and returns the report. The
 * questions and the repairs are the terminal's (`apps/cli`): the engine only reads here.
 */
export const DoctorInputSchema = z.strictObject({
  only: z.array(EnvironmentCheckIdSchema).max(100).optional(),
  /** A command that failed: the report then comes with the diagnosis of the failure. */
  failure: FailureSchema.optional(),
  /** The report to attach to a request for help: nothing personal in it. */
  report: z.boolean().optional(),
});

/** The report, with the diagnosis of a failure when one was given, or the support report. */
export type DoctorResult = DoctorReport & {
  readonly diagnosis?: Diagnosis;
  readonly support?: SupportReport;
};

/** Reads what a failure points to on the machine; undefined when the machine cannot be looked at. */
async function diagnosisOf(
  context: Parameters<typeof runDoctor>[0],
  failure: Failure,
): Promise<Diagnosis | AgentPluggedError | undefined> {
  const catalog = await readDoctorCatalog(context.method);
  if (catalog instanceof AgentPluggedError) return catalog;
  return diagnoseFailure(context, catalog, failure);
}

export const doctorCommand = defineCommand<DoctorResult>({
  name: "doctor",
  async run(context, input) {
    const parsed = DoctorInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("doctor", parsed.error));
    if (parsed.data.report === true) {
      if (parsed.data.failure !== undefined || parsed.data.only !== undefined) {
        return fail(
          new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
            command: "doctor",
            field: "report",
            reason: "doctor: report: cannot be combined with failure or only",
          }),
        );
      }
      const support = await buildSupportReport(context);
      if (support instanceof AgentPluggedError) return fail(support);
      return ok({
        platform: support.system.platform,
        groups: [],
        items: [],
        counts: support.counts,
        blocking: false,
        support,
      });
    }
    const report = await runDoctor(
      context,
      parsed.data.only === undefined ? {} : { only: parsed.data.only },
    );
    if (report instanceof AgentPluggedError) return fail(report);
    if (parsed.data.failure === undefined) return ok(report);
    const diagnosis = await diagnosisOf(context, parsed.data.failure);
    if (diagnosis instanceof AgentPluggedError) return fail(diagnosis);
    return ok(diagnosis === undefined ? report : { ...report, diagnosis });
  },
});

/** Input of `check_environment`. */
export const CheckEnvironmentInputSchema = z.strictObject({
  agent: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/)
    .max(64)
    .optional(),
  /** One check; every one when absent. */
  check: EnvironmentCheckIdSchema.optional(),
  /**
   * A command that failed: its error code, exit code and the end of what it printed.
   * The engine then reads on the machine what that failure points to and answers with the cause
   * it verified apart from what it only supposes.
   */
  failure: FailureSchema.optional(),
});

/** A point of the report as an agent reads it: English, with what to do about it. */
export interface EnvironmentPoint {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail";
  readonly text: string;
  /**
   * What can be done, when the point is not fine: `request` when the engine can repair it once the
   * creator says yes (ask `request_creator_action` `environment_fix` with this check), `terminal`
   * when only the creator at a terminal can (`npx agentplugged doctor`), `steps` to follow by hand.
   */
  readonly fix?: {
    readonly how: "request" | "terminal" | "steps";
    /** The command the engine would run, exactly (for `request` and `terminal`). */
    readonly command?: string;
    readonly steps: readonly string[];
  };
}

/** The diagnosis of a failure as an agent reads it, in English. */
export interface EnvironmentDiagnosis {
  /** `found`: the machine shows a cause; `suspected`: it shows a lead that proves nothing by itself (say it is a lead); `not_found`: read, nothing explains it; `unknown`. */
  readonly cause: "found" | "suspected" | "not_found" | "unknown";
  /** The sentence to quote: the verified cause, or that none was found. */
  readonly headline: string;
  /** What the failure shows by itself. */
  readonly failure: readonly string[];
  /** Only supposed, not verified: say « I suppose », never state it as the cause. */
  readonly assumed: readonly string[];
  /** The repair, in one sentence. */
  readonly next?: string;
  readonly doctor: string;
  readonly matched: readonly string[];
}

export interface CheckEnvironmentResult {
  readonly platform: string;
  readonly blocking: boolean;
  readonly counts: DoctorReport["counts"];
  /** With a `failure`: the points read for it (the verified facts). */
  readonly points: readonly EnvironmentPoint[];
  readonly diagnosis?: EnvironmentDiagnosis;
}

function pointOf(item: DoctorItem): EnvironmentPoint {
  const fix = item.fix;
  if (fix === undefined) return { id: item.id, status: item.status, text: item.text.en };
  const how = fix.kind === "steps" ? "steps" : isAutomatic(fix) ? "request" : "terminal";
  return {
    id: item.id,
    status: item.status,
    text: item.text.en,
    fix: {
      how,
      ...(fix.kind === "run" ? { command: fix.display.split("\n").join(" && ") } : {}),
      steps: fix.steps.en,
    },
  };
}

/**
 * `check_environment`, read only: what is wrong with the machine, one point per line,
 * with the cause the engine verified. An agent reads it before it tells the creator that something
 * is missing (a tool not found, a forge not linked), and quotes it; it never says « install X » by
 * itself. A point the engine can repair is asked with `request_creator_action` `environment_fix`.
 */
export const checkEnvironmentCommand = defineCommand<CheckEnvironmentResult>({
  name: "check_environment",
  audience: "agent",
  description:
    "Read the state of the creator's machine for the product, read only, nothing written: Node, Git (installed, a repository, name and e-mail), the forge's tool (installed even outside PATH, connected), the AI tools, the keychain, Windows Hello, and the prerequisites the architecture declares. One `points` entry per check with `status` (ok, warn, fail), a sentence of the cause the engine verified, and for a point that is not fine its `fix`: `how: request` (the engine can repair it after the creator's yes: call request_creator_action with `action: {kind: environment_fix, check: <id>}`; `command` is what it will run), `terminal` (needs the creator's terminal or browser: give the steps, or tell them to run `npx agentplugged doctor`), or `steps` (do these by hand, in order). Call it when a command fails for a reason of the environment (FORGE_NOT_LINKED, a tool not found, a login missing) and quote the verified cause; never tell the creator to install or log in by yourself, and never run `gh auth`, a package manager or a login yourself. `check` limits it to one point. When a command FAILED, pass `failure` ({code}: the engine's error code, {exit_code}, {output}: the end of what it printed) instead: the engine recognises the failure, reads on the machine what it points to (PATH not yet refreshed, a port inside a range Windows reserves, Docker stopped or short of memory, Git identity, line endings, rights, a path too long, a proxy, a full disk) and (`check` is then ignored; `points`, `counts` and `blocking` are about what was read for the failure only) answers with `diagnosis`: `headline` (quote it), `points` (what the machine VERIFIED), `assumed` (only supposed: say it is a supposition, never the cause), `next` (the repair, one sentence) and `doctor`. When `cause` is `suspected` say it is a lead, not the cause; when it is `not_found` or `unknown`, say you do not know the cause; never guess one (« install X », « it is the memory »).",
  inputSchema: CheckEnvironmentInputSchema,
  async run(context, input) {
    const parsed = CheckEnvironmentInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("check_environment", parsed.error));
    if (parsed.data.failure !== undefined) {
      const diagnosis = await diagnosisOf(context, parsed.data.failure);
      if (diagnosis instanceof AgentPluggedError) return fail(diagnosis);
      if (diagnosis === undefined) {
        return fail(
          new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
            reason: "the machine cannot be looked at here",
          }),
        );
      }
      const counts = {
        ok: diagnosis.observed.filter((item) => item.status === "ok").length,
        warn: diagnosis.observed.filter((item) => item.status === "warn").length,
        fail: diagnosis.observed.filter((item) => item.status === "fail").length,
      };
      return ok({
        platform: context.environment?.platform ?? "",
        blocking: counts.fail > 0,
        counts,
        points: diagnosis.observed.map(pointOf),
        diagnosis: {
          cause: diagnosis.cause,
          headline: diagnosis.headline.en,
          failure: diagnosis.failure.map((text) => text.en),
          assumed: diagnosis.assumed.map((text) => text.en),
          ...(diagnosis.next === undefined ? {} : { next: diagnosis.next.en }),
          doctor: diagnosis.doctor.en,
          matched: diagnosis.matched,
        },
      });
    }
    const report = await runDoctor(
      context,
      parsed.data.check === undefined ? {} : { only: [parsed.data.check] },
    );
    if (report instanceof AgentPluggedError) return fail(report);
    return ok({
      platform: report.platform,
      blocking: report.blocking,
      counts: report.counts,
      points: report.items.map(pointOf),
    });
  },
});
