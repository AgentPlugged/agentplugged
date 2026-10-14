import {
  CRITIQUE_DOCUMENT_KINDS,
  type CritiqueDocumentKind,
  type CritiqueGesture,
  type CritiqueInput,
  type CritiqueStep,
  critiquePathOf,
  IDEA_VERSION,
  isCritiqueGesture,
  isHypothesisOutcome,
  type KeptObjection,
  MAX_OBJECTIONS,
  MAX_OPEN_HYPOTHESES,
  MAX_RECONCILED,
  RECONCILE_KINDS,
  SOLO_METHODS,
} from "@agentplugged/protocol";
import { blobIdsOf } from "../docs/knowledge-freshness.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { STRUCTURING_DOCUMENT_PATHS } from "../phases/phases.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { storyDoneAt } from "../sprints/sprint-rules.js";

/**
 * The critique of a deliverable, as pure rules. The engine decides what a whole
 * report is (`validateCritiqueReport`), what the creator reads (`critiqueStack`), which gestures
 * and closings it accepts, which hypotheses an arrival of evidence brings back
 * (`hypothesesDue`), and when a critique is worth offering (`critiqueOffer`). No agent decides any
 * of it, and nothing here knows a language or a tool.
 */

/** One objection as the state keeps it: its sections, and what the creator did with it. */
export interface ObjectionRecord {
  readonly n: number;
  readonly severity: KeptObjection["severity"];
  readonly claim: string;
  readonly passage: string;
  readonly proposal: string | null;
  readonly proof: string | null;
  /** `open` until the creator makes a gesture. */
  status: "open" | CritiqueGesture;
}

/** The latest critique of a document, as `state.critiques` keeps it. */
export interface CritiqueRecord {
  readonly id: string;
  readonly at: string;
  readonly document: string;
  readonly method: string;
  /** The second method of a blend. */
  readonly blend?: string;
  /** The ids of the version of the document it was made for. */
  readonly versions: readonly string[];
  readonly by: string;
  readonly objections: ObjectionRecord[];
}

/** An open hypothesis, as `state.hypotheses` keeps it: what the product follows until its proof. */
export interface HypothesisRecord {
  readonly id: string;
  readonly critique: string;
  readonly n: number;
  readonly claim: string;
  readonly document: string;
  readonly passage: string;
  /** The identifiers (`EF-n`, `ENF-n`, `AD-n`…) the passage names: where a proof brings it back. */
  readonly refs: readonly string[];
  readonly proof: string | null;
  readonly severity: KeptObjection["severity"];
  readonly since: string;
  /** When the creator last looked at it and kept it open: no earlier evidence brings it back. */
  seen: string | null;
  readonly by: string;
}

/** The documents a critique can aim at: the structuring ones. */
export function critiquable(path: string): boolean {
  return STRUCTURING_DOCUMENT_PATHS.includes(normalizedPath(path));
}

/** A path as the journal writes it: with `/`, without a leading `./`. */
export function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^(?:\.\/)+/, "");
}

function own<T>(record: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

// ---------------------------------------------------------------------------------------------
// The passage aimed at
// ---------------------------------------------------------------------------------------------

const IDENTIFIER = /(?<![\w-])(?:EF|ENF|PU|MS|AD)-[1-9]\d*(?!\d)/gi;

/** The identifiers a passage names, upper case, once each. */
export function refsOf(passage: string): string[] {
  return [...new Set((passage.match(IDENTIFIER) ?? []).map((id) => id.toUpperCase()))];
}

function plain(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** The lines of a text outside its fenced blocks: a heading or an identifier in code is no passage. */
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === undefined) fence = marker.slice(0, 3);
      else if (marker.startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence === undefined) lines.push(line);
  }
  return lines;
}

/**
 * True when the passage is in the document, outside its code blocks: every identifier it names
 * appears in the text, or, with none, its words are a run of the words of a heading (the passage
 * may shorten a heading, never extend it).
 */
export function passageFound(text: string, passage: string): boolean {
  const lines = proseLines(text);
  const refs = refsOf(passage);
  if (refs.length > 0) {
    return refs.every((id) =>
      lines.some((line) => new RegExp(`(?<![\\w-])${id}(?!\\d)`, "i").test(line)),
    );
  }
  const wanted = plain(passage);
  if (wanted.length < 3) return false;
  return lines.some((line) => {
    const heading = /^ {0,3}#{1,6}\s+(.+)$/.exec(line)?.[1];
    return heading !== undefined && ` ${plain(heading)} `.includes(` ${wanted} `);
  });
}

