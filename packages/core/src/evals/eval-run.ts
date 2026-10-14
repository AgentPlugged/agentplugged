import { sha256Hex } from "@agentplugged/crypto";
import {
  type EvalCase,
  messageOf,
  type Thresholds,
  type TriggerQuery,
  weakRubricLines,
} from "./eval-cases.js";
import { type CaseRecord, type Pass, stats } from "./eval-compare.js";
import {
  graderPrompt,
  type LineVerdict,
  type Material,
  parseGrading,
  runCheck,
} from "./eval-grading.js";
import { type RunUsage, readRun } from "./eval-transcript.js";
import {
  lineLoadsSkill,
  type QuerySet,
  queryId,
  skillLoaded,
  splitQueries,
} from "./eval-triggers.js";
import type { StagedFile } from "./eval-variant.js";

/**
 * Running the evaluations with a real agent. The agent is behind a port: Claude Code
 * first, any other tool by writing its adapter. Everything else is here and tested without an
 * agent, with a fake one: what is staged, what is asked, how a run is noted, what a case came to
 * over its runs, and what a pass comes to.
 *
 * A real run costs tokens. Nothing here starts one by itself: the command that calls `evaluate`
 * is the creator's gesture, and the plan (how many runs) is known before the first one.
 */

export type { StagedFile } from "./eval-variant.js";

/** One run asked of an agent, in a clean folder. */
export interface AgentRequest {
  /** `work`: the agent does the task with its skills. `judge`: it reads and answers, with no tool. */
  readonly role: "work" | "judge";
  readonly prompt: string;
  /** Written into the clean folder before the run. */
  readonly files: readonly StagedFile[];
  readonly timeoutMs: number;
  readonly maxUsd?: number;
  readonly model?: string;
  /** No skill at all, not even one of the account's: the bare model, for the comparison. */
  readonly bare?: boolean;
  /** Stops the run as soon as this line of its transcript is written (a firing is seen, no need to go on). */
  readonly stopWhen?: (line: string) => boolean;
}

export interface AgentOutcome {
  readonly status: "done" | "stopped" | "timeout" | "failed";
  /** Why a run failed, in a few words. */
  readonly detail?: string;
  /** The transcript the tool wrote, as it wrote it. */
  readonly transcript: string;
  /** The files that exist at the end and were not there at the start, or changed. */
  readonly produced: readonly StagedFile[];
  readonly ms: number;
}

/** The port: runs one agent in a clean folder and gives back what it left. */
export interface EvalAgent {
  /** `claude-code`, `codex`… */
  readonly tool: string;
  /** Where the tool looks for skills, relative to its working folder (`.claude/skills`). */
  readonly skillDir: string;
  /** Other places a skill names itself in (`.agentplugged/skills`): the same files are staged there too. */
  readonly extraSkillDirs?: readonly string[];
  /** Whether the tool can be run here, and if not what is missing. */
  available(): Promise<{ readonly ok: boolean; readonly detail?: string }>;
  run(request: AgentRequest): Promise<AgentOutcome>;
}

/** The skill under test, as files relative to its folder. */
export interface SkillUnder {
  readonly name: string;
  readonly description: string;
  readonly files: readonly StagedFile[];
}

