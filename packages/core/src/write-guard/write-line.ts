import type { WriteGuardCounts } from "../projection/write-guard-reducers.js";

/**
 * One line for the review of a story: the writes the guard refused before they were
 * written, by rule, and the writes it let through in doubt. Undefined when it did nothing, so a
 * story without a refusal adds nothing to what the reviewer reads.
 */
export function writeGuardLine(counts: WriteGuardCounts | undefined): string | undefined {
  if (counts === undefined) return undefined;
  const rules = (["secret", "scope", "decision", "test"] as const).filter(
    (rule) => counts.refused[rule] > 0,
  );
  const refused = rules.map((rule) => `${counts.refused[rule]} ${rule}`);
  const total = rules.reduce((sum, rule) => sum + counts.refused[rule], 0);
  if (total === 0 && counts.doubted === 0) return undefined;
  const parts = [
    total === 0
      ? "no write refused"
      : `${total} write${total === 1 ? "" : "s"} refused before being written (${refused.join(", ")})`,
    ...(counts.doubted === 0
      ? []
      : [`${counts.doubted} let through in doubt (traced in the journal)`]),
  ];
  return `Write guard: ${parts.join("; ")}.`;
}
