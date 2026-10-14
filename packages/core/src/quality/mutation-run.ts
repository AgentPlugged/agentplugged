import { criteriaInLine } from "@agentplugged/protocol";
import type { ProofRunner, ProofRunRequest, ProofRunResult } from "../proofs/proof-runner.js";
import { MAX_PROOF_OUTPUT_BYTES } from "../proofs/proof-runner.js";
import { isCodePath } from "../reuse/code-files.js";
import {
  applyMutation,
  describeMutation,
  type Mutation,
  proposeMutations,
  selectMutations,
} from "./mutations.js";

/**
 * The mutation check: in a throwaway copy of the story's working copy, break the code
 * the story added one small way at a time, run the tests the creator accepted, put the file back,
 * and say which breaks no test noticed. `core` knows no folder and no process: a lab (the port
 * below, `adapters-tools`) makes the copy and gives the runner that starts the command inside it.
 * The creator's folder is never reached: everything is written to the copy, a path outside the
 * project is refused, and the copy is removed at the end, whatever happened.
 */

/** A throwaway copy of a working copy, and the means to break a file of it and run the tests in it. */
export interface MutationCopy {
  /** A file of the copy (text), or undefined when it is not there or not text. */
  read(path: string): Promise<string | undefined>;
  /** Writes a file of the copy: a path inside it only. */
  write(path: string, text: string): Promise<void>;
  /** Starts a command in the copy (never outside it). */
  readonly runner: Pick<ProofRunner, "run">;
  /** Removes the copy; the folder left behind when it could not, else undefined. */
  close(): Promise<string | undefined>;
}

export type CopyOpening = { readonly copy: MutationCopy } | { readonly refused: string };

export interface MutationLab {
  /**
   * Copies the working copy `workspace` (the project's own when absent). `seconds`: the longest
   * the copy may take. Refused with a reason (`copy_too_big`, `copy_too_slow`, `not_a_working_copy`).
   */
  open(workspace: string | undefined, seconds: number): Promise<CopyOpening>;
}

/** A file of the change and the lines it added. */
export interface ChangedFile {
  readonly path: string;
  readonly added: ReadonlySet<number>;
}

/** What the check is asked: the accepted command as it will run, the files, and the bounds. */
export interface MutationPlan {
  readonly story: string;
  readonly workspace?: string;
  /** The accepted line, with the story's marks written in. */
  readonly line: string;
  readonly argv: readonly string[] | null;
  readonly cwd: string;
  /** The command's own time limit, in milliseconds. */
  readonly commandTimeoutMs: number;
  readonly files: readonly ChangedFile[];
  /** The most mutations, and the longest the whole check runs (the copy included), in seconds. */
  readonly max: number;
  readonly seconds: number;
  readonly now: () => number;
}

export type MutationOutcome = "killed" | "timeout" | "survived" | "error" | "not_run";

export interface MutationResult {
  readonly mutation: Mutation;
  readonly outcome: MutationOutcome;
  /** The criteria of the story whose tests the failing output names. */
  readonly named: readonly number[];
}

/** How the check ended. */
export type MutationStatus = "done" | "stopped" | "baseline_red" | "nothing_to_mutate" | "refused";

export interface MutationReport {
  readonly status: MutationStatus;
  /** Why it stopped, was refused, or why the tests were red before any break. */
  readonly reason?: string;
  /** The mutations found in the change, before the bound. */
  readonly proposed: number;
  readonly baselineSeconds?: number;
  readonly results: readonly MutationResult[];
  /** The copy could not be removed: where it was left. */
  readonly leftover?: string;
}

/** A path inside the project: relative, with `/`, no `..`. */
export function insideProject(path: string): boolean {
  if (path === "" || /^(?:[/\\~]|[A-Za-z]:)/.test(path) || path.includes("\\")) return false;
  return !path.split("/").some((part) => part === ".." || part === "");
}

