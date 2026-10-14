import { sha256Hex } from "@agentplugged/crypto";
import {
  AUDIT_PILLARS,
  type AuditFinding,
  type AuditPillar,
  type AuditPillarResult,
  type GapDecision,
  MAX_AUDIT_READS,
  type ProofKind,
  type ProofOrigin,
  type ProofRequirement,
  type ProofResult,
  REGISTERED_REQUIREMENT_PATTERN,
  REQUIREMENT_PILLARS,
  type RequirementBudget,
  type RequirementEntry,
  type RequirementPillar,
  type RequirementProofState,
} from "@agentplugged/protocol";
import type { ParsedDocument } from "../docs/parse-document.js";
import { storiesOf } from "../docs/story-rules.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { proofDecisions } from "../proofs/proof-accord.js";
import { holdsDecisions } from "../spec/spec-kinds.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";
import { tracedRequirements } from "../trace/trace-rules.js";

/**
 * The register of non-functional requirements and their proofs, as pure rules. The
 * register is read from the documents (`buildRegistry`) and written to the journal as a whole
 * (`requirements.registered`); everything else here reads the projected state, so the gate of the
 * `release` point gives the same answer at every replay. Nothing here knows a language, a tool or a
 * framework: the commands a requirement is checked with are the ones the project writes in its
 * documents.
 */

/** What a run of the project's command left in the state: the short form of the event's `run`. */
export interface ProofRunRecord {
  readonly command: string;
  readonly ended: "exit" | "timeout" | "error";
  readonly exit: number | null;
  readonly ms: number;
  readonly commit: string | null;
  readonly clean: boolean | null;
}

/** A proof as the state keeps it: the latest for the requirement. */
export interface ProofRecord {
  readonly kind: ProofKind;
  readonly result: ProofResult;
  readonly source: string;
  readonly measured: number | null;
  readonly budget: RequirementBudget | null;
  readonly note: string | null;
  readonly at: string;
  readonly by: string;
  readonly event: string;
  /**
   * `engine`: the engine ran the project's command (or read the CI) itself; `reported`: an agent
   * said so. A proof recorded before that story is `reported`, unless it is a CI read.
   */
  readonly origin?: ProofOrigin;
  /** The run behind an engine proof, else null. */
  readonly run?: ProofRunRecord | null;
}

/** Who produced a proof: the engine for a run and for a CI it read itself, else an agent. */
export function proofOrigin(proof: Pick<ProofRecord, "kind" | "origin">): ProofOrigin {
  return proof.origin ?? (proof.kind === "ci" ? "engine" : "reported");
}

/** The creator's decision on a gap, as the state keeps it. */
export interface GapRecord {
  readonly decision: GapDecision;
  readonly reason: string;
  readonly version: string | null;
  readonly checkpoint: string;
  readonly at: string;
  readonly by: string;
  readonly event: string;
}

/** A requirement of the register with its latest proof and gap. */
export interface RequirementItem {
  readonly id: string;
  readonly pillar: RequirementPillar;
  readonly proof: ProofKind;
  readonly text: string;
  readonly budget: RequirementBudget | null;
  readonly commands: readonly string[];
  readonly stories: readonly string[];
  readonly digest: string;
  /** When the entry last changed: no proof from before it counts. */
  readonly since: string;
  readonly proved: ProofRecord | null;
  readonly gap: GapRecord | null;
}

/** `state.requirements`. */
export interface RequirementsState {
  readonly at: string;
  readonly items: Record<string, RequirementItem>;
}

