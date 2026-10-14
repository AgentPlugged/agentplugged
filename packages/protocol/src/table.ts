import { z } from "zod";
import { StoryIdSchema } from "./agent-activity.js";
import { MAX_QUOTE_LENGTH } from "./chat.js";
import { hasControlCharacter } from "./deferred.js";
import { AgentIdSchema } from "./method-config.js";

/**
 * The round table of agents in the chat (opened up). The creator asks a
 * question and Noah brings the agents that matter around it, and changes them as the talk goes on
 * (any agent of the team, plus guests who are not of the team); they speak in turns, in the
 * conversation, with their own persona, as long as the creator wants. What the journal keeps is not
 * the debate but its end: who spoke (the team and the guests, apart), the synthesis (what they
 * agree on, where they differ, what is recommended) and the gesture the creator chose to make of
 * it: open a point of decision, create a story, ask for a document to be updated by its author, or
 * nothing. The same record serves the « three views » of a sensitive story before its merge. A
 * saved room (a cast and a setting, in a file of the creator's) can be recalled by its name and may
 * remember a few lines of each session, in a file too: never in the journal. Nothing here follows
 * a debate live, holds a position, or seats several humans: that is not part of this
 * engine.
 */

/** Event types, each at version 1. */
export const TABLE_EVENT_TYPES = {
  /** Noah offered the three views of this story: said once per story (`actor.kind: agent`). */
  proposed: "table.proposed",
  /** A round table closed: the agents, the synthesis, the gesture, the creator's words. */
  closed: "table.closed",
} as const;

/** What the creator makes of the conclusion. */
export const TABLE_GESTURES = ["decision", "story", "document", "none"] as const;
export type TableGesture = (typeof TABLE_GESTURES)[number];

/** The ready-made format: a sensitive story read from three sides before it merges. */
export const TABLE_FORMATS = ["three_views"] as const;
export type TableFormat = (typeof TABLE_FORMATS)[number];

/** The three sides of the format, in order. */
export const TABLE_ANGLES = ["product", "delivery", "quality"] as const;
export type TableAngle = (typeof TABLE_ANGLES)[number];

/** Who takes each side of the three views `next` offers (the team must have all three). */
export const THREE_VIEWS_AGENTS: Readonly<Record<TableAngle, string>> = {
  product: "maya",
  delivery: "omar",
  quality: "quentin",
};

/**
 * Seats at the table, in all (the team's agents and the guests): Noah leads it and never sits.
 * The bounds count everyone who spoke in the session, not those present at once.
 */
export const MIN_TABLE_AGENTS = 2;
/** Agents of the team who spoke, at most. */
export const MAX_TABLE_AGENTS = 12;
/** Guests (outside the team) who spoke, at most. */
export const MAX_TABLE_GUESTS = 8;
/** Guests a saved room keeps, at most. */
export const MAX_ROOM_GUESTS = 6;
/** Lines of memory one session adds to its room, at most. */
export const MAX_SESSION_MEMORY_LINES = 4;
/** Lines of memory a room keeps (the oldest are forgotten), and those read back on entering. */
export const MAX_MEMORY_LINES = 30;
export const RECALLED_MEMORY_LINES = 8;
/** What a guest id starts with: never the id of an agent of the team. */
export const GUEST_ID_PREFIX = "guest-";
/** The fields where a guest's opinion is a lead to check, never advice. */
export const REGULATED_FIELDS = ["law", "health", "finance"] as const;
export type RegulatedField = (typeof REGULATED_FIELDS)[number];
/** Lines of agreement or of disagreement a synthesis holds, at most: it stays short. */
export const MAX_SYNTHESIS_LINES = 5;
/** Stories whose three views were offered, remembered at most. */
export const MAX_REMEMBERED_OFFERS = 80;

const NO_CONTROL = { message: "expected no control character" };

const lineText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !/[\r\n]/.test(text), { message: "expected a single line" })
    .refine((text) => !hasControlCharacter(text, false), NO_CONTROL);

/** A guest's identifier: `guest-` and a slug, so it is never mistaken for an agent of the team. */
export const GuestIdSchema = z
  .string()
  .max(48)
  .regex(/^guest-[a-z0-9]+(?:-[a-z0-9]+)*$/);

/** A saved room's identifier: the name of its files. */
export const RoomIdSchema = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/** One agent at the table, with the reason it was brought (and its side, for the three views). */
export const TableAgentSchema = z.strictObject({
  id: AgentIdSchema.max(64),
  why: lineText(160),
  angle: z.enum(TABLE_ANGLES).optional(),
});
export type TableAgent = z.infer<typeof TableAgentSchema>;

/**
 * One guest at the table, who is not of the team: a specialist, or a customer of a group. `field`
 * names a regulated field (law, health, finance): what the guest says there is a lead to check.
 */
export const TableGuestSchema = z.strictObject({
  id: GuestIdSchema,
  role: lineText(80),
  why: lineText(160),
  field: z.enum(REGULATED_FIELDS).optional(),
});
export type TableGuest = z.infer<typeof TableGuestSchema>;

/** A guest a saved room keeps, with the voice it speaks in. */
export const RoomGuestSchema = z.strictObject({
  id: GuestIdSchema,
  name: lineText(40),
  role: lineText(80),
  persona: lineText(240),
  field: z.enum(REGULATED_FIELDS).optional(),
});
export type RoomGuest = z.infer<typeof RoomGuestSchema>;

