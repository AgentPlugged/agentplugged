import { z } from "zod";
import { CARD_EFFECT_MAX, CARD_LINE_MAX, CHECKPOINT_TYPES } from "./checkpoint.js";
import { WEB_ANSWER_STALE_MS } from "./checkpoint-web.js";
import { SHORT_VERSION_MAX_CHARS } from "./publication.js";
import { isPressingPoint } from "./push.js";

/**
 * The morning briefing, composed by a product's machine and read through its bridge: the shapes
 * the request and the answer of the file reading carry (`briefing`).
 *
 * The machine knows the state of the product, so it decides what the briefing holds: which points
 * wait for the creator, in which order, with their title and their options, and what moved since
 * yesterday. No model is asked and nothing is spent. The device turns this into sentences of its
 * own catalog and into a voice of its own engine; it never invents the content, and the relay,
 * which only carries sealed bytes, never sees it.
 *
 * Every text that comes from a point (a title, an option, an agent) is untrusted content written
 * by an agent: the bridge passes it through the secret guard, and a device reads it aloud only
 * inside a sentence of its own. The device reads the answer with the tolerant reader of the file
 * reading; the request a bridge receives stays strict.
 */

/** The most points one briefing lists; the others are counted in `waiting`. */
export const BRIEFING_ITEMS_MAX = 12;
/** The most options a briefing item lists. */
export const BRIEFING_OPTIONS_MAX = 6;
/** The longest title, option label and agent name, in characters. */
export const BRIEFING_TITLE_MAX_CHARS = 120;
export const BRIEFING_LABEL_MAX_CHARS = 100;
export const BRIEFING_AGENT_MAX_CHARS = 64;
/** The longest start of a summary a listening version may be made from, in characters. */
export const BRIEFING_LISTEN_SUMMARY_MAX_CHARS = 600;
/** How far back « what moved » looks. */
export const BRIEFING_RECENT_MS = 24 * 60 * 60 * 1000;

/** The request shape (without the identifier, the version and the product, which the file reading adds). */
export const BriefingRequestFields = {
  op: z.literal("briefing"),
} as const;

const Count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

/** What the creator can do with a point from a phone: every decision, none to approve, or none at all. */
export const BRIEFING_ANSWERING = ["full", "no_approval", "elsewhere"] as const;

export const BriefingOptionSchema = z.strictObject({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(BRIEFING_LABEL_MAX_CHARS),
  recommended: z.boolean(),
});
export type BriefingOption = z.infer<typeof BriefingOptionSchema>;

/**
 * What the listening version of a point is made from: the fields its agent already wrote when it
 * opened the point (the card's effect, its first risk and its reason, a deliverable's short
 * version), as plain text, or the start of the summary when no card was written. The device turns
 * them into sentences of its own catalog; the machine never writes a sentence, and nothing is
 * asked of a model. Every field is untrusted text written by an agent.
 */
export const BriefingListenSchema = z.strictObject({
  /** What the point changes for the people who use the product (the card's `effect`). */
  effect: z.string().min(1).max(CARD_EFFECT_MAX).optional(),
  /** The start of the summary: only when the agent wrote no card. */
  summary: z.string().min(1).max(BRIEFING_LISTEN_SUMMARY_MAX_CHARS).optional(),
  /** The first risk of the card. */
  risk: z.string().min(1).max(CARD_LINE_MAX).optional(),
  /** Why the agent proposes this, and the alternative it set aside. */
  reason: z.string().min(1).max(CARD_LINE_MAX).optional(),
  rejected: z.string().min(1).max(CARD_LINE_MAX).optional(),
  /** A deliverable's short version, written by its agent for about fifteen seconds of reading. */
  short: z.string().min(1).max(SHORT_VERSION_MAX_CHARS).optional(),
});
export type BriefingListen = z.infer<typeof BriefingListenSchema>;