/** The latest audit of a pillar, as the state keeps it. */
export interface AuditRecord {
  readonly at: string;
  readonly verdict: string;
  readonly findings: number;
  readonly by: string;
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Reading the documents
// ---------------------------------------------------------------------------------------------

const MAX_TEXT = 240;
const MAX_COMMAND = 200;

/** The first words that say which pillar a requirement belongs to, in English and in French. */
const PILLAR_WORDS: ReadonlyArray<readonly [RequirementPillar, RegExp]> = [
  [
    "accessibility",
    /accessib|wcag|a11y|screen.?reader|lecteur d'[ée]cran|contrast|keyboard|clavier/i,
  ],
  [
    "security",
    /secur|sécur|encrypt|chiffr|secret|vulnerab|vulnérab|owasp|privacy|confidential|rgpd|gdpr|authenticat|authentifi|permission/i,
  ],
  ["dependencies", /dependenc|dépendanc|licen[cs]e|\bcve\b|supply.?chain/i],
  [
    "performance",
    /performance|latenc|response.?time|temps de r[ée]ponse|throughput|d[ée]bit|\bp9[59]\b|\bms\b|startup|d[ée]marrage|memory|m[ée]moire|\bload\b|\bcharge\b|\bcost\b|\bco[uû]t\b|bundle|poids/i,
  ],
  [
    "reliability",
    /availab|disponib|reliab|fiab|uptime|recover|reprise|backup|sauvegarde|resilien|r[ée]silien|error.?rate|taux d'erreur|data.?loss|perte de donn|durab/i,
  ],
  ["tests", /coverage|couverture|regression|r[ée]gression|\btests?\b/i],
  [
    "interface",
    /\bui\b|\bux\b|interface|empty.?state|[ée]tat vide|loading|chargement|responsive|\bscreen\b|[ée]cran|affichage|display/i,
  ],
  [
    "maintainability",
    /maintain|maintenab|readab|lisib|document|complexit|modular|\blint|typage|typed/i,
  ],
];

/** The pillar a text says, by its words; `reliability` when none does (the register stays whole). */
export function pillarOf(text: string): RequirementPillar {
  for (const [pillar, pattern] of PILLAR_WORDS) if (pattern.test(text)) return pillar;
  return "reliability";
}

/** The part of the text after « measured by » (or its French forms), else the whole text. */
function methodOf(text: string): string {
  const match =
    /(?:measured by|verified by|checked by|mesur[ée]e? par|v[ée]rifi[ée]e? par)\s*(.*)$/i.exec(
      text,
    );
  return match?.[1] ?? text;
}

/** The backticked commands of a text, as the project wrote them. */
export function commandsOf(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{2,200})`/g)) {
    const command = (match[1] ?? "").trim();
    if (command !== "" && command.length <= MAX_COMMAND && !found.includes(command)) {
      found.push(command);
    }
    if (found.length === 4) break;
  }
  return found;
}

// A symbol is an operator only alone: never inside an arrow (`->`), a comparison chain or `=>`.
const MAX_OPERATORS =
  "(?:≤|<=|(?<![-=<>])<(?![=<>])|under|below|at most|no more than|maximum|max\\.?|moins de|au plus|inférieur à|sous)";
const MIN_OPERATORS =
  "(?:≥|>=|(?<![-=<>])>(?![=<>])|at least|no less than|minimum|min\\.?|au moins|plus de|supérieur à)";
const NUMBER = "(\\d+(?:[ \\u00a0\\u202f]\\d{3})*(?:[.,]\\d+)?)";
const UNIT = "([%\\p{L}µ/]{0,12})";

/**
 * The value of a number as written: groups of thousands separated by a space (`10 000`), a decimal
 * after a point or a comma (`1,5`, `99.9`). `1,000` could be one or a thousand, and the text does
 * not say: undefined, so that no budget is invented.
 */
function numberOf(token: string): number | undefined {
  const compact = token.replace(/[   ]/g, "");
  const decimals = /[.,](\d+)$/.exec(compact)?.[1];
  if (decimals?.length === 3 && !/^0[.,]/.test(compact)) return undefined;
  const value = Number(compact.replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The numbered bound a text states: « ≤ 200 ms », « under 2 s », « at least 99.9 % », « au moins
 * 80 % ». The unit is kept as written; the engine never converts: a measure is given in the
 * budget's unit. Undefined when the text states none, states several (one requirement, one bound:
 * split it) or writes a number that can be read two ways.
 */
export function budgetOf(text: string): RequirementBudget | undefined {
  const forms: ReadonlyArray<readonly ["max" | "min", RegExp]> = [
    ["max", new RegExp(`(?:^|[^\\w])${MAX_OPERATORS}\\s*${NUMBER}\\s*${UNIT}`, "giu")],
    ["min", new RegExp(`(?:^|[^\\w])${MIN_OPERATORS}\\s*${NUMBER}\\s*${UNIT}`, "giu")],
  ];
  const found = forms.flatMap(([op, pattern]) =>
    [...text.matchAll(pattern)].map((match) => ({ op, match })),
  );
  const only = found.length === 1 ? found[0] : undefined;
  if (only === undefined) return undefined;
  const value = numberOf(only.match[1] ?? "");
  if (value === undefined) return undefined;
  return { op: only.op, value, unit: (only.match[2] ?? "").slice(0, 16) };
}

/**
 * The proof a requirement expects, from the way it says it is checked. A measure is expected only
 * when the requirement states a budget to compare it with.
 */
export function proofOf(text: string, budget: RequirementBudget | undefined): ProofKind {
  const method = methodOf(text);
  if (/review|relecture|revue|audit manuel/i.test(method)) return "review";
  if (/\bCI\b|pipeline|int[ée]gration continue|continuous integration/.test(method)) return "ci";
  if (budget !== undefined) return "measure";
  if (/benchmark|measur|mesur|profiling|profilage|lighthouse|\bp9[59]\b/i.test(method)) {
    return "analysis";
  }
  if (/scan|audit|lint|analy[sz]|static|statique|sast/i.test(method)) return "analysis";
  return "test";
}

/** The digest a proof is made for: what the requirement says, never the stories that cite it. */
function digestOf(entry: Omit<RequirementEntry, "digest" | "stories">): string {
  return sha256Hex(
    JSON.stringify([
      entry.id,
      entry.pillar,
      entry.proof,
      entry.text,
      entry.budget ?? null,
      entry.commands,
    ]),
  ).slice(0, 12);
}

/**
 * The lines of the block an `AD-n` definition opens: its own line (the budget may be written on
 * it), then up to the next heading or definition. `line` counts from 1.
 */
function decisionBlock(raw: string, line: number): string {
  const lines = raw.split(/\r?\n/);
  const block: string[] = [lines[line - 1] ?? ""];
  for (let index = line; index < lines.length && block.length < 40; index++) {
    const current = lines[index] ?? "";
    if (/^\s{0,3}#{1,6}\s/.test(current)) break;
    if (/^\s*(?:[-*+]\s+)?(?:\*\*)?(?:EF|ENF|PU|MS|AD)-[1-9]\d*(?![\w-])/.test(current)) break;
    block.push(current);
  }
  return block.join("\n");
}

/** A line of a block that states a numbered budget, or undefined. */
function budgetLine(block: string): { text: string; budget: RequirementBudget } | undefined {
  for (const line of block.split("\n")) {
    if (!/budget|seuil|threshold|limit/i.test(line)) continue;
    const budget = budgetOf(line);
    if (budget !== undefined) {
      return {
        text: line
          .replace(/^\s*[-*+#]+\s*/, "")
          .replaceAll("**", "")
          .trim(),
        budget,
      };
    }
  }
  return undefined;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_TEXT ? flat : `${flat.slice(0, MAX_TEXT - 1)}…`;
}

/**
 * The register the documents say: every active `ENF-n` of the PRD, and every active `AD-n` of the
 * architecture whose block states a numbered budget, each with its pillar, the proof it expects,
 * its budget and the commands the project declares for it, and the stories that cite it. In the
 * order of the identifiers. `files` are the raw texts, for the blocks of the decisions.
 */
export function buildRegistry(
  documents: readonly ParsedDocument[],
  files: ReadonlyArray<{ readonly path: string; readonly text: string }>,
): RequirementEntry[] {
  const cited = new Map<string, string[]>();
  for (const [story, document] of storiesOf(documents)) {
    for (const requirement of document.story?.requirements ?? []) {
      const list = cited.get(requirement.value) ?? [];
      if (!list.includes(story)) list.push(story);
      cited.set(requirement.value, list);
    }
  }
  const entries: RequirementEntry[] = [];
  const make = (
    id: string,
    sentence: string,
    method: string,
    budget: RequirementBudget | undefined,
  ) => {
    const text = oneLine(sentence);
    const proof = proofOf(method, budget);
    const base = {
      id,
      pillar: pillarOf(sentence),
      proof,
      text,
      ...(budget === undefined ? {} : { budget }),
      commands: commandsOf(method),
    };
    entries.push({
      ...base,
      stories: [...(cited.get(id) ?? [])].sort(),
      digest: digestOf(base),
    });
  };
  for (const [id, definition] of tracedRequirements(documents)) {
    if (!id.startsWith("ENF-") || definition.retired) continue;
    make(id, definition.text, definition.text, budgetOf(definition.text));
  }
  const seen = new Set(entries.map((entry) => entry.id));
  for (const document of documents) {
    if (!holdsDecisions(document.kind?.value)) continue;
    const raw = files.find((file) => file.path === document.path)?.text;
    if (raw === undefined) continue;
    for (const definition of document.definitions) {
      if (!definition.id.startsWith("AD-") || definition.retired || seen.has(definition.id)) {
        continue;
      }
      const found = budgetLine(decisionBlock(raw, definition.line));
      if (found === undefined) continue;
      seen.add(definition.id);
      // The budget may sit on the definition's own line: its text then says it already.
      const sentence =
        definition.text === ""
          ? found.text
          : found.text.includes(definition.text)
            ? definition.text
            : `${definition.text} — ${found.text}`;
      make(definition.id, sentence, found.text, found.budget);
    }
  }
  return entries.sort((a, b) => {
    const [pa = "", na = "0"] = a.id.split("-");
    const [pb = "", nb = "0"] = b.id.split("-");
    return pa === pb ? Number(na) - Number(nb) : pa < pb ? -1 : 1;
  });
}

/** True when the register the documents say is the one the journal holds (no event to write). */
export function sameRegistry(
  entries: readonly RequirementEntry[],
  state: Readonly<Record<string, unknown>>,
): boolean {
  const held = registerOf(state);
  if (held === undefined) return entries.length === 0;
  const items = Object.values(held.items);
  return (
    items.length === entries.length &&
    entries.every((entry) => {
      const item = own(held.items, entry.id);
      return (
        item !== undefined &&
        item.digest === entry.digest &&
        item.stories.join() === entry.stories.join()
      );
    })
  );
}

// ---------------------------------------------------------------------------------------------
// Reading the state
// ---------------------------------------------------------------------------------------------

/** The register the journal holds, or undefined when none was ever written. */
export function registerOf(
  state: Readonly<Record<string, unknown>>,
): RequirementsState | undefined {
  const value = state.requirements as RequirementsState | undefined;
  return value === undefined ? undefined : value;
}

/** The stories whose merge changes the code a requirement covers. */
function coveringStories(
  state: Readonly<Record<string, unknown>>,
  item: RequirementItem,
): string[] {
  if (item.stories.length > 0) return [...item.stories];
  return Object.keys((state.stories as Record<string, StoryState> | undefined) ?? {});
}

/** True when a story the requirement covers was delivered after `at`: the proof predates the code. */
export function proofIsStale(
  state: Readonly<Record<string, unknown>>,
  item: RequirementItem,
  at: string,
): boolean {
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const checkpoints = Object.values(
    (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  const proved = Date.parse(at);
  return coveringStories(state, item).some((id) => {
    const done = storyDoneAt(checkpoints, id, own(stories, id));
    return done !== undefined && Date.parse(done) > proved;
  });
}

/**
 * Why a requirement is not proven. `reported_only`: the proof is valid but an agent reported it,
 * and the creator demands proofs the engine ran or read itself.
 */
export type GapReason = "no_proof" | "stale" | "failed" | "reported_only";

/** What the creator demands of the proofs: read once from the journal's decisions. */
export function proofDemand(state: Readonly<Record<string, unknown>>): ProofRequirement {
  return proofDecisions(state).require;
}

/** The state of a requirement: proven, failed, or without a valid proof (and why). */
export function requirementProofState(
  state: Readonly<Record<string, unknown>>,
  item: RequirementItem,
  demand: ProofRequirement = proofDemand(state),
): { readonly state: RequirementProofState; readonly why?: GapReason } {
  const proof = item.proved;
  if (proof === null || proof.at < item.since) return { state: "unproven", why: "no_proof" };
  if (proofIsStale(state, item, proof.at)) return { state: "unproven", why: "stale" };
  if (proof.result === "fail") return { state: "failed", why: "failed" };
  // A requirement that expects a review is the audit's: the demand is about commands and the CI.
  if (demand === "engine" && item.proof !== "review" && proofOrigin(proof) !== "engine") {
    return { state: "unproven", why: "reported_only" };
  }
  return { state: "proven" };
}

/**
 * True when the creator settled the gap of a requirement: accepted the risk or deferred it to a
 * version, after the evidence it answers (a failing proof recorded since reopens it). A `fix` is
 * a decision to correct: the requirement still waits for its proof.
 */
export function gapSettled(item: RequirementItem): boolean {
  const gap = item.gap;
  if (gap === null || gap.decision === "fix" || gap.at < item.since) return false;
  const proof = item.proved;
  return proof === null || proof.result !== "fail" || gap.at >= proof.at;
}

/** The requirements without a valid proof that the creator did not settle: the gaps. */
export function openGaps(
  state: Readonly<Record<string, unknown>>,
): Array<{ readonly item: RequirementItem; readonly why: GapReason }> {
  const register = registerOf(state);
  if (register === undefined) return [];
  const gaps: Array<{ item: RequirementItem; why: GapReason }> = [];
  const demand = proofDemand(state);
  for (const item of Object.values(register.items)) {
    const proof = requirementProofState(state, item, demand);
    if (proof.state === "proven" || gapSettled(item)) continue;
    gaps.push({ item, why: proof.why ?? "no_proof" });
  }
  return gaps;
}

/** The most gaps a view or a refusal names. */
export const MAX_GAPS_SHOWN = 8;

/** The register as `get_state` and `sync_requirements` show it: counts, and the gaps by id. */
export interface RequirementsView {
  readonly total: number;
  readonly proven: number;
  readonly failed: number;
  readonly unproven: number;
  /** Gaps the creator settled (risk accepted or deferred). */
  readonly settled: number;
  /**
   * Among the proven ones, those the engine ran or read itself and those an agent reported (story
   * 17.22), said once the engine has produced any; `require: engine` when the creator demands the
   * first kind at the release.
   */
  readonly engine?: number;
  readonly reported?: number;
  readonly require?: "engine";
  /** The gaps still open, `id:why:expected proof`, at most `MAX_GAPS_SHOWN`. */
  readonly gaps: readonly string[];
  readonly more?: number;
  /** The latest audit verdict of each pillar audited. */
  readonly audits?: Readonly<Record<string, string>>;
}

/** The view of the register, or undefined when none was ever written. Bounded. */
export function requirementsView(
  state: Readonly<Record<string, unknown>>,
): RequirementsView | undefined {
  const register = registerOf(state);
  if (register === undefined) return undefined;
  const items = Object.values(register.items);
  let proven = 0;
  let failed = 0;
  let unproven = 0;
  let settled = 0;
  let engine = 0;
  const demand = proofDemand(state);
  for (const item of items) {
    const proof = requirementProofState(state, item, demand);
    if (proof.state === "proven") {
      proven += 1;
      if (item.proved !== null && proofOrigin(item.proved) === "engine") engine += 1;
    } else if (gapSettled(item)) settled += 1;
    else if (proof.state === "failed") failed += 1;
    else unproven += 1;
  }
  const gaps = openGaps(state);
  const audits = Object.entries(
    (state.audits as Record<string, AuditRecord> | undefined) ?? {},
  ).map(([pillar, audit]) => [pillar, audit.verdict] as const);
  return {
    total: items.length,
    proven,
    failed,
    unproven,
    settled,
    ...(engine > 0 || demand === "engine" ? { engine, reported: proven - engine } : {}),
    ...(demand === "engine" ? { require: "engine" as const } : {}),
    gaps: gaps.slice(0, MAX_GAPS_SHOWN).map(({ item, why }) => `${item.id}:${why}:${item.proof}`),
    ...(gaps.length > MAX_GAPS_SHOWN ? { more: gaps.length - MAX_GAPS_SHOWN } : {}),
    ...(audits.length > 0 ? { audits: Object.fromEntries(audits) } : {}),
  };
}

/** The valid proofs of the register, by who produced them: the engine, or an agent that reported it. */
function provenByOrigin(state: Readonly<Record<string, unknown>>): {
  readonly engine: number;
  readonly reported: number;
} {
  let engine = 0;
  let reported = 0;
  for (const item of Object.values(registerOf(state)?.items ?? {})) {
    // Counted as valid whatever the creator demands: the difference is what the gate shows.
    if (item.proved === null || requirementProofState(state, item, "any").state !== "proven") {
      continue;
    }
    if (proofOrigin(item.proved) === "engine") engine += 1;
    else reported += 1;
  }
  return { engine, reported };
}

/** What `resolutionProblem` refuses to approve: a release with requirements to settle. */
export interface ReleaseHold {
  readonly open: number;
  readonly failed: number;
  /** The valid proofs held, by who produced them: the engine, or an agent that reported it. */
  readonly engine: number;
  readonly reported: number;
  /** The first gaps, `ENF-3:failed:no_proof`. */
  readonly requirements: string;
}

/**
 * The gate of the `release` point: present while a requirement of the register has
 * no valid proof or a failed one that the creator did not settle. Nothing when no register was
 * written, or when every requirement is proven or settled.
 */
export function releaseHold(state: Readonly<Record<string, unknown>>): ReleaseHold | undefined {
  const gaps = openGaps(state);
  if (gaps.length === 0) return undefined;
  const held = provenByOrigin(state);
  const shown = gaps.slice(0, MAX_GAPS_SHOWN).map(({ item, why }) => `${item.id}:${why}`);
  return {
    open: gaps.length,
    failed: gaps.filter(({ why }) => why === "failed").length,
    engine: held.engine,
    reported: held.reported,
    requirements:
      gaps.length > MAX_GAPS_SHOWN
        ? `${shown.join(", ")} (+${gaps.length - MAX_GAPS_SHOWN})`
        : shown.join(", "),
  };
}

// ---------------------------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------------------------

/** The result of a measure against its budget: the engine decides, never the agent. */
export function measureResult(budget: RequirementBudget, measured: number): ProofResult {
  return (budget.op === "max" ? measured <= budget.value : measured >= budget.value)
    ? "pass"
    : "fail";
}

/** Why a proof is refused (a short code), or undefined when it can be recorded. */
export function proofProblem(
  item: RequirementItem,
  proof: { kind: ProofKind; source: string; measured?: number | undefined },
  tests: ReadonlyArray<{ readonly path: string; readonly line: number }> | null,
): string | undefined {
  // A review proof is the audit's own (`submit_audit`, `verified`): never typed in by hand.
  if (proof.kind === "review") return "review_comes_from_an_audit";
  if (proof.kind === "measure" && item.budget === null) return "no_budget";
  if ((proof.kind === "analysis" || proof.kind === "measure") && item.commands.length > 0) {
    const declared = item.commands.some(
      (command) => proof.source === command || proof.source.includes(command),
    );
    if (!declared) return `command_not_declared:${item.commands.join(" | ")}`;
  }
  if (proof.kind === "test" && tests !== null) {
    const cited = tests.some((test) => proof.source.includes(test.path));
    if (!cited) return tests.length === 0 ? "no_test_cites_it" : "source_not_a_citing_test";
  }
  return undefined;
}

/**
 * Why a CI proof is refused, or undefined: the source is a story whose CI the engine read green
 * (`story.ci_reported`, not a waiver), and, when stories cite the requirement, one of them. The
 * engine decides the result from that read; the agent only names the story.
 */
export function ciProofProblem(
  state: Readonly<Record<string, unknown>>,
  item: RequirementItem,
  source: string,
): string | undefined {
  const id = source.trim();
  const story = own((state.stories as Record<string, StoryState> | undefined) ?? {}, id);
  const ci = story?.ci;
  if (ci === undefined) return "no_ci_read: the source is the story whose CI the engine read";
  if (item.stories.length > 0 && !item.stories.includes(id)) {
    return `source_not_a_covering_story:${item.stories.join(" | ")}`;
  }
  return ci.status === "pass" ? undefined : `ci_not_green:${ci.status}`;
}

// ---------------------------------------------------------------------------------------------
// The creator's decision on a gap
// ---------------------------------------------------------------------------------------------

/** The sources a checkpoint answer must come from to be the creator's own. */
const CREATOR_SOURCES: ReadonlySet<string> = new Set(["terminal", "chat", "elicitation"]);

/**
 * Why a point cannot settle the gap of `requirement` with `option`, or undefined. The same rule
 * serves the command that refuses and the reducer that would ignore a forged event: the point is a
 * `decision` the creator answered themselves with that option (never an agent, never the `auto`
 * level); it names the requirement in its title; it was opened after the requirement last changed
 * and after its latest proof (a new failure needs a new decision); and it settles one gap only.
 */
export function gapPointProblem(
  state: Readonly<Record<string, unknown>>,
  requirement: string,
  option: string,
  checkpoint: string,
): string | undefined {
  const points = (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
  const point = own(points, checkpoint);
  const resolution = point?.resolution;
  if (
    point === undefined ||
    resolution == null ||
    point.status !== "resolved" ||
    resolution.decision !== "option_chosen" ||
    resolution.option !== option ||
    !CREATOR_SOURCES.has(resolution.source)
  ) {
    return `not_a_point_the_creator_answered_with_${option}`;
  }
  if (point.type !== "decision") return "not_a_decision_point";
  const named = new RegExp(`(?<![\\w-])${requirement}(?![\\w-])`, "i");
  if (!named.test(point.title)) return `point_title_does_not_name_${requirement}`;
  const register = registerOf(state);
  const item = own(register?.items ?? {}, requirement);
  if (item === undefined) return "unknown_requirement";
  const opened = Date.parse(point.opened_at);
  if (opened < Date.parse(item.since)) return "point_older_than_the_requirement";
  if (item.proved !== null && opened < Date.parse(item.proved.at))
    return "point_older_than_the_proof";
  for (const other of Object.values(register?.items ?? {})) {
    if (other.gap?.checkpoint === checkpoint) return "point_already_used";
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The audit report
// ---------------------------------------------------------------------------------------------

/**
 * What is wrong with an audit report, as short codes the agent can fix (the engine refuses the
 * report with the whole list): a pillar reported twice; a pillar that read nothing, or more than
 * the limit; a verdict that does not fit its findings; a finding for a pillar that was not
 * audited, without its fix, a gap without a known requirement, a note that is not minor; a
 * requirement verified by a pillar that did not pass or read nothing, or one whose proof is not a
 * review (a test, an analysis or a measure is recorded with `measure.proof`); a requirement
 * verified and failed at once. `known` maps each requirement of the register to the proof it expects.
 */
export function validateAuditReport(
  report: {
    readonly results: readonly AuditPillarResult[];
    readonly findings: readonly AuditFinding[];
  },
  known: ReadonlyMap<string, ProofKind>,
): string[] {
  const problems: string[] = [];
  const audited = new Set<AuditPillar>();
  for (const result of report.results) {
    if (audited.has(result.pillar)) problems.push(`result_repeated:${result.pillar}`);
    audited.add(result.pillar);
    if (result.verdict !== "not_applicable" && result.reads.length === 0) {
      problems.push(`reads_missing:${result.pillar}`);
    }
    if (result.reads.length > MAX_AUDIT_READS) {
      problems.push(`reads_too_many:${result.pillar}:${result.reads.length}`);
    }
    if (
      (result.verified ?? []).length > 0 &&
      (result.verdict !== "pass" || result.reads.length === 0)
    ) {
      problems.push(`verified_needs_a_pass_with_reads:${result.pillar}`);
    }
    for (const id of result.verified ?? []) {
      const expected = known.get(id);
      if (expected === undefined) problems.push(`verified_unknown:${result.pillar}:${id}`);
      else if (expected !== "review") {
        problems.push(`verified_not_a_review_proof:${id}:${expected}`);
      }
    }
    const count = report.findings.filter((finding) => finding.pillar === result.pillar).length;
    if (result.verdict === "issues" && count === 0)
      problems.push(`issues_without_finding:${result.pillar}`);
    if (result.verdict !== "issues" && count > 0)
      problems.push(`finding_with_verdict:${result.pillar}`);
  }
  const failed = new Set<string>();
  report.findings.forEach((finding, index) => {
    const where = `${finding.pillar}#${index + 1}`;
    if (!audited.has(finding.pillar)) problems.push(`finding_not_audited:${where}`);
    if (finding.severity !== "minor" && finding.fix === undefined) {
      problems.push(`fix_missing:${where}`);
    }
    if (finding.action === "gap") {
      if (finding.requirement === undefined) problems.push(`requirement_missing:${where}`);
      else if (!known.has(finding.requirement)) {
        problems.push(`requirement_unknown:${where}:${finding.requirement}`);
      } else failed.add(finding.requirement);
    }
    if (finding.action === "note" && finding.severity !== "minor") {
      problems.push(`note_needs_a_minor_finding:${where}`);
    }
    if (finding.requirement !== undefined && !known.has(finding.requirement)) {
      if (finding.action !== "gap")
        problems.push(`requirement_unknown:${where}:${finding.requirement}`);
    }
  });
  for (const result of report.results) {
    for (const id of result.verified ?? []) {
      if (failed.has(id)) problems.push(`verified_and_failed:${id}`);
    }
  }
  return [...new Set(problems)];
}

/** The pillars of the register and of the audit, for the tests and the skill. */
export const PILLARS = { requirement: REQUIREMENT_PILLARS, audit: AUDIT_PILLARS } as const;

/** True for an id the register can hold. */
export function isRegisteredId(id: string): boolean {
  return REGISTERED_REQUIREMENT_PATTERN.test(id);
}
