import { sha256Hex } from "@agentplugged/crypto";
import type {
  CheckpointResolvedPayload,
  ElicitationFallbackReason,
  ProjectionState,
  StackInvalidReason,
  StackItem,
  StackPrompt,
  StackPromptItem,
  StackReplyReason,
} from "@agentplugged/protocol";
import { truncate } from "../checkpoints/checkpoint-rules.js";
import { answerable, resolutionProblem } from "../checkpoints/resolution-rules.js";
import { mergeHold } from "../ci/ci-rules.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import type { StackState } from "../projection/stack-reducers.js";
import { normalizeChatText } from "./chat-text.js";
import { type CreatorReply, canonicalJson } from "./decision-prompt.js";

/**
 * The rules of the stack to validate, pure functions: which checkpoints may be
 * stacked, what an approval of one records, what the stack shows of it, and how the creator's
 * message is read. Used by the commands (`open_stack`, `ask_stack`, `answer_stack`) and, again, by
 * the projection: what an agent could write in the journal is checked against the same rules.
 */

/**
 * The kinds of checkpoint a stack may hold (a `permission` only for an installation, below). Story
 * 3.29: the morning's single stack holds the merges, the releases and the publications too.
 */
const STACKABLE_TYPES: ReadonlySet<string> = new Set([
  "document",
  "decision",
  "story",
  "phase_end",
  "permission",
  "release",
  "publication",
]);

/**
 * The sources a stack never holds: the review loop, the fast track, the conflicts… (a
 * story's merge enters the stack, the engine merging the approved stories in the order of the graph
 * in the same write).
 */
const REFUSED_SOURCES: ReadonlySet<string> = new Set([
  "review_loop",
  "attempt_limit",
  "fast_track",
  "merge_conflict",
  "forge_unlinked",
]);

/** What approving a stacked checkpoint records: `approved`, or the recommended option chosen. */
export type StackApproval =
  | { readonly decision: "approved" }
  | { readonly decision: "option_chosen"; readonly option: string };

/**
 * The answer an approval gives a checkpoint, or undefined when it needs a choice the creator
 * has to make: a decision with options is approved by choosing its recommendation (« j'approuve »
 * to a question that carried a recommendation chooses it); without one, nothing is
 * chosen for the creator.
 */
export function stackApproval(
  checkpoint: Pick<CheckpointState, "options" | "recommendation">,
): StackApproval | undefined {
  const options = checkpoint.options ?? [];
  if (options.length === 0) return { decision: "approved" };
  const recommended = checkpoint.recommendation;
  if (recommended !== null && options.some((option) => option.id === recommended)) {
    return { decision: "option_chosen", option: recommended };
  }
  return undefined;
}

/** True for the permission checkpoint of an installation the creator validates (source `untrusted_action`, the name the journals keep). */
export function isInstallCheckpoint(
  checkpoint: Pick<CheckpointState, "type" | "source" | "request">,
): boolean {
  return (
    checkpoint.type === "permission" &&
    checkpoint.source === "untrusted_action" &&
    checkpoint.request?.action === "install_dependency"
  );
}

/**
 * Why a checkpoint cannot be in a stack at `now`, or undefined. A stack holds the open checkpoints
 * of the kinds the creator approves with a plain « yes » (a document, a decision with a
 * recommendation, a merge, the end of a phase, an installation, a release, a publication), each
 * line naming its action. A high risk or irreversible point enters the stack too, except
 * at the `strict` level (`strict`: the terminal and the creator's key); an action of the creator's
 * and a memory change keep their own presentation.
 */
export function stackProblem(
  checkpoint: CheckpointState,
  state: ProjectionState["state"],
  now: number,
  /** The level is `strict`: a high risk or irreversible point is never stacked (the terminal). */
  strict = false,
): StackInvalidReason | undefined {
  if (!answerable(checkpoint, now)) return "not_open";
  if (strict && checkpoint.risk === "high") return "high_risk";
  if (strict && checkpoint.irreversible) return "irreversible";
  if (!STACKABLE_TYPES.has(checkpoint.type)) return "type";
  if (checkpoint.type === "permission" && !isInstallCheckpoint(checkpoint)) return "type";
  if ((checkpoint.creator_action ?? null) !== null || (checkpoint.memory ?? null) !== null) {
    return "type";
  }
  // An installation is shown whole: a command whose end the creator could not read (the request
  // keeps 500 characters of it) is not stacked, it has its own presentation.
  if (isInstallCheckpoint(checkpoint) && (checkpoint.request?.detail.length ?? 0) >= 500) {
    return "cannot_approve";
  }
  if (checkpoint.source !== null && REFUSED_SOURCES.has(checkpoint.source)) return "source";
  const approval = stackApproval(checkpoint);
  if (approval === undefined) return "needs_choice";
  const problem = resolutionProblem(
    { ...checkpoint, ...mergeHold(state, checkpoint) },
    {
      decision: approval.decision,
      ...(approval.decision === "option_chosen" ? { option: approval.option } : {}),
    } as Pick<CheckpointResolvedPayload, "decision" | "option" | "note" | "waiver_until">,
    now,
  );
  return problem === undefined ? undefined : "cannot_approve";
}