export const BriefingItemSchema = z.strictObject({
  /** The checkpoint's identifier: the device finds the point on its own board with it. */
  id: z.string().min(1).max(64),
  type: z.string().min(1).max(32),
  risk: z.enum(["low", "medium", "high"]),
  /** True when the point holds something back or sits at a high risk (the rule of the notifications). */
  urgent: z.boolean(),
  /** True when the point cannot be taken back once decided. */
  irreversible: z.boolean(),
  answering: z.enum(BRIEFING_ANSWERING),
  /** The agent that opened the point, when one did. */
  agent: z.string().min(1).max(BRIEFING_AGENT_MAX_CHARS).optional(),
  title: z.string().min(1).max(BRIEFING_TITLE_MAX_CHARS),
  story: z.string().min(1).max(32).optional(),
  options: z.array(BriefingOptionSchema).max(BRIEFING_OPTIONS_MAX),
  /** The fields the listening version is made from; absent when the point has no text to read. */
  listen: BriefingListenSchema.optional(),
  /** Set on a story's merge point: the story and the branch it lands on. */
  merge: z
    .strictObject({
      story: z.string().min(1).max(32),
      base: z.string().min(1).max(100),
    })
    .optional(),
});
export type BriefingItem = z.infer<typeof BriefingItemSchema>;

export const BriefingDataSchema = z.strictObject({
  op: z.literal("briefing"),
  /** Milliseconds since the epoch, on the machine's clock. */
  composed_at: Count,
  /** What moved in the last 24 hours. */
  progress: z.strictObject({
    merged: Count,
    decided: Count,
  }),
  /** How many points wait for the creator (held answers excluded), whatever `items` lists. */
  waiting: Count,
  items: z.array(BriefingItemSchema).max(BRIEFING_ITEMS_MAX),
});
export type BriefingData = z.infer<typeof BriefingDataSchema>;

type Rec = Readonly<Record<string, unknown>>;

const isRec = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

const dateOf = (value: unknown): number | undefined => {
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : at;
};

/** `value` cut to `max` characters, ending with an ellipsis when cut. */
function cut(value: string, max: number): string {
  const chars = [...value];
  return chars.length <= max
    ? value
    : `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`;
}

const RISK_WEIGHT = { high: 0, medium: 1, low: 2 } as const;

const riskOf = (value: unknown): "low" | "medium" | "high" =>
  value === "high" || value === "medium" ? value : "low";

/** The answer a point's `pending_answer` holds is in its undo window (or just past it): not offered again. */
function isHeld(point: Rec, now: number): boolean {
  const held = point.pending_answer;
  if (point.status !== "open" || !isRec(held)) return false;
  const until = dateOf(held.until);
  return (
    until !== undefined && text(held.decision) !== undefined && until + WEB_ANSWER_STALE_MS > now
  );
}

function answeringOf(point: Rec, type: string): (typeof BRIEFING_ANSWERING)[number] {
  if (type === "memory") return "elsewhere";
  const detail = isRec(point.request) ? text(point.request.detail) : undefined;
  if (point.source === "untrusted_action" && (detail?.length ?? 0) >= 500) return "elsewhere";
  return isRec(point.creator_action) ? "no_approval" : "full";
}

function mergeOf(point: Rec, type: string, stories: Rec): BriefingItem["merge"] {
  const story = text(point.story);
  if (type !== "story" || point.source !== "merge" || story === undefined) return undefined;
  const started =
    isRec(stories[story]) && isRec(stories[story].started) ? stories[story].started : undefined;
  const base = (text(isRec(started) ? started.base_ref : undefined) ?? "origin/main").replace(
    /^origin\//,
    "",
  );
  return { story: cut(story, 32), base: cut(base, 100) };
}

/**
 * The start of a summary, at most `max` UTF-16 units (the unit the schema counts), cut on a whole
 * word: a secret cut in two by the bound would leave a prefix the secret guard no longer knows.
 */
function startOf(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = value.slice(0, max).replace(/[\ud800-\udbff]$/, "");
  return head.replace(/\s+\S*$/, "").trimEnd();
}