/** The ids a document version is known by (Git blob, SHA-1 and SHA-256, as written and in LF). */
export function versionsOf(text: string): string[] {
  return [...new Set(blobIdsOf(text))];
}

// ---------------------------------------------------------------------------------------------
// What a whole report is
// ---------------------------------------------------------------------------------------------

/** A proof or an argument shorter than this is not one: the engine asks for it again. */
const MIN_ARGUMENT = 10;

/** The fields a call may hold, by step: any other is a mistake the engine names. */
const FIELDS: Readonly<Record<CritiqueStep, readonly string[]>> = {
  report: ["kind", "lenses", "summary", "findings"],
  propose: ["kind"],
  show: ["item"],
  settle: ["item", "items", "quote"],
  close: ["item", "items", "quote"],
};

/** The fields of a call that its step does not use, as `unexpected:<field>`. */
function strays(input: CritiqueInput, step: CritiqueStep): string[] {
  const allowed = new Set(["agent", ...FIELDS[step]]);
  return Object.entries(input)
    .filter(([field, value]) => value !== undefined && !allowed.has(field))
    .map(([field]) => `unexpected:${field}`);
}

/**
 * What is wrong with a critique report, as short codes the agent can fix. Empty when whole.
 * `text` is the document as the working copy holds it, or undefined when it cannot be read.
 */
export function validateCritiqueReport(
  input: CritiqueInput,
  text: string | undefined,
  previous?: CritiqueRecord,
): string[] {
  const problems = strays(input, "report");
  // The idea is no file: nothing to read, no passage to find, one version.
  const idea = input.kind === "idea";
  // A critique of the same version of the document still waits for the creator's gestures: a new
  // one would erase their stack (a new version of the document makes the old one obsolete).
  const waiting = previous?.objections.some((objection) => objection.status === "open") === true;
  // A reconciliation is made on a document its author just changed: it never erases a stack the
  // creator has not sorted, whatever the version.
  if (
    previous !== undefined &&
    waiting &&
    (idea ||
      input.lenses?.includes("reconcile") === true ||
      (text !== undefined &&
        versionsOf(text).some((version) => previous.versions.includes(version))))
  ) {
    problems.push(`critique_unsorted:${previous.id}`);
  }
  if (input.kind === undefined) problems.push("kind_missing");
  else if (text === undefined && !idea) problems.push("document_not_found");
  const methods = input.lenses ?? [];
  if (methods.length === 0) problems.push("method_missing");
  else problems.push(...methodProblems(methods, input.kind));
  if (input.summary === undefined) problems.push("summary_missing");
  const objections = input.findings ?? [];
  // A reconciliation says only what did not land: five findings at most.
  const cap = methods.includes("reconcile") ? MAX_RECONCILED : MAX_OBJECTIONS;
  if (objections.length > cap) {
    problems.push(`too_many_objections:${objections.length}>${cap}`);
  }
  objections.forEach((objection, index) => {
    const n = index + 1;
    if (objection.passage === undefined) problems.push(`passage_missing:${n}`);
    else if (!idea && text !== undefined && !passageFound(text, objection.passage)) {
      problems.push(`passage_unknown:${n}`);
    }
    if (objection.argument === undefined || objection.argument.length < MIN_ARGUMENT) {
      problems.push(`argument_missing:${n}`);
    }
    if (objection.severity !== "minor") {
      if (objection.proposal === undefined) problems.push(`proposal_missing:${n}`);
      if (objection.proof === undefined) problems.push(`proof_missing:${n}`);
    }
  });
  return problems;
}

/**
 * What is wrong with the methods of a report: one, or two different ones to blend;
 * the test of an idea and the reconciliation of the creator's inputs stand alone, and the latter
 * is made on the PRD, the UX specification or the architecture.
 */
function methodProblems(methods: readonly string[], kind: string | undefined): string[] {
  const problems: string[] = [];
  if (new Set(methods).size !== methods.length) problems.push("method_repeated");
  if (
    methods.length > 1 &&
    methods.some((method) => SOLO_METHODS.some((solo) => solo === method))
  ) {
    problems.push("method_alone");
  }
  if (
    methods.includes("reconcile") &&
    kind !== undefined &&
    !RECONCILE_KINDS.some((allowed) => allowed === kind)
  ) {
    problems.push(`reconcile_kind:${kind}`);
  }
  return problems;
}