/**
 * What a stack shows of a checkpoint, as one digest: its kind, title, summary, risk, documents,
 * options and recommendation, which the journal fixes once the checkpoint is open. Recorded in
 * `stack.opened`, so that what the creator approves is what the stack said.
 */
export function stackItemDigest(checkpoint: CheckpointState): string {
  return sha256Hex(
    canonicalJson({
      checkpoint: checkpoint.id,
      type: checkpoint.type,
      title: checkpoint.title,
      summary: checkpoint.summary,
      risk: checkpoint.risk,
      documents: checkpoint.documents,
      options: checkpoint.options ?? null,
      recommendation: checkpoint.recommendation,
    }),
  );
}

/** The items `stack.opened` records for these checkpoints, numbered 1, 2, 3… in this order. */
export function stackItems(checkpoints: readonly CheckpointState[]): StackItem[] {
  return checkpoints.map((checkpoint, index) => ({
    n: index + 1,
    checkpoint: checkpoint.id,
    digest: stackItemDigest(checkpoint),
  }));
}

/** The longest summary a stack shows of one point: short, the full text is one `open` away. */
const STACK_SUMMARY_LENGTH = 300;

/** The longest summary of an installation (the checkpoint's own limit): its command is read whole. */
const STACK_INSTALL_SUMMARY_LENGTH = 2000;

/** One point of the stack as a surface shows it. */
export function stackPromptItem(n: number, checkpoint: CheckpointState): StackPromptItem {
  const approval = stackApproval(checkpoint);
  const option =
    approval?.decision === "option_chosen"
      ? (checkpoint.options ?? []).find((entry) => entry.id === approval.option)
      : undefined;
  return {
    n,
    checkpoint: checkpoint.id,
    type: checkpoint.type,
    title: checkpoint.title,
    // The installation's whole command is part of the summary: it is never cut.
    summary: truncate(
      checkpoint.summary,
      isInstallCheckpoint(checkpoint) ? STACK_INSTALL_SUMMARY_LENGTH : STACK_SUMMARY_LENGTH,
    ),
    risk: checkpoint.risk,
    opened_by: checkpoint.opened_by,
    documents: checkpoint.documents.map((document) => ({ ...document })),
    recommendation:
      option === undefined ? null : { label: option.label, consequence: option.consequence },
  };
}

/** The stack to show: the points still waiting for an answer, with their original numbers. */
export function stackPrompt(
  stack: StackState,
  checkpoints: Readonly<Record<string, CheckpointState>>,
  now: number,
): StackPrompt | undefined {
  const items = stack.items
    .map((item) => ({
      item,
      checkpoint: Object.hasOwn(checkpoints, item.checkpoint)
        ? checkpoints[item.checkpoint]
        : undefined,
    }))
    .filter(
      (entry): entry is { item: StackState["items"][number]; checkpoint: CheckpointState } =>
        entry.checkpoint !== undefined &&
        entry.item.answer === null &&
        answerable(entry.checkpoint, now),
    )
    .map(({ item, checkpoint }) => stackPromptItem(item.n, checkpoint));
  return items.length === 0 ? undefined : { stack: stack.id, items };
}

/** The SHA-256 of the stack shown (`form` of `stack.answered`). */
export function stackPromptDigest(prompt: StackPrompt): string {
  return sha256Hex(canonicalJson(prompt));
}

/* ------------------------------------------------------------------------------------------ */
/* The creator's message                                                                      */
/* ------------------------------------------------------------------------------------------ */

/** What the engine read of a message: the numbers it approves, or why it is no approval. */
export type StackReply =
  | { readonly ok: true; readonly numbers: readonly number[] }
  | { readonly ok: false; readonly reason: StackReplyReason };

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  un: 1,
  une: 1,
  one: 1,
  deux: 2,
  two: 2,
  trois: 3,
  three: 3,
  quatre: 4,
  four: 4,
  cinq: 5,
  five: 5,
  six: 6,
  sept: 7,
  seven: 7,
  huit: 8,
  eight: 8,
};

/** A number as the creator writes it: digits (`3`, `#3`) or a word from one to eight. */
const NUMBER = `(?:#?\\d{1,2}|${Object.keys(WORD_NUMBERS).join("|")})`;