/** The fields the listening version of a point is made from, or undefined when it has none. */
function listenOf(point: Rec, type: string): BriefingListen | undefined {
  const card = isRec(point.card) ? point.card : undefined;
  const why = isRec(card?.why) ? card.why : undefined;
  const risks = Array.isArray(card?.risks) ? card.risks : [];
  const publication =
    type === "publication" && isRec(point.publication) ? point.publication : undefined;
  const effect = text(card?.effect);
  const summary = effect === undefined ? text(point.summary) : undefined;
  const risk = text(risks[0]);
  const reason = text(why?.reason);
  const rejected = text(why?.rejected);
  const short = text(publication?.short_version);
  const listen: { -readonly [K in keyof BriefingListen]: BriefingListen[K] } = {};
  if (effect !== undefined) listen.effect = cut(effect, CARD_EFFECT_MAX);
  if (summary !== undefined) listen.summary = startOf(summary, BRIEFING_LISTEN_SUMMARY_MAX_CHARS);
  if (risk !== undefined) listen.risk = cut(risk, CARD_LINE_MAX);
  if (reason !== undefined) listen.reason = cut(reason, CARD_LINE_MAX);
  if (rejected !== undefined) listen.rejected = cut(rejected, CARD_LINE_MAX);
  if (short !== undefined) listen.short = cut(short, SHORT_VERSION_MAX_CHARS);
  return Object.keys(listen).length === 0 ? undefined : listen;
}

function optionsOf(point: Rec): BriefingOption[] {
  const options: BriefingOption[] = [];
  for (const option of Array.isArray(point.options) ? point.options : []) {
    if (!isRec(option)) continue;
    const id = text(option.id);
    const label = text(option.label);
    if (id === undefined || label === undefined) continue;
    options.push({
      id: cut(id, 64),
      label: cut(label, BRIEFING_LABEL_MAX_CHARS),
      recommended: point.recommendation === id,
    });
    if (options.length === BRIEFING_OPTIONS_MAX) break;
  }
  return options;
}

/**
 * Composes the briefing of a product from the state of its projection: the points that wait (an
 * answer held for its undo window is not offered again), the most pressing first, and what moved
 * in the last 24 hours. Pure: the same state and the same clock give the same briefing. The
 * result is not yet through the secret guard.
 */
export function composeBriefing(state: Rec, now: number): BriefingData {
  const stories = isRec(state.stories) ? state.stories : {};
  const points = isRec(state.checkpoints) ? Object.values(state.checkpoints).filter(isRec) : [];
  const since = now - BRIEFING_RECENT_MS;

  let merged = 0;
  for (const story of Object.values(stories)) {
    const at = isRec(story) && isRec(story.merged) ? dateOf(story.merged.at) : undefined;
    if (at !== undefined && at >= since) merged += 1;
  }

  let decided = 0;
  const waiting: Array<{ item: BriefingItem; openedAt: number; urgent: boolean }> = [];
  for (const point of points) {
    const id = text(point.id);
    if (id === undefined) continue;
    if (point.status === "resolved") {
      const at = isRec(point.resolution) ? dateOf(point.resolution.at) : undefined;
      if (at !== undefined && at >= since) decided += 1;
      continue;
    }
    if (point.status !== "open" || isHeld(point, now)) continue;
    const type = (CHECKPOINT_TYPES as readonly unknown[]).includes(point.type)
      ? (point.type as string)
      : "decision";
    const risk = riskOf(point.risk);
    const agent = text(point.opened_by);
    const story = text(point.story);
    const merge = mergeOf(point, type, stories);
    const listen = listenOf(point, type);
    waiting.push({
      openedAt: dateOf(point.opened_at) ?? Number.POSITIVE_INFINITY,
      urgent: isPressingPoint({ risk, blocks: point.blocks }),
      item: {
        id: cut(id, 64),
        type,
        risk,
        urgent: isPressingPoint({ risk, blocks: point.blocks }),
        irreversible: point.irreversible === true,
        answering: answeringOf(point, type),
        ...(agent === undefined ? {} : { agent: cut(agent, BRIEFING_AGENT_MAX_CHARS) }),
        title: cut(text(point.title) ?? id, BRIEFING_TITLE_MAX_CHARS),
        ...(story === undefined ? {} : { story: cut(story, 32) }),
        options: optionsOf(point),
        ...(listen === undefined ? {} : { listen }),
        ...(merge === undefined ? {} : { merge }),
      },
    });
  }
  waiting.sort(
    (a, b) =>
      Number(b.urgent) - Number(a.urgent) ||
      RISK_WEIGHT[a.item.risk] - RISK_WEIGHT[b.item.risk] ||
      (a.openedAt === b.openedAt ? 0 : a.openedAt < b.openedAt ? -1 : 1) ||
      (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
  );
  return {
    op: "briefing",
    composed_at: now,
    progress: { merged, decided },
    waiting: waiting.length,
    items: waiting.slice(0, BRIEFING_ITEMS_MAX).map((entry) => entry.item),
  };
}