/** What is wrong with the offer of a critique: the document, once per version. */
export function validateProposal(
  input: CritiqueInput,
  text: string | undefined,
  offered: boolean,
): string[] {
  const problems = strays(input, "propose");
  if (input.kind === undefined) problems.push("kind_missing");
  else if (text === undefined && input.kind !== "idea") problems.push("document_not_found");
  else if (offered) problems.push("already_offered");
  return problems;
}

/** The report as the journal keeps it (only called on a whole one). */
export function keptObjections(input: CritiqueInput): KeptObjection[] {
  return (input.findings ?? []).map((objection) => ({
    severity: objection.severity,
    claim: objection.claim,
    passage: objection.passage ?? "",
    argument: objection.argument ?? "",
    ...(objection.proposal === undefined ? {} : { proposal: objection.proposal }),
    ...(objection.proof === undefined ? {} : { proof: objection.proof }),
  }));
}

// ---------------------------------------------------------------------------------------------
// What the creator reads
// ---------------------------------------------------------------------------------------------

const RANK = { blocking: 0, should_fix: 1, minor: 2 } as const;
const LINE_MAX = 120;

/** The stack: the graver first, one line each, `n` being the objection's number in the report. */
export function critiqueStack(
  objections: ReadonlyArray<
    Pick<KeptObjection, "severity" | "claim" | "passage"> & { readonly n?: number }
  >,
): string[] {
  return objections
    .map((objection, index) => ({ objection, n: objection.n ?? index + 1 }))
    .sort((a, b) => RANK[a.objection.severity] - RANK[b.objection.severity] || a.n - b.n)
    .map(({ objection, n }) => {
      const line = `${n}. ${objection.severity} · ${objection.passage} — ${objection.claim}`;
      return line.length <= LINE_MAX ? line : `${line.slice(0, LINE_MAX - 1)}…`;
    });
}

// ---------------------------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------------------------

/** `state.critiques`: the latest critique of each document, by id. */
export function critiquesOf(
  state: Readonly<Record<string, unknown>>,
): Record<string, CritiqueRecord> {
  return (state.critiques as Record<string, CritiqueRecord> | undefined) ?? {};
}

/** `state.hypotheses`: the open ones, by id. */
export function hypothesesOf(
  state: Readonly<Record<string, unknown>>,
): Record<string, HypothesisRecord> {
  return (state.hypotheses as Record<string, HypothesisRecord> | undefined) ?? {};
}

/** `state.critiqued`: for each document, the versions offered or criticised, the latest last. */
export function offeredVersions(state: Readonly<Record<string, unknown>>, path: string): string[] {
  return own(state.critiqued as Record<string, string[]> | undefined, normalizedPath(path)) ?? [];
}

/** True when this version of the document (one of the ids it is known by) was offered or criticised. */
export function wasOffered(
  state: Readonly<Record<string, unknown>>,
  path: string,
  versions: readonly string[],
): boolean {
  const seen = new Set(offeredVersions(state, path));
  return versions.some((version) => seen.has(version.toLowerCase()));
}

/** What a gesture call is refused for, as codes the agent can fix. Empty when accepted. */
export function validateSettle(
  input: CritiqueInput,
  critique: CritiqueRecord | undefined,
  openHypotheses: number,
): string[] {
  const problems = strays(input, "settle");
  if (critique === undefined) problems.push("critique_unknown");
  if (input.items === undefined || input.items.length === 0) problems.push("items_missing");
  if (input.quote === undefined) problems.push("quote_missing");
  const seen = new Set<number>();
  let kept = 0;
  for (const [index, decision] of (input.items ?? []).entries()) {
    if (decision.n === undefined) {
      problems.push(`n_missing:${index + 1}`);
      continue;
    }
    if (!isCritiqueGesture(decision.gesture)) {
      problems.push(`gesture_unknown:${decision.n}`);
      continue;
    }
    if (seen.has(decision.n)) problems.push(`decision_repeated:${decision.n}`);
    seen.add(decision.n);
    const objection = critique?.objections[decision.n - 1];
    if (critique !== undefined && objection === undefined) {
      problems.push(`objection_unknown:${decision.n}`);
      continue;
    }
    if (objection !== undefined && objection.status !== "open") {
      problems.push(`objection_settled:${decision.n}`);
    }
    if (decision.gesture === "discard" && decision.reason === undefined) {
      problems.push(`reason_missing:${decision.n}`);
    }
    if (decision.gesture === "hypothesis") {
      kept += 1;
      if (objection !== undefined && objection.proof === null) {
        problems.push(`proof_missing:${decision.n}`);
      }
    }
  }
  if (openHypotheses + kept > MAX_OPEN_HYPOTHESES) {
    problems.push(`hypotheses_full:${openHypotheses}+${kept}>${MAX_OPEN_HYPOTHESES}`);
  }
  return problems;
}

