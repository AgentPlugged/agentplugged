import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { NodeEvalAgent } from "@agentplugged/adapters-tools";
import {
  CASES_FILE,
  type CasesFile,
  compareEvalPass,
  DEFAULT_EVAL_THRESHOLDS,
  EVALS_DIR,
  type EvalAgent,
  type EvalCandidate,
  type EvalFile,
  type EvalMode,
  type EvalPass,
  type EvalReport,
  type EvalThresholds,
  evalCasesDigest,
  evalPlan,
  evalSelection,
  evalStatus,
  evaluate,
  evalWithoutPart,
  keepEvalPass,
  type LoadedEvalSkill,
  loadEvalSkill,
  type MethodSource,
  REFERENCE_FILE,
  readCases,
  readDefinitions,
  suggestEvalStarter,
} from "@agentplugged/core";
import type { Translate } from "@agentplugged/i18n";

/**
 * `agentplugged eval`: how the skills behave, measured. `check` is free (the cases
 * are valid, the words of the description call the skill where they should) and is what the normal
 * test suite and the workshop run. `run` uses a real agent, so it costs tokens: it says its plan
 * first, never starts by itself and is never part of `turbo run test`. A regression against the
 * pass kept as the reference (a case that no longer passes, a cost above the threshold) makes it
 * exit with 1.
 */

export interface EvalEnvironment {
  readonly args: readonly string[];
  /** The product's folder. */
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The method shipped with the engine, as a folder; absent when it cannot be located. */
  readonly methodDir?: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Tests give a fake agent: never the real tool. */
  readonly agent?: EvalAgent;
}

const MODES: readonly EvalMode[] = ["quality", "baseline", "variant", "trigger"];
/** The most runs of the agent one command starts unless the creator raises it: a cost, not a limit of the engine. */
const DEFAULT_MAX_CALLS = 30;
const DEFAULT_TIMEOUT_S = 300;
const DEFAULT_MAX_USD = 2;

interface Place {
  readonly files: NodeWorkspaceFiles;
  readonly dir: string;
  readonly shipped: boolean;
}

const skillFolder = (name: string) => `skills/${name}`;
const productFolder = (name: string) => `.agentplugged/skills/${name}`;

async function placeOf(
  environment: EvalEnvironment,
  name: string,
  method: boolean,
): Promise<Place | undefined> {
  const product = new NodeWorkspaceFiles(environment.root);
  const shipped =
    environment.methodDir === undefined ? undefined : new NodeWorkspaceFiles(environment.methodDir);
  if (!method && (await product.exists(`${productFolder(name)}/SKILL.md`))) {
    return { files: product, dir: productFolder(name), shipped: false };
  }
  if (shipped !== undefined && (await shipped.exists(`${skillFolder(name)}/SKILL.md`))) {
    return { files: shipped, dir: skillFolder(name), shipped: true };
  }
  return undefined;
}

/** The skills an agent chooses among: the method's and the creator's, the creator's first. */
async function candidatesOf(environment: EvalEnvironment): Promise<EvalCandidate[]> {
  const found = new Map<string, EvalCandidate>();
  const sources: Array<[MethodSource, string]> = [];
  if (environment.methodDir !== undefined) {
    sources.push([new NodeWorkspaceFiles(environment.methodDir), "skills"]);
  }
  sources.push([new NodeWorkspaceFiles(environment.root), ".agentplugged/skills"]);
  for (const [source, base] of sources) {
    const read = await readDefinitions(source, base, "skill").catch(() => []);
    if (!Array.isArray(read)) continue;
    for (const definition of read) {
      found.set(definition.name, {
        name: definition.name,
        description: (definition.frontmatter as { description: string }).description,
      });
    }
  }
  return [...found.values()];
}

