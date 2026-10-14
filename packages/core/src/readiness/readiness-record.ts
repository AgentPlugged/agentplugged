import type {
  FindingSeverity,
  ReadinessFindingKind,
  ReadinessVerdict,
} from "@agentplugged/protocol";

/** A judged finding as the state keeps it; `n` is its number in the report (`J<n>`). */
export interface JudgedFinding {
  readonly n: number;
  readonly severity: FindingSeverity;
  readonly kind: ReadinessFindingKind;
  readonly claim: string;
  readonly passages: readonly string[];
  readonly proposal: string | null;
  /** The agent that corrects the first document. */
  readonly owner: string;
}

/** The latest judged report, as `state.readiness.report` keeps it. */
export interface ReadinessReport {
  readonly id: string;
  readonly at: string;
  readonly by: string;
  /** The digest of the documents it was made on. */
  readonly mark: string;
  readonly stage: "breakdown" | "build";
  readonly path: "full" | "short";
  readonly verdict: ReadinessVerdict;
  readonly summary: string;
  readonly engine: {
    readonly blocking: number;
    readonly should_fix: number;
    readonly minor: number;
  };
  readonly findings: readonly JudgedFinding[];
  /** The keys of the blocking findings open then, which the creator's "go on" waives. */
  readonly waivable: readonly string[];
  /** The `decision` checkpoint a blocking verdict opened, or null. */
  readonly checkpoint: string | null;
}

/** What the creator accepted, by finding key, with their reason. */
export interface Acceptance {
  readonly reason: string;
  readonly at: string;
  readonly by: string;
}

/** `state.readiness`. */
export interface ReadinessState {
  report: ReadinessReport | null;
  accepted: Record<string, Acceptance>;
}

/** The key of a judged finding: `J<n>`; the engine's own keys never look like it. */
export function judgedKey(n: number): string {
  return `J${n}`;
}

/** True for the key of a judged finding. */
export function isJudgedKey(key: string): boolean {
  return /^J[1-9]\d*$/.test(key);
}

/** `state.readiness` of a projection's state, or undefined when no report was ever made. */
export function readinessOf(state: Readonly<Record<string, unknown>>): ReadinessState | undefined {
  const value = state.readiness;
  return typeof value === "object" && value !== null ? (value as ReadinessState) : undefined;
}
