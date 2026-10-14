import { z } from "zod";
import { DEFAULT_THRESHOLDS, type Thresholds } from "./eval-cases.js";

/**
 * Keeping a pass as the reference and comparing the next one to it, pure. A pass that
 * loses quality (a case that no longer passes) or costs more than the threshold allows is a
 * regression, and a regression blocks. What cannot be compared is said, never counted as a pass: a
 * cost the tool did not give is « not measured », not zero.
 */

export interface Stats {
  readonly n: number;
  readonly mean: number;
  readonly sd: number;
  readonly min: number;
  readonly max: number;
}

/** Mean, sample standard deviation, extremes. Undefined for no value. */
export function stats(values: readonly number[]): Stats | undefined {
  if (values.length === 0) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.length < 2
      ? 0
      : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return {
    n: values.length,
    mean: Math.round(mean * 100) / 100,
    sd: Math.round(Math.sqrt(variance) * 100) / 100,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

const Rate = z.number().min(0).max(1);

/** What one case came to over its runs. */
export const CaseRecordSchema = z.strictObject({
  pass_rate: Rate,
  runs: z.number().int().min(1).max(100),
  /** Mean raw tokens of the runs that were measured; null when none was. */
  tokens: z.number().min(0).nullable(),
  /** How many runs the tool gave a count for. */
  measured: z.number().int().min(0).max(100),
  usd: z.number().min(0).nullable().default(null),
  /** The models the runs used: tokens of another model are not comparable. */
  models: z.array(z.string().max(100)).max(8).default([]),
});
export type CaseRecord = z.infer<typeof CaseRecordSchema>;

/** What one query came to over its runs. */
export const QueryRecordSchema = z.strictObject({
  /** Share of the runs in which the skill was loaded. */
  fired: Rate,
  ok: z.boolean(),
});
export type QueryRecord = z.infer<typeof QueryRecordSchema>;

/** A pass of a skill's evaluations: what is kept as the reference, and what is compared to it. */
export const PassSchema = z.strictObject({
  version: z.literal(1),
  recorded_at: z.string().max(40),
  tool: z.string().max(40),
  /** Fingerprint of the skill's files when it ran. */
  digest: z.string().regex(/^[0-9a-f]{16}$/u),
  /** Fingerprint of the file of cases it ran: a case dropped or loosened shows as a change. */
  cases_digest: z
    .string()
    .regex(/^[0-9a-f]{16}$/u)
    .optional(),
  cases: z.record(z.string(), CaseRecordSchema),
  triggers: z.record(z.string(), QueryRecordSchema).default({}),
});
export type Pass = z.infer<typeof PassSchema>;

export type FindingKind =
  | "quality"
  | "cost"
  | "trigger"
  | "unmeasured"
  | "trivial"
  | "new"
  | "missing"
  | "stale"
  | "improved";

export interface Finding {
  readonly kind: FindingKind;
  /** The case id or the query id. */
  readonly id: string;
  readonly detail: string;
  /** A regression blocks. */
  readonly blocking: boolean;
}

export interface Comparison {
  /** False when anything blocks. */
  readonly ok: boolean;
  readonly findings: readonly Finding[];
}

const percent = (value: number) => `${Math.round(value * 10) / 10}%`;

/**
 * Compares a pass to the reference. `trivial` carries, by case, why a pass proves little (the bare
 * model passes it too, a weak rubric line): a warning on a case that passes, never a block.
 */
export function compare(
  reference: Pass,
  current: Pass,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
  trivial: Readonly<Record<string, readonly string[]>> = {},
  /**
   * What this pass ran: a pass of the queries alone does not miss the cases, and a pass of some
   * cases (`only`) misses no other.
   */
  ran: { readonly cases: boolean; readonly only?: readonly string[] } = { cases: true },
): Comparison {
  const findings: Finding[] = [];
  const add = (kind: FindingKind, id: string, detail: string, blocking = false) =>
    findings.push({ kind, id, detail, blocking });
  if (reference.digest !== current.digest) {
    add(
      "stale",
      "(skill)",
      "the skill changed since the reference was recorded: this pass judges the new version",
    );
  }
  if (
    reference.cases_digest !== undefined &&
    current.cases_digest !== undefined &&
    reference.cases_digest !== current.cases_digest
  ) {
    // A case dropped or a grid loosened would otherwise hide a regression: the creator accepts the
    // new cases by keeping this pass (`--record`), which is the only thing left to do about it.
    add(
      "stale",
      "(cases)",
      "the cases changed since the reference was recorded: keep this pass (--record) to accept them",
      true,
    );
  }
  for (const [id, now] of Object.entries(current.cases)) {
    const before = reference.cases[id];
    for (const reason of trivial[id] ?? []) add("trivial", id, reason);
    if (before === undefined) {
      add("new", id, `no reference yet (pass rate ${now.pass_rate}): record it once it is right`);
      continue;
    }
    if (now.pass_rate < before.pass_rate - thresholds.pass_drop - 1e-9) {
      add("quality", id, `pass rate fell from ${before.pass_rate} to ${now.pass_rate}`, true);
    } else if (now.pass_rate > before.pass_rate + 1e-9) {
      add("improved", id, `pass rate rose from ${before.pass_rate} to ${now.pass_rate}`);
    }
    const models = (record: CaseRecord) => [...record.models].sort().join(", ");
    if (before.models.length > 0 && now.models.length > 0 && models(before) !== models(now)) {
      add(
        "unmeasured",
        id,
        `recorded with ${models(before)}, now ${models(now)}: the cost is not compared`,
      );
      continue;
    }
    if (before.tokens === null || now.tokens === null) {
      if (now.tokens === null) {
        add(
          "unmeasured",
          id,
          "tokens not measured: the tool gave no count, the cost is not compared",
        );
      } else {
        add("unmeasured", id, "the reference has no count for this case: the cost is not compared");
      }
      continue;
    }
    const growth = now.tokens - before.tokens;
    const share = before.tokens === 0 ? 0 : (growth / before.tokens) * 100;
    if (share > thresholds.cost_growth_pct && growth > thresholds.cost_floor_tokens) {
      add(
        "cost",
        id,
        `${Math.round(before.tokens)} to ${Math.round(now.tokens)} tokens (+${percent(share)}, the threshold is ${thresholds.cost_growth_pct}% and ${thresholds.cost_floor_tokens} tokens)`,
        true,
      );
    } else if (-share > thresholds.cost_growth_pct && -growth > thresholds.cost_floor_tokens) {
      add(
        "improved",
        id,
        `${Math.round(before.tokens)} to ${Math.round(now.tokens)} tokens (${percent(share)})`,
      );
    }
  }
  for (const id of ran.cases ? Object.keys(reference.cases) : []) {
    if (ran.only !== undefined && !ran.only.includes(id)) continue;
    if (current.cases[id] === undefined) add("missing", id, "in the reference, not in this pass");
  }
  for (const [id, now] of Object.entries(current.triggers)) {
    const before = reference.triggers[id];
    if (before?.ok === true && !now.ok) {
      add(
        "trigger",
        id,
        `was right (fired in ${percent(before.fired * 100)} of runs), now wrong (${percent(now.fired * 100)})`,
        true,
      );
    }
  }
  const rank = (finding: Finding) => (finding.blocking ? 0 : finding.kind === "improved" ? 2 : 1);
  findings.sort((a, b) => rank(a) - rank(b));
  return { ok: !findings.some((finding) => finding.blocking), findings };
}

/**
 * The reference after a pass is kept (the creator's gesture): what the pass ran replaces what the
 * reference held for it. What it did not run stays, as long as it judged the same version of the
 * skill and the same cases; for another version it no longer says anything and goes.
 */
export function keep(reference: Pass | undefined, pass: Pass): Pass {
  if (
    reference === undefined ||
    reference.digest !== pass.digest ||
    reference.cases_digest !== pass.cases_digest
  ) {
    return pass;
  }
  return {
    ...pass,
    cases: { ...reference.cases, ...pass.cases },
    triggers: { ...reference.triggers, ...pass.triggers },
  };
}