/**
 * A saved room, `.agentplugged/rooms/<id>.yaml`: a cast (agents of the team, guests), a setting that
 * says how the room behaves, and whether it remembers its sessions. Written by Noah, read and
 * edited by the creator.
 */
export const RoomSchema = z.strictObject({
  name: lineText(60),
  setting: lineText(300),
  members: z.array(AgentIdSchema.max(64)).max(MAX_TABLE_AGENTS).default([]),
  guests: z.array(RoomGuestSchema).max(MAX_ROOM_GUESTS).default([]),
  memory: z.boolean().default(false),
});
export type Room = z.infer<typeof RoomSchema>;

/** The end of the table: the question, what they agree on, where they differ, what is advised. */
export const TableSynthesisSchema = z.strictObject({
  topic: lineText(200),
  format: z.enum(TABLE_FORMATS).optional(),
  agreed: z.array(lineText(200)).max(MAX_SYNTHESIS_LINES).optional(),
  disputed: z.array(lineText(200)).max(MAX_SYNTHESIS_LINES).optional(),
  advice: lineText(300),
});
export type TableSynthesis = z.infer<typeof TableSynthesisSchema>;

/**
 * The gesture: `subject` is the question of the point (`decision`), the title of the story
 * (`story`) or the document to update (`document`, a path of `.agentplugged/docs/`); `owner`, the
 * agent who opens the point (`decision`, one of those at the table).
 */
export const TableGestureSchema = z.strictObject({
  type: z.enum(TABLE_GESTURES),
  subject: lineText(200).optional(),
  owner: AgentIdSchema.max(64).optional(),
});
export type TableGestureInput = z.infer<typeof TableGestureSchema>;

/**
 * What a call to `chat.table` says of the table, in a single field `table` (the tool list pays for
 * one field name, not four), for two steps the engine tells apart:
 * - propose: `story` alone (Noah offered the three views of that sensitive story, once);
 * - recall: `room` alone (the saved room's cast, setting and short memory are read back);
 * - close: `agents` (the team's) and `guests` who spoke, `synthesis` and `gesture` (and `story`
 *   for the three views), with the creator's `quote` beside it; `room` and `memory` (a few lines
 *   of the session) when the table was a saved room that remembers.
 */
export const TableRecordSchema = z.strictObject({
  story: StoryIdSchema.optional(),
  agents: z
    .array(TableAgentSchema)
    .max(MAX_TABLE_AGENTS + 2)
    .optional(),
  guests: z
    .array(TableGuestSchema)
    .max(MAX_TABLE_GUESTS + 2)
    .optional(),
  synthesis: TableSynthesisSchema.optional(),
  gesture: TableGestureSchema.optional(),
  room: RoomIdSchema.optional(),
  memory: z
    .array(lineText(160))
    .max(MAX_SESSION_MEMORY_LINES + 2)
    .optional(),
});

/** Input of the action `chat.table`: the table, and the creator's words closing it. */
export const RoundTableInputSchema = z.strictObject({
  agent: AgentIdSchema.max(64),
  table: TableRecordSchema,
  /** The creator's words closing the table and choosing the gesture. */
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1).optional(),
});
export type RoundTableInput = z.infer<typeof RoundTableInputSchema>;

/** The call as the rules read it: the table's fields beside `agent` and `quote`. */
export type RoundTableCall = z.infer<typeof TableRecordSchema> & {
  readonly agent: string;
  readonly quote?: string | undefined;
};

/** The flat form of a call. */
export function flatTable(input: RoundTableInput): RoundTableCall {
  return {
    agent: input.agent,
    ...input.table,
    ...(input.quote === undefined ? {} : { quote: input.quote }),
  };
}

/**
 * What a call does: the offer is the story alone, the recall the room alone; anything of a closing
 * makes it a closing.
 */
export function roundTableStepOf(input: RoundTableCall): "propose" | "recall" | "close" {
  if (
    input.agents !== undefined ||
    input.guests !== undefined ||
    input.synthesis !== undefined ||
    input.gesture !== undefined ||
    input.memory !== undefined ||
    input.quote !== undefined
  ) {
    return "close";
  }
  return input.room !== undefined && input.story === undefined ? "recall" : "propose";
}

/** `payload` of `table.proposed`. */
export const TableProposedPayloadSchema = z.strictObject({ story: StoryIdSchema });
export type TableProposedPayload = z.infer<typeof TableProposedPayloadSchema>;

/** `payload` of `table.closed`: the debate is not in it, only its end and the gesture. */
export const TableClosedPayloadSchema = z.strictObject({
  story: StoryIdSchema.optional(),
  format: z.enum(TABLE_FORMATS).optional(),
  topic: lineText(200),
  agents: z.array(TableAgentSchema).max(MAX_TABLE_AGENTS),
  /** Guests who spoke (outside the team); absent from a closing. */
  guests: z.array(TableGuestSchema).max(MAX_TABLE_GUESTS).optional(),
  /** The saved room this table was, when it was one. */
  room: RoomIdSchema.optional(),
  agreed: z.array(lineText(200)).max(MAX_SYNTHESIS_LINES),
  disputed: z.array(lineText(200)).max(MAX_SYNTHESIS_LINES),
  advice: lineText(300),
  gesture: z.strictObject({
    type: z.enum(TABLE_GESTURES),
    subject: lineText(200).optional(),
    owner: AgentIdSchema.max(64).optional(),
  }),
  quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1),
});
export type TableClosedPayload = z.infer<typeof TableClosedPayloadSchema>;