/** The skills that carry cases, by name, for `check` with no name. */
async function skillsWithCases(environment: EvalEnvironment, method: boolean): Promise<string[]> {
  const names = new Set<string>();
  const sources: Array<[NodeWorkspaceFiles, string]> = [];
  if (environment.methodDir !== undefined && method) {
    sources.push([new NodeWorkspaceFiles(environment.methodDir), "skills"]);
  }
  if (!method) sources.push([new NodeWorkspaceFiles(environment.root), ".agentplugged/skills"]);
  for (const [files, base] of sources) {
    for (const path of await files.listFiles(base)) {
      const rest = path.slice(base.length + 1).split("/");
      if (rest.length === 3 && rest[1] === EVALS_DIR && rest[2] === CASES_FILE)
        names.add(rest[0] as string);
    }
  }
  return [...names].sort();
}

const tokens = (t: Translate, value: number | null) =>
  value === null
    ? t("eval.tokens.none")
    : t("eval.tokens", { tokens: value.toLocaleString("en-US").replace(/,/g, " ") });

/** `eval check [<skill>]`: free, no agent. Returns 1 when a file of cases cannot be used. */
async function check(
  environment: EvalEnvironment,
  t: Translate,
  names: readonly string[],
  method: boolean,
  json: boolean,
): Promise<number> {
  const list = names.length > 0 ? [...names] : await skillsWithCases(environment, method);
  if (list.length === 0) {
    environment.stdout(`${t("eval.check.empty")}\n`);
    return 0;
  }
  const candidates = await candidatesOf(environment);
  const summary: unknown[] = [];
  const out: string[] = [];
  let code = 0;
  for (const name of list) {
    const place = await placeOf(environment, name, method);
    if (place === undefined) {
      environment.stderr(`${t("eval.error.unknown_skill", { skill: name })}\n`);
      return 2;
    }
    const loaded = await loadEvalSkill(place.files, place.dir);
    if ("error" in loaded) {
      environment.stderr(`${loaded.error}\n`);
      return 2;
    }
    const status = evalStatus(loaded, candidates);
    const read =
      loaded.casesText === undefined
        ? undefined
        : readCases(loaded.casesText, loaded.skill.description);
    if (status.problems.length > 0) code = 1;
    summary.push({ skill: name, ...status, warnings: read?.warnings ?? [] });
    out.push(t("eval.check.skill", { skill: name, cases: status.cases, queries: status.queries }));
    if (loaded.casesText === undefined) out.push(`  ${t("eval.check.none", { skill: name })}`);
    for (const problem of read?.problems ?? []) {
      out.push(`  ${t("eval.check.problem", { field: problem.field, detail: problem.detail })}`);
    }
    for (const warning of read?.warnings ?? []) {
      out.push(`  ${t("eval.check.warning", { field: warning.field, detail: warning.detail })}`);
    }
    if (status.misrouted.length > 0) {
      out.push(
        `  ${t("eval.check.words.bad", { queries: status.misrouted.map((q) => `« ${q} »`).join(", ") })}`,
      );
    } else if (status.queries > 0 && status.problems.length === 0) {
      out.push(`  ${t("eval.check.words.ok")}`);
    }
    if (loaded.casesText !== undefined)
      out.push(`  ${t(`eval.check.reference.${status.reference}`, { skill: name })}`);
  }
  environment.stdout(json ? `${JSON.stringify(summary, null, 2)}\n` : `${out.join("\n")}\n`);
  return code;
}