/** A fingerprint of the skill's files: a pass says which version of the skill it judged. */
export function digestOf(files: readonly StagedFile[]): string {
  const parts = [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((file) => `${file.path}\n${file.text}`);
  return sha256Hex(parts.join("\n\0\n")).slice(0, 16);
}

export type Mode = "quality" | "baseline" | "variant" | "trigger";

export interface Options {
  readonly mode: Mode;
  readonly runs: number;
  readonly thresholds: Thresholds;
  readonly timeoutMs: number;
  readonly maxUsd?: number;
  readonly model?: string;
  /** Only these cases (ids). */
  readonly caseIds?: readonly string[];
  /** `trigger`: only the queries of one side of the split. */
  readonly set?: QuerySet;
  /** `variant`: the other version to compare with. */
  readonly other?: readonly StagedFile[];
  /** The fingerprint of the file of cases, kept in the pass. */
  readonly casesDigest?: string;
  readonly progress?: (line: string) => void;
}

export type CaseStatus = "passed" | "failed" | "run_failed" | "grading_error";

/** One run of one case, noted. */
export interface RunResult {
  readonly status: CaseStatus;
  readonly lines: readonly LineVerdict[];
  readonly weak: ReadonlyArray<{ readonly index: number; readonly reason: string }>;
  readonly uncovered: readonly string[];
  readonly usage?: RunUsage;
  readonly judge_usage?: RunUsage;
  readonly ms: number;
  readonly error?: string;
}

/** A case over its runs, in one configuration. */
export interface CaseResult {
  readonly id: string;
  readonly runs: readonly RunResult[];
  readonly record: CaseRecord;
  /** Runs that could not be noted (the run failed, the judge's reply was unusable). */
  readonly errors: number;
  /** Lines the judge or the static lint found weak, 1-based, for this case. */
  readonly weak: readonly number[];
}

export interface QueryResult extends TriggerQuery {
  readonly id: string;
  readonly fired: number;
  readonly ok: boolean;
  readonly runs: number;
  readonly errors: number;
}

export interface Report {
  readonly mode: Mode;
  readonly tool: string;
  readonly digest: string;
  /** Configuration name (`skill`, `bare`, `variant`) to its cases. */
  readonly configs: Readonly<Record<string, readonly CaseResult[]>>;
  readonly queries: readonly QueryResult[];
  /** The pass of the skill itself: what is compared to, or kept as, the reference. */
  readonly pass: Pass;
  /** Why a pass proves little, by case. */
  readonly trivial: Readonly<Record<string, readonly string[]>>;
  /** `baseline` and `variant`: what the other configuration came to, by case. */
  readonly verdicts: ReadonlyArray<{
    readonly id: string;
    readonly versus: "bare" | "variant";
    readonly result: "wins" | "ties" | "loses" | "decoration";
    readonly detail: string;
  }>;
  /** The tokens the judge used, apart from the cases' own. */
  readonly judge_tokens: number | null;
  readonly calls: number;
}

/** The cases and the queries a run takes: those asked for (`caseIds`), one side of the split (`set`). */
export function selection(
  file: { readonly cases: readonly EvalCase[]; readonly triggers: readonly TriggerQuery[] },
  options: Pick<Options, "caseIds" | "set">,
): { cases: EvalCase[]; queries: readonly TriggerQuery[] } {
  return {
    cases: file.cases.filter(
      (entry) => options.caseIds === undefined || options.caseIds.includes(entry.id),
    ),
    queries: options.set === undefined ? file.triggers : splitQueries(file.triggers)[options.set],
  };
}

/** How many runs of the agent a plan asks, so that the creator knows before the first. */
export interface Plan {
  readonly work: number;
  readonly judge: number;
}

export function planOf(
  cases: readonly EvalCase[],
  queries: readonly TriggerQuery[],
  options: Pick<Options, "mode" | "runs">,
): Plan {
  if (options.mode === "trigger") return { work: queries.length * options.runs, judge: 0 };
  const configs = options.mode === "quality" ? 1 : 2;
  return {
    work: cases.length * configs * options.runs,
    judge: cases.filter((entry) => entry.rubric.length > 0).length * configs * options.runs,
  };
}

const skillPaths = (agent: EvalAgent, name: string, files: readonly StagedFile[]): StagedFile[] =>
  [agent.skillDir, ...(agent.extraSkillDirs ?? [])].flatMap((dir) =>
    files.map((file) => ({ path: `${dir}/${name}/${file.path}`, text: file.text })),
  );
/** What the run left: the files the case started from, as the run left them, and the ones it wrote. */
function materialOf(
  answer: string,
  calls: Material["calls"],
  fixtures: readonly StagedFile[],
  produced: readonly StagedFile[],
): Material {
  const files = new Map<string, string>();
  for (const file of [...fixtures, ...produced]) files.set(file.path, file.text);
  return { answer, files, calls };
}

/** One run of one case: the agent works, the engine checks, the judge reads the rubric. */
async function runCase(
  agent: EvalAgent,
  entry: EvalCase,
  skill: readonly StagedFile[],
  options: Options,
  bare: boolean,
): Promise<RunResult> {
  const started = Date.now();
  const fixtures = entry.files.map((file) => ({ path: file.path, text: file.text }));
  const outcome = await agent.run({
    role: "work",
    prompt: messageOf(entry),
    files: [...fixtures, ...skill],
    ...(bare ? { bare: true } : {}),
    timeoutMs: options.timeoutMs,
    ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  const fail = (error: string): RunResult => ({
    status: "run_failed",
    lines: [],
    weak: [],
    uncovered: [],
    ms: outcome.ms,
    error,
  });
  if (outcome.status === "timeout")
    return fail(`timed out after ${Math.round(options.timeoutMs / 1000)} s`);
  if (outcome.status === "failed") return fail(outcome.detail ?? "the tool failed");
  const reading = readRun(agent.tool, outcome.transcript);
  if (!reading.ok) return fail(outcome.detail ?? "the run ended without a result");
  const material = materialOf(reading.answer, reading.calls, fixtures, outcome.produced);
  const lines: LineVerdict[] = entry.checks.map((check) => runCheck(check, material));
  let weak: RunResult["weak"] = [];
  let uncovered: readonly string[] = [];
  let judgeUsage: RunUsage | undefined;
  if (entry.rubric.length > 0) {
    const judged = await agent.run({
      role: "judge",
      prompt: graderPrompt({ input: messageOf(entry), rubric: entry.rubric, material }),
      files: [],
      timeoutMs: options.timeoutMs,
      ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
      ...(options.model === undefined ? {} : { model: options.model }),
    });
    const reply = readRun(agent.tool, judged.transcript);
    judgeUsage = reply.usage;
    const grading =
      judged.status === "done"
        ? parseGrading(reply.answer, entry.rubric, material)
        : { error: judged.detail ?? judged.status };
    if ("error" in grading) {
      return {
        status: "grading_error",
        lines,
        weak: [],
        uncovered: [],
        ...(reading.usage === undefined ? {} : { usage: reading.usage }),
        ...(judgeUsage === undefined ? {} : { judge_usage: judgeUsage }),
        ms: Date.now() - started,
        error: grading.error,
      };
    }
    lines.push(...grading.lines);
    weak = grading.weak;
    uncovered = grading.uncovered;
  }
  return {
    status: lines.every((line) => line.passed) ? "passed" : "failed",
    lines,
    weak,
    uncovered,
    ...(reading.usage === undefined ? {} : { usage: reading.usage }),
    ...(judgeUsage === undefined ? {} : { judge_usage: judgeUsage }),
    ms: Date.now() - started,
  };
}

/** What a case came to over its runs. Runs that could not be noted are left out of the rate. */
export function resultOf(entry: EvalCase, runs: readonly RunResult[]): CaseResult {
  const noted = runs.filter((run) => run.status === "passed" || run.status === "failed");
  const passes = noted.filter((run) => run.status === "passed").length;
  const measured = noted.flatMap((run) => (run.usage === undefined ? [] : [run.usage]));
  const tokens = stats(measured.map((usage) => usage.total));
  const usd = measured.filter((usage) => usage.usd !== undefined);
  const weak = new Set(weakRubricLines(entry.rubric));
  for (const run of runs) for (const item of run.weak) weak.add(item.index);
  return {
    id: entry.id,
    runs,
    errors: runs.length - noted.length,
    weak: [...weak].sort((a, b) => a - b).map((index) => index + 1),
    record: {
      pass_rate: noted.length === 0 ? 0 : Math.round((passes / noted.length) * 1000) / 1000,
      runs: Math.max(1, noted.length),
      tokens: tokens === undefined ? null : Math.round(tokens.mean),
      measured: measured.length,
      models: [...new Set(measured.flatMap((usage) => usage.models))].sort().slice(0, 8),
      usd:
        usd.length === 0 || usd.length < measured.length
          ? null
          : Math.round((usd.reduce((sum, usage) => sum + (usage.usd ?? 0), 0) / usd.length) * 1e6) /
            1e6,
    },
  };
}

async function runQuery(
  agent: EvalAgent,
  skill: SkillUnder,
  entry: TriggerQuery,
  options: Options,
): Promise<QueryResult> {
  let fires = 0;
  let errors = 0;
  for (let run = 0; run < options.runs; run += 1) {
    const outcome = await agent.run({
      role: "work",
      prompt: entry.query,
      files: skillPaths(agent, skill.name, skill.files),
      timeoutMs: options.timeoutMs,
      ...(options.maxUsd === undefined ? {} : { maxUsd: options.maxUsd }),
      ...(options.model === undefined ? {} : { model: options.model }),
      stopWhen: (line) => lineLoadsSkill(line, skill.name),
    });
    if (outcome.status === "stopped") {
      // The run was cut at the call that loads the skill.
      fires += 1;
      continue;
    }
    // A run that timed out, failed or ended on an error (no credential, budget) says nothing about
    // the firing: it is not a silence.
    const reading = outcome.status === "done" ? readRun(agent.tool, outcome.transcript) : undefined;
    if (reading === undefined || !reading.ok) {
      errors += 1;
      continue;
    }
    if (skillLoaded(reading.calls, skill.name)) fires += 1;
  }
  const seen = options.runs - errors;
  const fired = seen === 0 ? 0 : Math.round((fires / seen) * 1000) / 1000;
  return {
    ...entry,
    id: queryId(entry.query),
    fired,
    ok: seen > 0 && fired > 0.5 === entry.should_trigger,
    runs: options.runs,
    errors,
  };
}

async function runConfig(
  agent: EvalAgent,
  cases: readonly EvalCase[],
  skill: readonly StagedFile[],
  name: string,
  config: string,
  options: Options,
): Promise<CaseResult[]> {
  const results: CaseResult[] = [];
  const placed = skillPaths(agent, name, skill);
  for (const entry of cases) {
    const runs: RunResult[] = [];
    for (let run = 1; run <= options.runs; run += 1) {
      options.progress?.(`${config} · ${entry.id} · run ${run}/${options.runs}`);
      runs.push(await runCase(agent, entry, placed, options, config === "bare"));
    }
    results.push(resultOf(entry, runs));
  }
  return results;
}

/**
 * Evaluates a skill: runs the cases (or the queries) with the agent and builds the pass. The
 * configurations are the skill (always), the bare model (`baseline`: the skill must beat it, or it
 * is retired, not patched) or a smaller version (`variant`: the part must change the outcome).
 */
export async function evaluate(
  agent: EvalAgent,
  skill: SkillUnder,
  file: { readonly cases: readonly EvalCase[]; readonly triggers: readonly TriggerQuery[] },
  options: Options,
): Promise<Report> {
  const { cases, queries } = selection(file, options);
  const digest = digestOf(skill.files);
  const configs: Record<string, CaseResult[]> = {};
  let results: QueryResult[] = [];
  if (options.mode === "trigger") {
    for (const entry of queries) {
      options.progress?.(`trigger · ${queryId(entry.query)}`);
      results = [...results, await runQuery(agent, skill, entry, options)];
    }
  } else {
    configs.skill = await runConfig(agent, cases, skill.files, skill.name, "skill", options);
    if (options.mode === "baseline") {
      configs.bare = await runConfig(agent, cases, [], skill.name, "bare", options);
    }
    if (options.mode === "variant") {
      configs.variant = await runConfig(
        agent,
        cases,
        options.other ?? [],
        skill.name,
        "variant",
        options,
      );
    }
  }
  const mine = configs.skill ?? [];
  const trivial: Record<string, string[]> = {};
  const verdicts: Report["verdicts"][number][] = [];
  for (const result of mine) {
    const notes: string[] = [];
    if (result.weak.length > 0) {
      notes.push(
        `rubric line${result.weak.length > 1 ? "s" : ""} ${result.weak.join(", ")} would pass a wrong output: sharpen`,
      );
    }
    const versus =
      options.mode === "baseline" ? "bare" : options.mode === "variant" ? "variant" : undefined;
    const other =
      versus === undefined
        ? undefined
        : configs[versus]?.find((candidate) => candidate.id === result.id);
    if (versus !== undefined && other !== undefined) {
      const mineRate = result.record.pass_rate;
      const otherRate = other.record.pass_rate;
      const costs =
        result.record.tokens !== null && other.record.tokens !== null
          ? `, ${result.record.tokens} tokens against ${other.record.tokens}`
          : ", tokens not compared (not measured)";
      if (mineRate > otherRate) {
        verdicts.push({
          id: result.id,
          versus,
          result: "wins",
          detail: `${mineRate} against ${otherRate}${costs}`,
        });
      } else if (mineRate < otherRate) {
        verdicts.push({
          id: result.id,
          versus,
          result: "loses",
          detail: `${mineRate} against ${otherRate}${costs}`,
        });
      } else {
        const lighter =
          other.record.tokens !== null &&
          result.record.tokens !== null &&
          other.record.tokens < result.record.tokens;
        verdicts.push({
          id: result.id,
          versus,
          result: versus === "variant" && lighter ? "decoration" : "ties",
          detail: `both ${mineRate}${costs}`,
        });
        if (mineRate > 0) {
          notes.push(
            versus === "bare"
              ? "the bare model passes it as well: this case does not show the skill earns its place"
              : "the smaller version passes it as well: this case does not show the part earns its place",
          );
        }
      }
    }
    if (notes.length > 0) trivial[result.id] = notes;
  }
  const judgeTokens = Object.values(configs)
    .flat()
    .flatMap((result) =>
      result.runs.flatMap((run) => (run.judge_usage === undefined ? [] : [run.judge_usage.total])),
    );
  const pass: Pass = {
    version: 1,
    recorded_at: new Date().toISOString(),
    tool: agent.tool,
    digest,
    ...(options.casesDigest === undefined ? {} : { cases_digest: options.casesDigest }),
    cases: Object.fromEntries(
      mine
        .filter((result) => result.errors < result.runs.length)
        .map((result) => [result.id, result.record]),
    ),
    triggers: Object.fromEntries(
      results
        .filter((query) => query.errors < query.runs)
        .map((query) => [query.id, { fired: query.fired, ok: query.ok }]),
    ),
  };
  const plan = planOf(cases, queries, options);
  return {
    mode: options.mode,
    tool: agent.tool,
    digest,
    configs,
    queries: results,
    pass,
    trivial,
    verdicts,
    judge_tokens:
      judgeTokens.length === 0 ? null : judgeTokens.reduce((sum, value) => sum + value, 0),
    calls: plan.work + plan.judge,
  };
}
