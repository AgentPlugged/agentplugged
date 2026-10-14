/**
 * The short path and the full path, pure. A small project goes through one `spec`
 * instead of the brief, the PRD, the UX specification and the architecture. The choice rests on
 * what the creator said of the product, never on a guess: a size, a number of users, whether it
 * touches personal data, payments or accounts, how many external services it calls and on how many
 * platforms it runs. The rule is deterministic and the same everywhere it is read: when Noah is
 * about to propose a path (`docs path`), when the spec declares its scope (`docs check`), and when
 * the engine looks for a product that outgrew its spec (`next`).
 */

/** The size the creator announced. */
export const SPEC_SIZES = ["small", "medium", "large"] as const;
export type SpecSize = (typeof SPEC_SIZES)[number];

/** What makes a product risky: the short path is never taken for it unless the creator asks. */
export const SENSITIVE_KINDS = ["personal_data", "payment", "accounts"] as const;
export type SensitiveKind = (typeof SENSITIVE_KINDS)[number];

/** What the creator described of the product, as a spec's header states it. */
export interface PathCriteria {
  readonly size: SpecSize;
  /** The users expected in the first year. */
  readonly users: number;
  readonly sensitive: readonly SensitiveKind[];
  /** External services the product calls (an API, a payment provider, an identity provider…). */
  readonly integrations: number;
  /** Platforms it runs on (web, mobile, desktop, an extension…). */
  readonly platforms: number;
  /** The creator's explicit word, when they gave one. */
  readonly asked?: "short" | "full";
}

/** The path the engine recommends. */
export type PathName = "short" | "full";

export interface PathChoice {
  readonly path: PathName;
  /** The product touches personal data, payments or accounts. */
  readonly risky: boolean;
  /** The creator's word decided it (`asked`), not the criteria. */
  readonly asked: boolean;
  /** Why, as stable codes (`sensitive:payment`, `size:large`…), most weighty first. */
  readonly reasons: readonly string[];
}

/** From this score the product calls for the full path: two mild signals, or one strong one. */
export const FULL_PATH_SCORE = 2;
/** More users than this is a mild signal; more than `CROWD_USERS`, a strong one. */
export const MANY_USERS = 10;
export const CROWD_USERS = 100;
/** A spec past these counts has outgrown the short path (active `EF-n`, stories listed). */
export const MAX_SPEC_REQUIREMENTS = 15;
export const MAX_SPEC_STORIES = 8;

/** The signals of the criteria, each with its weight: 1 is mild, 2 is enough on its own. */
function signals(criteria: PathCriteria): Array<readonly [string, number]> {
  const found: Array<readonly [string, number]> = [];
  if (criteria.size === "large") found.push(["size:large", 2]);
  if (criteria.size === "medium") found.push(["size:medium", 1]);
  if (criteria.users > CROWD_USERS) found.push(["users:crowd", 2]);
  else if (criteria.users > MANY_USERS) found.push(["users:many", 1]);
  if (criteria.integrations >= 4) found.push(["integrations:many", 2]);
  else if (criteria.integrations >= 2) found.push(["integrations:several", 1]);
  if (criteria.platforms >= 3) found.push(["platforms:many", 2]);
  else if (criteria.platforms === 2) found.push(["platforms:two", 1]);
  return found.sort((a, b) => b[1] - a[1]);
}

/**
 * The path the engine recommends for a product. The creator's explicit word comes first (the full
 * path, or the short one even for a risky product); else a risk (personal data, payments,
 * accounts) means the full path, whatever else is true; else the weight of the signals decides.
 */