/** `eval init <skill>`: the proposed cases, written once, never over a file that exists. */
async function init(
  environment: EvalEnvironment,
  t: Translate,
  name: string,
  method: boolean,
): Promise<number> {
  const place = await placeOf(environment, name, method);
  if (place === undefined) {
    environment.stderr(`${t("eval.error.unknown_skill", { skill: name })}\n`);
    return 2;
  }
  if (place.shipped && !method) {
    environment.stderr(`${t("eval.error.shipped_readonly", { skill: name })}\n`);
    return 2;
  }
  const loaded = await loadEvalSkill(place.files, place.dir);
  if ("error" in loaded) {
    environment.stderr(`${loaded.error}\n`);
    return 2;
  }
  const path = `${place.dir}/${EVALS_DIR}/${CASES_FILE}`;
  if (loaded.casesText !== undefined) {
    environment.stdout(`${t("eval.init.exists", { path })}\n`);
    return 0;
  }
  const starter = suggestEvalStarter(
    { name, description: loaded.skill.description, body: loaded.body },
    [],
    await candidatesOf(environment),
  );
  await place.files.mkdir(`${place.dir}/${EVALS_DIR}`);
  const created =
    place.files.createText === undefined
      ? false
      : await place.files.createText(path, `${starter}\n`);
  if (!created) {
    environment.stdout(`${t("eval.init.exists", { path })}\n`);
    return 0;
  }
  environment.stdout(`${t("eval.init.written", { path, skill: name })}\n`);
  return 0;
}

/** A number from an option between 0 and `max`; undefined when absent, null when it is not one. */
function positive(value: string | undefined, max: number): number | undefined | null {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= max ? number : null;
}