/** The shortest time a break is given however fast the tests are. */
const MIN_RUN_MS = 10_000;
/** A break may take this many times as long as the tests did before it (a loop is stopped). */
const SLOWER_BY = 4;

const outputOf = (result: ProofRunResult) => `${result.head}\n${result.tail}`;

/** The criteria of `story` named in the output of a failing run (a runner that prints failing names). */
export function namedCriteria(story: string, output: string): number[] {
  const named = new Set<number>();
  for (const line of output.split("\n")) {
    for (const found of criteriaInLine(line)) {
      if (found.story === story) named.add(found.criterion);
    }
  }
  return [...named].sort((a, b) => a - b);
}

function request(plan: MutationPlan, timeoutMs: number): ProofRunRequest {
  return {
    line: plan.line,
    argv: plan.argv,
    cwd: plan.cwd,
    timeoutMs,
    maxOutputBytes: MAX_PROOF_OUTPUT_BYTES,
  };
}

async function started(copy: MutationCopy, asked: ProofRunRequest): Promise<ProofRunResult> {
  try {
    return await copy.runner.run(asked);
  } catch (error) {
    return {
      ended: "error",
      exit: null,
      ms: 0,
      head: "",
      tail: "",
      omitted: 0,
      detail: error instanceof Error ? error.message : "the command could not be started",
    };
  }
}

/** The mutations of the change, read from the copy's own files, bounded. */
async function proposals(
  copy: MutationCopy,
  files: readonly ChangedFile[],
): Promise<{ all: Mutation[]; texts: Map<string, string> }> {
  const all: Mutation[] = [];
  const texts = new Map<string, string>();
  for (const file of files) {
    const text = await copy.read(file.path).catch(() => undefined);
    if (text === undefined) continue;
    const found = proposeMutations(file.path, text, file.added);
    if (found.length === 0) continue;
    texts.set(file.path, text);
    all.push(...found);
  }
  return { all, texts };
}

/**
 * Runs the check. Never throws: a copy that cannot be made, tests red before any break, a time
 * limit reached are reports. The copy is removed in every case.
 */