export function choosePath(criteria: PathCriteria): PathChoice {
  const risky = criteria.sensitive.length > 0;
  if (criteria.asked === "full") {
    return { path: "full", risky, asked: true, reasons: ["asked:full"] };
  }
  if (criteria.asked === "short") {
    return { path: "short", risky, asked: true, reasons: ["asked:short"] };
  }
  if (risky) {
    return {
      path: "full",
      risky,
      asked: false,
      reasons: criteria.sensitive.map((kind) => `sensitive:${kind}`),
    };
  }
  const found = signals(criteria);
  const score = found.reduce((sum, [, weight]) => sum + weight, 0);
  return {
    path: score >= FULL_PATH_SCORE ? "full" : "short",
    risky,
    asked: false,
    reasons: found.map(([reason]) => reason),
  };
}

/** What a spec holds, counted. */
export interface SpecCounts {
  /** Active functional requirements (`EF-n`, not retired). */
  readonly requirements: number;
  /** Stories listed in the spec. */
  readonly stories: number;
}

/**
 * Why a product on the short path should go to the full one, as codes; empty while the short path
 * still suits it. The criteria call for the full path (unless the creator asked for the short one
 * and nothing else changed), or the spec grew past what a short document carries, or the creator
 * asked for the full path.
 */
export function outgrown(criteria: PathCriteria, counts: SpecCounts): string[] {
  const reasons: string[] = [];
  const choice = choosePath(criteria);
  if (choice.path === "full") reasons.push(...choice.reasons);
  if (counts.requirements > MAX_SPEC_REQUIREMENTS) {
    reasons.push(`requirements:${counts.requirements}`);
  }
  if (counts.stories > MAX_SPEC_STORIES) reasons.push(`stories:${counts.stories}`);
  return reasons;
}

/** What reading a scope gives: the criteria, or what is wrong with them. */
export type ScopeRead =
  | { readonly ok: true; readonly criteria: PathCriteria }
  | { readonly ok: false; readonly reason: string };

const count = (value: unknown): number | undefined => {
  const number =
    typeof value === "string" && /^\d{1,9}$/.test(value.trim()) ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number >= 0 ? number : undefined;
};

/** The sensitive kinds: a list, or a comma-separated text; `none` and an empty list mean none. */
function sensitiveOf(value: unknown): SensitiveKind[] | undefined {
  const items =
    typeof value === "string"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item !== "" && item !== "none")
      : Array.isArray(value)
        ? value.map((item) => (typeof item === "string" ? item.trim() : item))
        : undefined;
  if (items === undefined) return undefined;
  const known = items.every((item) => (SENSITIVE_KINDS as readonly unknown[]).includes(item));
  return known ? [...new Set(items as SensitiveKind[])] : undefined;
}

/**
 * The criteria from a spec's header or from the words of the command line (`size=small`…). Every
 * criterion must be stated: a risk nobody asked about is not a risk absent, so `sensitive` is
 * required too (an empty list, or `none`).
 */
export function readScope(raw: Readonly<Record<string, unknown>>): ScopeRead {
  const size = raw.size;
  if (!(SPEC_SIZES as readonly unknown[]).includes(size)) return { ok: false, reason: "size" };
  const users = count(raw.users);
  if (users === undefined) return { ok: false, reason: "users" };
  const sensitive = sensitiveOf(raw.sensitive);
  if (sensitive === undefined) return { ok: false, reason: "sensitive" };
  const integrations = count(raw.integrations);
  if (integrations === undefined) return { ok: false, reason: "integrations" };
  const platforms = count(raw.platforms);
  if (platforms === undefined) return { ok: false, reason: "platforms" };
  const asked = raw.asked;
  if (asked !== undefined && asked !== "short" && asked !== "full") {
    return { ok: false, reason: "asked" };
  }
  return {
    ok: true,
    criteria: {
      size: size as SpecSize,
      users,
      sensitive,
      integrations,
      platforms,
      ...(asked === undefined ? {} : { asked }),
    },
  };
}

/** The words of the command line (`key=value`) as a record; false when one is not a pair. */
export function scopeWords(words: readonly string[]): Record<string, string> | false {
  const record: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const word of words) {
    const at = word.indexOf("=");
    if (at <= 0 || at === word.length - 1) return false;
    record[word.slice(0, at)] = word.slice(at + 1);
  }
  return record;
}