/** `eval run <skill>`: a real agent, a plan first, a comparison with the reference. */
async function run(
  environment: EvalEnvironment,
  t: Translate,
  values: ReturnType<typeof parse>["values"],
  name: string,
): Promise<number> {
  const method = values.method === true;
  const place = await placeOf(environment, name, method);
  if (place === undefined) {
    environment.stderr(`${t("eval.error.unknown_skill", { skill: name })}\n`);
    return 2;
  }
  const loaded = await loadEvalSkill(place.files, place.dir);
  if ("error" in loaded) {
    environment.stderr(`${loaded.error}\n`);
    return 2;
  }
  if (loaded.casesText === undefined) {
    environment.stderr(`${t("eval.check.none", { skill: name })}\n`);
    return 2;
  }
  const read = readCases(loaded.casesText, loaded.skill.description);
  if (read.file === undefined) {
    for (const problem of read.problems) {
      environment.stderr(
        `${t("eval.check.problem", { field: problem.field, detail: problem.detail })}\n`,
      );
    }
    return 2;
  }
  const file: CasesFile = read.file;
  const modes =
    (values.mode ?? []).length > 0
      ? (values.mode as string[])
      : [file.cases.length > 0 ? "quality" : "trigger"];
  if (!modes.every((mode): mode is EvalMode => (MODES as readonly string[]).includes(mode))) {
    environment.stderr(`${t("eval.error.usage")}\n`);
    return 2;
  }
  const runs = values.runs === undefined ? 1 : Number(values.runs);
  const growth = positive(values["max-cost-growth"], 500);
  const floor = positive(values["cost-floor"], 10_000_000);
  const timeout = positive(values.timeout, 3600);
  const maxUsd = positive(values["max-usd"], 1000);
  const maxCalls = positive(values["max-calls"], 10_000);
  if (
    !Number.isInteger(runs) ||
    runs < 1 ||
    runs > 10 ||
    [growth, floor, timeout, maxUsd, maxCalls].includes(null)
  ) {
    environment.stderr(`${t("eval.error.usage")}\n`);
    return 2;
  }
  if (values.set !== undefined && values.set !== "train" && values.set !== "test") {
    environment.stderr(`${t("eval.error.usage")}\n`);
    return 2;
  }
  if (values.record === true && place.shipped && !method) {
    environment.stderr(`${t("eval.error.shipped_readonly", { skill: name })}\n`);
    return 2;
  }
  const thresholds: EvalThresholds = {
    ...(file.thresholds ?? DEFAULT_EVAL_THRESHOLDS),
    ...(typeof growth === "number" ? { cost_growth_pct: growth } : {}),
    ...(typeof floor === "number" ? { cost_floor_tokens: Math.round(floor) } : {}),
  };
  let other: readonly EvalFile[] | undefined;
  if (modes.includes("variant")) {
    if (typeof values.without === "string") {
      const smaller = evalWithoutPart(loaded.skill.files, values.without);
      if (smaller === undefined) {
        environment.stderr(`${t("eval.error.no_part", { part: values.without })}\n`);
        return 2;
      }
      other = smaller.files;
    } else if (typeof values.against === "string") {
      const folder = resolve(environment.root, values.against);
      const before = await loadEvalSkill(new NodeWorkspaceFiles(dirname(folder)), basename(folder));
      if ("error" in before) {
        environment.stderr(`${before.error}\n`);
        return 2;
      }
      other = before.skill.files;
    } else {
      environment.stderr(`${t("eval.error.variant")}\n`);
      return 2;
    }
  }
  const agent = environment.agent ?? new NodeEvalAgent({ env: environment.env });
  const cases =
    typeof values.case === "string" ? values.case.split(",").map((id) => id.trim()) : undefined;
  const set = values.set === "train" || values.set === "test" ? values.set : undefined;
  const chosen = evalSelection(file, {
    ...(cases === undefined ? {} : { caseIds: cases }),
    ...(set === undefined ? {} : { set }),
  });
  const plans = modes.map((mode) => ({
    mode,
    plan: evalPlan(chosen.cases, chosen.queries, { mode: mode as EvalMode, runs }),
  }));
  const work = plans.reduce((sum, entry) => sum + entry.plan.work, 0);
  const judge = plans.reduce((sum, entry) => sum + entry.plan.judge, 0);
  environment.stdout(
    `${t("eval.run.plan", { skill: name, modes: modes.join(", "), work, judge, runs })}\n`,
  );
  if (values.plan === true) return 0;
  if (work + judge > (typeof maxCalls === "number" ? maxCalls : DEFAULT_MAX_CALLS)) {
    environment.stderr(
      `${t("eval.run.too_many", { calls: work + judge, max: typeof maxCalls === "number" ? maxCalls : DEFAULT_MAX_CALLS })}\n`,
    );
    return 2;
  }
  const available = await agent.available();
  if (!available.ok) {
    environment.stderr(`${t("eval.run.unavailable", { detail: available.detail ?? "" })}\n`);
    return 2;
  }
  environment.stdout(`${t("eval.run.isolation")}\n`);
  const reports: EvalReport[] = [];
  for (const mode of modes as EvalMode[]) {
    reports.push(
      await evaluate(agent, loaded.skill, file, {
        mode,
        runs,
        thresholds,
        timeoutMs: (typeof timeout === "number" ? timeout : DEFAULT_TIMEOUT_S) * 1000,
        maxUsd: typeof maxUsd === "number" ? maxUsd : DEFAULT_MAX_USD,
        ...(typeof values.model === "string" ? { model: values.model } : {}),
        ...(cases === undefined ? {} : { caseIds: cases }),
        ...(set === undefined ? {} : { set }),
        ...(other === undefined ? {} : { other }),
        casesDigest: evalCasesDigest(loaded.casesText ?? ""),
        progress:
          values.json === true ? () => undefined : (line) => environment.stderr(`${line}\n`),
      }),
    );
  }
  return await conclude(environment, t, {
    name,
    place,
    loaded,
    reports,
    thresholds,
    record: values.record === true,
    accept: values.accept === true,
    json: values.json === true,
    ran: {
      cases: modes.some((mode) => mode !== "trigger"),
      ...(cases === undefined ? {} : { only: cases }),
    },
  });
}

interface Conclusion {
  readonly name: string;
  readonly place: Place;
  readonly loaded: LoadedEvalSkill;
  readonly reports: readonly EvalReport[];
  readonly thresholds: EvalThresholds;
  readonly record: boolean;
  /** Keep the pass even though it regresses: the creator's decision. */
  readonly accept: boolean;
  readonly json: boolean;
  readonly ran: { readonly cases: boolean; readonly only?: readonly string[] };
}