/** What closing a hypothesis is refused for. Empty when accepted. */
export function validateClose(
  input: CritiqueInput,
  hypothesis: HypothesisRecord | undefined,
): string[] {
  const problems = strays(input, "close");
  if (hypothesis === undefined) problems.push("hypothesis_unknown");
  const closing = input.items?.length === 1 ? input.items[0] : undefined;
  if (closing === undefined) problems.push("closing_missing");
  else {
    if (!isHypothesisOutcome(closing.gesture)) problems.push("outcome_unknown");
    if (closing.n !== undefined) problems.push("unexpected:n");
    if (closing.reason === undefined) problems.push("reason_missing");
  }
  if (input.quote === undefined) problems.push("quote_missing");
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The view: what `state` says, and what an arrival of evidence brings back
// ---------------------------------------------------------------------------------------------

const MAX_HYPOTHESES_SHOWN = 5;
const MAX_AWAITING_SHOWN = 2;
const HYPOTHESIS_LINE_MAX = 160;

/** The hypotheses and the critiques waiting for the creator's gestures; bounded. */
export interface CritiqueView {
  /** The hypotheses open, all counted. */
  readonly open: number;
  /** The first ones, the graver and the older first: `id · document — claim`. */
  readonly hypotheses: readonly string[];
  readonly more?: number;
  /** Critiques with objections the creator did not sort yet: `K-… · document · n left`. */
  readonly awaiting?: readonly string[];
}

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function shortDocument(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function byGravity(a: HypothesisRecord, b: HypothesisRecord): number {
  return (
    RANK[a.severity] - RANK[b.severity] ||
    a.since.localeCompare(b.since) ||
    a.id.localeCompare(b.id)
  );
}

/** The view of the hypotheses and of the critiques not sorted, or undefined when there is none. */
export function critiqueView(state: Readonly<Record<string, unknown>>): CritiqueView | undefined {
  const open = Object.values(hypothesesOf(state)).sort(byGravity);
  const awaiting = Object.values(critiquesOf(state))
    .map((critique) => ({
      critique,
      left: critique.objections.filter((objection) => objection.status === "open").length,
    }))
    .filter(({ left }) => left > 0)
    .sort((a, b) => b.critique.at.localeCompare(a.critique.at));
  if (open.length === 0 && awaiting.length === 0) return undefined;
  return {
    open: open.length,
    hypotheses: open
      .slice(0, MAX_HYPOTHESES_SHOWN)
      .map((h) => cut(`${h.id} · ${shortDocument(h.document)} — ${h.claim}`, HYPOTHESIS_LINE_MAX)),
    ...(open.length > MAX_HYPOTHESES_SHOWN ? { more: open.length - MAX_HYPOTHESES_SHOWN } : {}),
    ...(awaiting.length === 0
      ? {}
      : {
          awaiting: awaiting
            .slice(0, MAX_AWAITING_SHOWN)
            .map(
              ({ critique, left }) =>
                `${critique.id} · ${shortDocument(critique.document)} · ${left} left`,
            ),
        }),
  };
}

/** A hypothesis an arrival of evidence brings back. */
export interface HypothesisDue {
  readonly id: string;
  readonly claim: string;
  readonly why: string;
}

const MAX_DUE_SHOWN = 3;

/** The requirements the register holds, as `hypothesesDue` reads them. */
interface RegisterRead {
  readonly items?: Readonly<
    Record<
      string,
      {
        readonly stories: readonly string[];
        readonly proved: { readonly at: string; readonly result: string } | null;
      }
    >
  >;
}

/**
 * The open hypotheses an evidence arrived for since the creator last looked at them: a proof of a
 * requirement their passage names (the journal's `requirement.proved`, as the register keeps its
 * latest) or a story that cites it and was merged. `cites` gives, for an identifier, the stories
 * that cite it in their files (the register gives them for the non-functional ones). A hypothesis
 * stays brought back until the creator closes it or keeps it open (`still_open`), which sets the
 * date from which a new evidence counts.
 */
export function hypothesesDue(
  state: Readonly<Record<string, unknown>>,
  cites: ReadonlyMap<string, readonly string[]> = new Map(),
): { readonly due: HypothesisDue[]; readonly more: number } {
  const register = state.requirements as RegisterRead | undefined;
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const checkpoints = Object.values(
    (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  const due: HypothesisDue[] = [];
  for (const hypothesis of Object.values(hypothesesOf(state)).sort(byGravity)) {
    const from = hypothesis.seen ?? hypothesis.since;
    const reasons: string[] = [];
    // A bet of the idea or of the press release names no requirement: the first
    // story delivered after it is the time to ask whether it held.
    if (hypothesis.refs.length === 0 && isBetDocument(hypothesis.document)) {
      const first = deliveredStories(state, from)[0];
      if (first !== undefined) reasons.push(`story ${first} delivered`);
    }
    for (const ref of hypothesis.refs) {
      const item = own(register?.items, ref);
      if (item?.proved != null && item.proved.at > from) {
        reasons.push(`proof ${item.proved.result} for ${ref}`);
      }
      const covering = new Set([...(cites.get(ref) ?? []), ...(item?.stories ?? [])]);
      for (const story of [...covering].sort()) {
        const done = storyDoneAt(checkpoints, story, own(stories, story));
        if (done !== undefined && done > from) reasons.push(`story ${story} delivered (${ref})`);
      }
    }
    if (reasons.length > 0) {
      due.push({ id: hypothesis.id, claim: hypothesis.claim, why: reasons.slice(0, 2).join(", ") });
    }
  }
  return { due: due.slice(0, MAX_DUE_SHOWN), more: Math.max(0, due.length - MAX_DUE_SHOWN) };
}

// ---------------------------------------------------------------------------------------------
// When Noah offers a critique
// ---------------------------------------------------------------------------------------------

/** Why a document is worth a critique before it is validated; stable codes. */
export const CRITIQUE_RISKS = [
  "important",
  "sensitive_data",
  "security_requirements",
  // No idea tested yet, the brief not validated.
  "new_product",
] as const;
export type CritiqueRisk = (typeof CRITIQUE_RISKS)[number];

/**
 * What makes an architecture the architecture of a product with sensitive data, in English and
 * French, on a text without accents nor case: personal data, payment, credentials, health,
 * encryption, confidentiality. Narrower than the words that make a story concern security: an
 * architecture speaks of tokens and permissions all the time.
 */
const SENSITIVE_DATA =
  /\b(?:personal data|donnees personnelles|pii|gdpr|rgpd|password|mot de passe|mots de passe|payment|paiement|credit card|carte bancaire|health data|donnees de sante|medical|authenticat|authentifi|encrypt|chiffr|confidential|sensitive data|donnees sensibles|user accounts?|comptes? utilisateurs?|creation de comptes?|credentials?|identifiants|login|iban|stripe|paypal|patient)/;

/** True when a text speaks of sensitive data (the spec is read with the same words). */
export function mentionsSensitiveData(text: string): boolean {
  return SENSITIVE_DATA.test(plain(text));
}

/**
 * The risk of a document, or undefined when it does not call for one: the creator marked it
 * important (`important: true` in its header), it is an architecture whose text speaks of
 * security or sensitive data, or a PRD that holds a security requirement (`securityRequirement`,
 * read from the register of requirements by the caller).
 */
export function documentRisk(
  path: string,
  text: string,
  securityRequirement: boolean,
): CritiqueRisk | undefined {
  if (parseDocumentFile(path, text).header?.important === true) return "important";
  const name = normalizedPath(path);
  if (
    (name.endsWith("/architecture.md") || name.endsWith("/spec.md")) &&
    mentionsSensitiveData(text)
  ) {
    return "sensitive_data";
  }
  if ((name.endsWith("/prd.md") || name.endsWith("/spec.md")) && securityRequirement)
    return "security_requirements";
  return undefined;
}

/** What `next` offers: the kind of the document (the `kind` of the call), and why. Never imposed. */
export interface CritiqueOffer {
  readonly kind: CritiqueDocumentKind;
  readonly why: CritiqueRisk;
}

/**
 * The critique to offer before a document is validated: the first document cited by the point that
 * waits, of a structuring kind, at risk, whose version was neither offered nor criticised. Once per
 * version: a new version of the document is offered again, the same never is.
 */
export function critiqueOffer(
  state: Readonly<Record<string, unknown>>,
  cited: ReadonlyArray<{ readonly path: string; readonly blob_sha: string }>,
  risks: ReadonlyMap<string, CritiqueRisk | undefined>,
): CritiqueOffer | undefined {
  for (const document of cited) {
    const path = normalizedPath(document.path);
    const why = risks.get(path);
    const kind = CRITIQUE_DOCUMENT_KINDS.find((candidate) => critiquePathOf(candidate) === path);
    if (why === undefined || kind === undefined) continue;
    if (wasOffered(state, path, [document.blob_sha])) continue;
    return { kind, why };
  }
  return undefined;
}

/**
 * The test of the idea, offered once on a new product: while the brief is being
 * written or waits for the creator, and neither the idea was tested nor the offer recorded.
 */
export function ideaOffer(state: Readonly<Record<string, unknown>>): CritiqueOffer | undefined {
  return wasOffered(state, critiquePathOf("idea"), [IDEA_VERSION])
    ? undefined
    : { kind: "idea", why: "new_product" };
}

/** The critique with this id, if the state holds it. */
export function critiqueById(
  state: Readonly<Record<string, unknown>>,
  id: string | undefined,
): CritiqueRecord | undefined {
  return id === undefined ? undefined : own(critiquesOf(state), id);
}

/** The open hypothesis with this id, if the state holds it. */
export function hypothesisById(
  state: Readonly<Record<string, unknown>>,
  id: string | undefined,
): HypothesisRecord | undefined {
  return id === undefined ? undefined : own(hypothesesOf(state), id);
}

/** The latest critique of a document the state holds, if any. */
export function critiqueOfDocument(
  state: Readonly<Record<string, unknown>>,
  document: string,
): CritiqueRecord | undefined {
  const path = normalizedPath(document);
  return Object.values(critiquesOf(state)).find((critique) => critique.document === path);
}

/** What is wrong with a request to see what is left of a critique. */
export function validateShow(input: CritiqueInput, critique: CritiqueRecord | undefined): string[] {
  const problems = strays(input, "show");
  if (critique === undefined) problems.push("critique_unknown");
  return problems;
}

/** The stack of what the creator did not sort yet, the graver first, with the report's numbers. */
export function openStack(critique: CritiqueRecord): string[] {
  return critiqueStack(critique.objections.filter((objection) => objection.status === "open"));
}

const PROPOSAL_MAX = 200;

/** `n. proposal`, one line each, for the objections kept for correction among `numbers`. */
export function correctionLines(critique: CritiqueRecord, numbers: readonly number[]): string[] {
  return critique.objections
    .filter((objection) => numbers.includes(objection.n))
    .map((objection) =>
      cut(`${objection.n}. ${objection.proposal ?? objection.claim}`, PROPOSAL_MAX),
    );
}

/** The stories delivered after `from`, by id. */
export function deliveredStories(state: Readonly<Record<string, unknown>>, from: string): string[] {
  const stories = (state.stories as Record<string, StoryState> | undefined) ?? {};
  const checkpoints = Object.values(
    (state.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
  );
  const ids = new Set([
    ...Object.keys(stories),
    ...checkpoints.flatMap((checkpoint) => (checkpoint.story == null ? [] : [checkpoint.story])),
  ]);
  // The first delivered first.
  return [...ids]
    .flatMap((id) => {
      const done = storyDoneAt(checkpoints, id, own(stories, id));
      return done !== undefined && done > from ? [{ id, done }] : [];
    })
    .sort((a, b) => a.done.localeCompare(b.done) || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}

/** True when a story was delivered after `from`: only then are the stories' files worth reading. */
export function deliveredAfter(state: Readonly<Record<string, unknown>>, from: string): boolean {
  return deliveredStories(state, from).length > 0;
}

/** True for the documents whose hypotheses are bets on the product itself: the idea, the press release. */
function isBetDocument(document: string): boolean {
  return document === critiquePathOf("idea") || document === critiquePathOf("prfaq");
}