/** The verbs and phrases that approve (accents removed, apostrophes made blanks). */
const VERBS = [
  "j approuve",
  "je approuve",
  "approuve",
  "approuvons",
  "je valide",
  "j valide",
  "valide",
  "validons",
  "j accepte",
  "accepte",
  "ok pour",
  "oui pour",
  "d accord pour",
  "daccord pour",
  "vas y pour",
  "i approve",
  "i d approve",
  "approve",
  "i accept",
  "accept",
  "yes to",
  "ok for",
  "ok with",
];

/** What may come before the verb or after the selection: courtesy, nothing that qualifies it. */
const COURTESY_WORDS =
  "oui|ok|okay|bon|alors|donc|yes|yep|yeah|merci|thanks|thank you|please|svp|stp|s il (?:te|vous) plait|voila|ben|et bien";
const LEADING_COURTESY = new RegExp(`^(?:${COURTESY_WORDS})(?=[ ,])[\\s,]*`);
const TRAILING_COURTESY = new RegExp(`[\\s,](?:${COURTESY_WORDS})$`);

/** The nouns a count may name: « les 3 epics », « all 3 items ». */
const NOUNS =
  "(?:points?|elements?|items?|epics?|stories|story|histoires?|documents?|decisions?|installations?|demandes?|requests?|taches?|tasks?)";

/** « all », « everything » and the like, alone. */
const ALL = new RegExp(
  `^(?:tout|tous|toutes|le tout|tout ca|tout cela|all|everything|all of them|them all|all of it)(?: (?:les )?${NOUNS})?$`,
);

/** « les 3 », « tous les 3 epics », « all 3 »: the count of the whole stack. */
const COUNT = new RegExp(
  `^(?:les|tous les|toutes les|all(?: the)?|the)\\s+(${NUMBER})(?: ${NOUNS})?$`,
);

/** « all except 2, 3 »: everything but a list. */
const EXCEPT = new RegExp(
  `^(?:tout|tous|toutes|all|everything)(?: (?:les )?${NOUNS})? (?:sauf|except|excepte|hors|but not|sans) (.+)$`,
);

/** The words that mark a list of numbers (« les points 1 et 2 », « item 3 »). */
const MARKERS = /^(?:(?:le|les|la|the|points?|items?|elements?|numeros?|numbers?|n|no)\s+)+/;