async function conclude(
  environment: EvalEnvironment,
  t: Translate,
  c: Conclusion,
): Promise<number> {
  const out: string[] = [];
  const first = c.reports[0] as EvalReport;
  const combined: EvalPass = {
    ...first.pass,
    cases: Object.assign({}, ...c.reports.map((report) => report.pass.cases)),
    triggers: Object.assign({}, ...c.reports.map((report) => report.pass.triggers)),
  };
  const trivial: Record<string, string[]> = {};
  for (const report of c.reports) {
    for (const [id, notes] of Object.entries(report.trivial))
      trivial[id] = [...(trivial[id] ?? []), ...notes];
  }
  let incomplete = false;
  for (const report of c.reports) {
    out.push(t("eval.run.mode", { mode: report.mode }));
    for (const [config, results] of Object.entries(report.configs)) {
      for (const result of results) {
        if (result.errors > 0) {
          incomplete = true;
          const why = result.runs.find((run) => run.error !== undefined)?.error ?? "";
          out.push(
            `  ${t("eval.run.error", { config, id: result.id, errors: result.errors, runs: result.runs.length, detail: why })}`,
          );
          continue;
        }
        out.push(
          `  ${t("eval.run.case", { config, id: result.id, rate: result.record.pass_rate, runs: result.runs.length, tokens: tokens(t, result.record.tokens) })}`,
        );
        for (const run of result.runs) {
          for (const line of run.lines.filter((entry) => !entry.passed)) {
            out.push(`      ${t("eval.run.fail", { text: line.text, evidence: line.evidence })}`);
          }
        }
        for (const run of result.runs) {
          for (const gap of run.uncovered)
            out.push(`      ${t("eval.run.uncovered", { text: gap })}`);
        }
      }
    }
    for (const query of report.queries) {
      if (query.errors === query.runs) incomplete = true;
      out.push(
        `  ${t(query.ok ? "eval.run.query.ok" : "eval.run.query.wrong", { query: query.query, fired: Math.round(query.fired * 100), want: query.should_trigger ? t("eval.run.fire") : t("eval.run.quiet") })}`,
      );
    }
    for (const verdict of report.verdicts) {
      out.push(
        `  ${t(`eval.run.versus.${verdict.result}`, { id: verdict.id, versus: verdict.versus, detail: verdict.detail })}`,
      );
    }
    if (report.judge_tokens !== null)
      out.push(`  ${t("eval.run.judge", { tokens: tokens(t, report.judge_tokens) })}`);
  }
  const reference = c.loaded.reference;
  const kept = reference !== undefined && !("error" in reference) ? reference : undefined;
  let blocked = false;
  let regressed = false;
  // Nothing kept for it and it does not pass, nothing kept for a query and it goes wrong: a failure
  // of its own, as a regression is.
  const failing = Object.entries(combined.cases).filter(
    ([id, record]) => record.pass_rate < 0.5 && kept?.cases[id] === undefined,
  );
  const wrongQueries = c.reports
    .flatMap((report) => report.queries)
    .filter(
      (query) => !query.ok && query.errors < query.runs && kept?.triggers[query.id] === undefined,
    );
  if (reference !== undefined && "error" in reference) {
    out.push(t("eval.run.reference_invalid", { detail: reference.error }));
  } else if (reference === undefined) {
    out.push(t("eval.run.no_reference"));
  } else {
    const compared = compareEvalPass(reference, combined, c.thresholds, trivial, c.ran);
    out.push(t("eval.run.compared", { date: reference.recorded_at.slice(0, 10) }));
    for (const finding of compared.findings) {
      out.push(
        `  ${finding.blocking ? "!" : "-"} ${t(`eval.finding.${finding.kind}`)} ${finding.id}: ${finding.detail}`,
      );
    }
    blocked = !compared.ok;
    // Only the cases changing is settled by keeping the pass; every other block is a regression.
    regressed = compared.findings.some((finding) => finding.blocking && finding.kind !== "stale");
  }
  for (const [id] of failing) out.push(`  ! ${t("eval.run.fails_alone", { id })}`);
  for (const query of wrongQueries) {
    out.push(`  ! ${t("eval.run.query_alone", { query: query.query })}`);
  }
  const blocking = blocked || failing.length > 0 || wrongQueries.length > 0;
  if (c.record) {
    if (incomplete) {
      out.push(t("eval.run.incomplete"));
    } else if (!c.accept && (regressed || failing.length > 0 || wrongQueries.length > 0)) {
      // The pass that shows a regression does not replace the proof of it, unless the creator decides.
      out.push(t("eval.run.not_recorded"));
    } else {
      const path = `${c.place.dir}/${EVALS_DIR}/${REFERENCE_FILE}`;
      await c.place.files.mkdir(`${c.place.dir}/${EVALS_DIR}`);
      await c.place.files.writeText(
        path,
        `${JSON.stringify(keepEvalPass(kept, combined), null, 2)}\n`,
      );
      out.push(t("eval.run.recorded", { path }));
    }
  }
  // A regression is told before a run that could not be finished: it is the more useful thing to know.
  out.push(
    blocking ? t("eval.run.blocked") : incomplete ? t("eval.run.incomplete") : t("eval.run.ok"),
  );
  environment.stdout(
    c.json
      ? `${JSON.stringify({ skill: c.name, blocked: blocking, incomplete, pass: combined, reports: c.reports.map(reportJson), trivial }, null, 2)}\n`
      : `${out.join("\n")}\n`,
  );
  if (blocking) return 1;
  return incomplete ? 2 : 0;
}