export async function runMutationCheck(
  lab: MutationLab,
  plan: MutationPlan,
): Promise<MutationReport> {
  const files = plan.files.filter(
    (file) => insideProject(file.path) && file.added.size > 0 && isCodePath(file.path),
  );
  if (files.length === 0) return { status: "nothing_to_mutate", proposed: 0, results: [] };
  const begun = plan.now();
  const deadline = begun + plan.seconds * 1000;
  const opening = await lab.open(plan.workspace, plan.seconds).catch(
    (error: unknown): CopyOpening => ({
      refused: error instanceof Error ? error.message.slice(0, 200) : "copy_failed",
    }),
  );
  if ("refused" in opening) {
    return { status: "refused", reason: opening.refused, proposed: 0, results: [] };
  }
  const { copy } = opening;
  const results: MutationResult[] = [];
  let status: MutationStatus = "done";
  let reason: string | undefined;
  let proposed = 0;
  let baselineSeconds: number | undefined;
  try {
    const { all, texts } = await proposals(copy, files);
    proposed = all.length;
    if (all.length === 0) {
      return await ended({ status: "nothing_to_mutate", proposed, results }, copy);
    }
    const chosen = selectMutations(all, plan.max);
    // The tests as they are, before any break: red or never-ending tests prove nothing about a break.
    const baseline = await started(
      copy,
      request(plan, Math.max(1000, Math.min(plan.commandTimeoutMs, deadline - plan.now()))),
    );
    baselineSeconds = Math.round(baseline.ms / 100) / 10;
    if (baseline.ended !== "exit" || baseline.exit !== 0) {
      status = "baseline_red";
      reason =
        baseline.ended === "error"
          ? `cannot_start: ${(baseline.detail ?? "").slice(0, 120)}`
          : baseline.ended === "timeout"
            ? "the tests did not end in time before any break"
            : `the tests fail before any break (exit ${baseline.exit ?? "?"})`;
      return await ended({ status, reason, proposed, baselineSeconds, results }, copy);
    }
    const perRun = Math.min(plan.commandTimeoutMs, Math.max(MIN_RUN_MS, baseline.ms * SLOWER_BY));
    for (const [index, mutation] of chosen.entries()) {
      const remaining = deadline - plan.now();
      if (remaining <= 0) {
        status = "stopped";
        reason = "time";
        for (const left of chosen.slice(index)) {
          results.push({ mutation: left, outcome: "not_run", named: [] });
        }
        break;
      }
      const original = texts.get(mutation.path) as string;
      const broken = applyMutation(original, mutation);
      if (broken === undefined) {
        results.push({ mutation, outcome: "not_run", named: [] });
        continue;
      }
      const cut = remaining < perRun;
      let result: ProofRunResult;
      try {
        await copy.write(mutation.path, broken);
        result = await started(copy, request(plan, cut ? remaining : perRun));
      } finally {
        // Put back whatever happened; if it cannot be, nothing more is trusted.
        try {
          await copy.write(mutation.path, original);
        } catch {
          status = "stopped";
          reason = "restore_failed";
        }
      }
      if (result.ended === "timeout" && cut) {
        for (const left of chosen.slice(index)) {
          results.push({ mutation: left, outcome: "not_run", named: [] });
        }
        status = "stopped";
        reason = "time";
        break;
      }
      const outcome: MutationOutcome =
        result.ended === "error"
          ? "error"
          : result.ended === "timeout"
            ? "timeout"
            : result.exit === 0
              ? "survived"
              : "killed";
      results.push({
        mutation,
        outcome,
        named: outcome === "killed" ? namedCriteria(plan.story, outputOf(result)) : [],
      });
      if (reason === "restore_failed") {
        for (const left of chosen.slice(index + 1)) {
          results.push({ mutation: left, outcome: "not_run", named: [] });
        }
        break;
      }
      if (outcome === "error" && results.length === 1) {
        status = "stopped";
        reason = `cannot_start: ${(result.detail ?? "").slice(0, 120)}`;
        for (const left of chosen.slice(index + 1)) {
          results.push({ mutation: left, outcome: "not_run", named: [] });
        }
        break;
      }
    }
    return await ended(
      {
        status,
        ...(reason === undefined ? {} : { reason }),
        proposed,
        ...(baselineSeconds === undefined ? {} : { baselineSeconds }),
        results,
      },
      copy,
    );
  } catch (error) {
    // Anything unforeseen is a report as well, and the copy goes all the same.
    return await ended(
      {
        status: "refused",
        reason: error instanceof Error ? error.message.slice(0, 200) : "check_failed",
        proposed,
        results,
      },
      copy,
    );
  }
}

/** The report with the copy removed: where it was left when it could not be. */
async function ended(report: MutationReport, copy: MutationCopy): Promise<MutationReport> {
  const left = await copy.close().catch((): string | undefined => "unknown");
  return left === undefined ? report : { ...report, leftover: left };
}

/** The counts of a report. */
export function mutationCounts(report: MutationReport): {
  readonly ran: number;
  readonly killed: number;
  readonly survived: number;
  readonly errors: number;
} {
  let killed = 0;
  let survived = 0;
  let errors = 0;
  for (const result of report.results) {
    if (result.outcome === "killed" || result.outcome === "timeout") killed += 1;
    else if (result.outcome === "survived") survived += 1;
    else if (result.outcome === "error") errors += 1;
  }
  return { ran: killed + survived + errors, killed, survived, errors };
}

/** The mutations that survived, one line each (`file:line kind a -> b`). */
export function survivorLines(report: MutationReport): string[] {
  return report.results
    .filter((result) => result.outcome === "survived")
    .map((result) => describeMutation(result.mutation));
}