function numberOf(token: string): number | undefined {
  const plain = token.replace(/^#/, "");
  if (/^\d+$/.test(plain)) return Number(plain);
  return Object.hasOwn(WORD_NUMBERS, plain) ? WORD_NUMBERS[plain] : undefined;
}

/** A list of numbers and ranges (« 1 , 2 , 4 », « 1 a 3 , 5 »), or undefined when it is anything else. */
function listOf(text: string): number[] | undefined {
  const found: number[] = [];
  const part = new RegExp(
    `^(?:(?:le|les|the|point|points|item|items)\\s+)?(${NUMBER})(?:\\s*(?:a|to|through|thru|-)\\s*(${NUMBER}))?$`,
  );
  for (const raw of text.replace(MARKERS, "").split(",")) {
    const match = part.exec(raw.trim());
    if (match === null) return undefined;
    const from = numberOf(match[1] ?? "");
    const to = match[2] === undefined ? from : numberOf(match[2]);
    if (from === undefined || to === undefined || to < from || to - from > 15) return undefined;
    for (let number = from; number <= to; number++) found.push(number);
  }
  return found.length === 0 ? undefined : found;
}

/**
 * Reads the creator's message as an approval of the points of a stack of `size` points, from a
 * closed grammar, fr and en: `[courtesy] verb selection [courtesy]`. The verbs: « j'approuve »,
 * « je valide », « j'accepte », « ok pour », « i approve »… The selection: `all` (« tout »,
 * « tous », « all », « everything »), the whole count (« les 3 »: the count must be the stack's),
 * numbers (« 1, 2 et 4 », « le 3 », « les points 1 et 2 », « 1 à 3 »), or « tout sauf 2 ».
 * Anything else is not a selection: a bare « oui » (it answers one point), a negation, a
 * reservation, a question, a word the grammar does not know. Never a guess: the agent does not
 * read the message, the engine does.
 */
export function parseStackReply(message: string, size: number): StackReply {
  const unclear = (reason: StackReplyReason): StackReply => ({ ok: false, reason });
  if (message.includes("?")) return unclear("not_a_selection");
  let text = normalizeChatText(message)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/['’]/g, " ")
    .replace(/[!.…"()]+/g, " ")
    .replace(/[:;]/g, ",")
    .replace(/\s+/g, " ")
    .trim();
  while (TRAILING_COURTESY.test(text)) text = text.replace(TRAILING_COURTESY, "");
  const longest = VERBS.slice().sort((a, b) => b.length - a.length);
  let verb: string | undefined;
  for (;;) {
    verb = longest.find((candidate) => text.startsWith(`${candidate} `));
    if (verb !== undefined) break;
    const lead = LEADING_COURTESY.exec(text);
    if (lead === null) return unclear("not_a_selection");
    text = text.slice(lead[0].length);
  }
  const rest = text
    .slice(verb.length)
    .replace(/\b(?:et|and|puis|then|plus)\b|[&+]/g, ",")
    .replace(/\s*(?:,\s*)+/g, " , ")
    .replace(/^[\s,]+|[\s,]+$/g, "")
    .replace(/\s+/g, " ");
  if (rest === "") return unclear("not_a_selection");
  const all = Array.from({ length: size }, (_, index) => index + 1);
  if (ALL.test(rest)) return { ok: true, numbers: all };
  const count = COUNT.exec(rest);
  if (count !== null) {
    const asked = numberOf(count[1] ?? "");
    // « les 3 » is the whole stack only when it holds 3 points; « le 3 » is the third point.
    if (asked !== undefined && !/^(?:le|la|the)\b/.test(rest)) {
      if (asked === size) return { ok: true, numbers: all };
      if (/^(?:les|tous les|toutes les|all)/.test(rest)) return unclear("ambiguous_count");
    }
  }
  const except = EXCEPT.exec(rest);
  if (except !== null) {
    const left = listOf(except[1] ?? "");
    if (left === undefined) return unclear("not_a_selection");
    if (left.some((number) => number < 1 || number > size)) return unclear("out_of_range");
    const kept = all.filter((number) => !left.includes(number));
    return kept.length === 0 ? unclear("not_a_selection") : { ok: true, numbers: kept };
  }
  const listed = listOf(rest);
  if (listed === undefined) return unclear("not_a_selection");
  if (listed.some((number) => number < 1 || number > size)) return unclear("out_of_range");
  return { ok: true, numbers: [...new Set(listed)].sort((a, b) => a - b) };
}

/**
 * The open stack that holds `checkpoint` and whose numbers the quote selects without this point
 *: « j'approuve 1 et 2 » cited for point 3 answers points 1 and 2, never 3. Returns
 * that stack's id, or undefined (the checkpoint is in no open stack, or the quote does not select
 * numbers of one, or selects this point). A message that selects numbers answers the points it
 * names, and those alone.
 */
export function selectionOutsideStack(
  state: ProjectionState["state"],
  checkpoint: string,
  quote: string,
): string | undefined {
  const stacks = (state.stacks as Record<string, StackState> | undefined) ?? {};
  for (const stack of Object.values(stacks)) {
    const item = stack.items.find((entry) => entry.checkpoint === checkpoint);
    if (item === undefined || item.answer !== null) continue;
    const reading = parseStackReply(quote, stack.items.length);
    // A selection that cannot be read as the stack's (« les 3 » of a stack of 4, a number it has not)
    // is still a selection of numbers: it answers none of the points one by one either.
    const selects = reading.ok
      ? !reading.numbers.includes(item.n)
      : reading.reason === "ambiguous_count" || reading.reason === "out_of_range";
    if (selects) return stack.id;
  }
  return undefined;
}

/* ------------------------------------------------------------------------------------------ */
/* The stack's form                                                                           */
/* ------------------------------------------------------------------------------------------ */

/** The field of the form that holds the box of point `n`: `point_1`, `point_2`… */
export function stackField(n: number): string {
  return `point_${n}`;
}

/**
 * The points the creator left ticked in the stack's form, or why nothing is recorded: a
 * declined, cancelled or failed form is `declined`, `cancelled`, `failed`; a form that did not
 * come back with a boolean for **every** point shown (an accepted reply that is empty, partial or
 * not boolean: a tool that fills nothing in) is `invalid`; every box unticked is `none_checked`.
 * Never a point guessed, never one the form did not show.
 */
export function readStackReply(
  prompt: StackPrompt,
  reply: CreatorReply,
): { readonly approve: number[] } | ElicitationFallbackReason {
  if (reply.action === "decline") return "declined";
  if (reply.action === "cancel") return "cancelled";
  if (reply.action === "unavailable") return "unavailable";
  if (reply.action === "tool_hook") return "tool_hook";
  if (reply.action !== "accept") return "failed";
  const approve: number[] = [];
  for (const item of prompt.items) {
    const ticked = reply.content[stackField(item.n)];
    if (typeof ticked !== "boolean") return "invalid";
    if (ticked) approve.push(item.n);
  }
  return approve.length === 0 ? "none_checked" : { approve };
}