/** A report as `--json` gives it: every case with its runs, the lines that failed, the tokens or `null`. */
function reportJson(report: EvalReport) {
  return {
    mode: report.mode,
    tool: report.tool,
    calls: report.calls,
    judge_tokens: report.judge_tokens,
    verdicts: report.verdicts,
    queries: report.queries,
    configs: Object.fromEntries(
      Object.entries(report.configs).map(([config, results]) => [
        config,
        results.map((result) => ({
          id: result.id,
          record: result.record,
          errors: result.errors,
          weak_lines: result.weak,
          runs: result.runs.map((run) => ({
            status: run.status,
            error: run.error ?? null,
            tokens: run.usage?.total ?? null,
            lines: run.lines,
            uncovered: run.uncovered,
          })),
        })),
      ]),
    ),
  };
}

function parse(args: readonly string[]) {
  return parseArgs({
    args: [...args],
    allowPositionals: true,
    options: {
      mode: { type: "string", multiple: true },
      case: { type: "string" },
      runs: { type: "string" },
      set: { type: "string" },
      without: { type: "string" },
      against: { type: "string" },
      record: { type: "boolean" },
      accept: { type: "boolean" },
      method: { type: "boolean" },
      plan: { type: "boolean" },
      json: { type: "boolean" },
      model: { type: "string" },
      timeout: { type: "string" },
      "max-usd": { type: "string" },
      "max-calls": { type: "string" },
      "max-cost-growth": { type: "string" },
      "cost-floor": { type: "string" },
    },
  });
}

/** Runs `agentplugged eval …` and returns its exit code: 0 ok, 1 a regression or a failure, 2 it could not run. */
export async function runEval(environment: EvalEnvironment, t: Translate): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(environment.args);
  } catch (error) {
    environment.stderr(
      `${error instanceof Error ? error.message : String(error)}\n${t("eval.error.usage")}\n`,
    );
    return 2;
  }
  const [action, ...names] = parsed.positionals;
  const method = parsed.values.method === true;
  if (action === "check")
    return await check(environment, t, names, method, parsed.values.json === true);
  if (action === "init" && names.length === 1)
    return await init(environment, t, names[0] as string, method);
  if (action === "run" && names.length === 1)
    return await run(environment, t, parsed.values, names[0] as string);
  environment.stderr(`${t("eval.error.usage")}\n`);
  return 2;
}
