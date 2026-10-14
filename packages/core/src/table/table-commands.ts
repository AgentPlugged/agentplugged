import {
  ErrorCode,
  flatTable,
  NOAH_AGENT,
  type RoundTableCall,
  type RoundTableInput,
  RoundTableInputSchema,
  roundTableStepOf,
  TABLE_EVENT_TYPES,
  type TableGesture,
} from "@agentplugged/protocol";
import {
  agentEventCommand,
  agentWriteContext,
  invalidInput,
} from "../agent-activity/agent-commands.js";
import { roleForbidden } from "../agents/noah-role.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { normalizedPath } from "../critique/critique-rules.js";
import { parseDocumentFile } from "../docs/parse-document.js";
import { AgentPluggedError } from "../errors.js";
import { type RecalledRoom, recallRoom, saveMemory } from "./rooms.js";
import {
  gestureOwner,
  isDocsPath,
  type TableFacts,
  type TablePrepared,
  validateClosing,
  validateProposal,
  validateRecall,
} from "./table-rules.js";

function invalid(step: string, problems: readonly string[]): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
    command: "round_table",
    field: step,
    reason: `round_table: ${step}: not whole (${problems.length}): ${problems.slice(0, 20).join(", ")}`,
  });
}

/** What the working copy says of the document a gesture aims at (read only for that gesture). */
async function document(
  input: RoundTableCall,
  context: CommandContext,
): Promise<{ documentExists: boolean; documentOwner: string | undefined }> {
  const none = { documentExists: false, documentOwner: undefined };
  const subject = input.gesture?.type === "document" ? input.gesture.subject : undefined;
  if (subject === undefined) return none;
  const path = normalizedPath(subject);
  if (!isDocsPath(path) || !(await context.files.exists(path))) return none;
  const text = await context.files.readText(path).catch(() => undefined);
  const owner = text === undefined ? undefined : parseDocumentFile(path, text).header?.owner;
  return { documentExists: true, documentOwner: typeof owner === "string" ? owner : undefined };
}

/** What the call needs, plus the saved room it names, as the table is handed it. */
interface Prepared extends TablePrepared {
  readonly recalled?: RecalledRoom | undefined;
}

/** What the call needs of the working copy and of the team, and who takes the gesture over. */
async function prepare(
  input: RoundTableCall,
  context: CommandContext,
  agents: ReadonlySet<string>,
): Promise<Prepared> {
  const read = await document(input, context);
  const owner = gestureOwner(input, { active: agents, prepared: { ...read, owner: undefined } });
  if (input.room === undefined) return { ...read, owner };
  const room = await recallRoom(context.files, input.room, agents);
  return room.ok
    ? {
        ...read,
        owner,
        recalled: room.room,
        room: { problems: [], remembers: room.room.remembers },
      }
    : { ...read, owner, room: { problems: room.problems, remembers: false } };
}

/** The subject as the journal and the owner read it: a document's path, normalised. */
function subjectOf(input: RoundTableCall): string | undefined {
  const subject = input.gesture?.subject;
  if (subject === undefined) return undefined;
  return input.gesture?.type === "document" ? normalizedPath(subject) : subject;
}

/** The command that writes one call, from what was read of the working copy and the team once. */
function recordRoundTable(prepared: TablePrepared) {
  return agentEventCommand<typeof RoundTableInputSchema, TablePrepared>({
    name: "round_table",
    description: "Record the offer of the three views of a story, or the end of a round table.",
    inputSchema: RoundTableInputSchema,
    prepare: async () => prepared,
    events: (nested: RoundTableInput) => {
      const input = flatTable(nested);
      if (roundTableStepOf(input) === "propose") {
        return {
          events: [{ type: TABLE_EVENT_TYPES.proposed, payload: { story: input.story } }],
        };
      }
      const synthesis = input.synthesis;
      const subject = subjectOf(input);
      return {
        events: [
          {
            type: TABLE_EVENT_TYPES.closed,
            payload: {
              ...(input.story === undefined ? {} : { story: input.story }),
              ...(synthesis?.format === undefined ? {} : { format: synthesis.format }),
              topic: synthesis?.topic,
              agents: input.agents ?? [],
              ...(input.guests === undefined ? {} : { guests: input.guests }),
              ...(input.room === undefined ? {} : { room: input.room }),
              agreed: synthesis?.agreed ?? [],
              disputed: synthesis?.disputed ?? [],
              advice: synthesis?.advice,
              gesture: {
                type: input.gesture?.type,
                ...(subject === undefined ? {} : { subject }),
                ...(prepared.owner === undefined ? {} : { owner: prepared.owner }),
              },
              quote: input.quote,
            },
          },
        ],
      };
    },
    check: (nested, state, { agents, prepared: read }) => {
      const input = flatTable(nested);
      const facts: TableFacts = { active: agents, state, prepared: read };
      const step = roundTableStepOf(input);
      const problems =
        step === "propose" ? validateProposal(input, facts) : validateClosing(input, facts);
      return problems.length === 0 ? undefined : invalid(step, problems);
    },
  });
}

/**
 * What `chat.table` answers: the offer recorded, a saved room recalled, or the gesture and who
 * takes it over.
 */
export interface RoundTableResult {
  /** Propose: the story whose three views were offered. */
  readonly offered?: string;
  /** Recall: the saved room, its cast checked against the team, and its short memory. */
  readonly room?: RecalledRoom;
  /** Close: the session's lines of memory were written to the room's file (or could not be). */
  readonly memory?: "saved" | "failed";
  /** Close: the gesture, who takes it over (`creator`: proposals only) and its subject. */
  readonly gesture?: TableGesture;
  readonly owner?: string;
  readonly subject?: string;
  /** The advice of the synthesis, to hand to the owner. */
  readonly advice?: string;
}

/**
 * `chat.table`: the end of a round table of agents held in the conversation, and the
 * offer of the three views of a sensitive story. A closing records who spoke and why (agents of the
 * team, never Noah, and guests apart), the synthesis (what they agree on, where they differ, the
 * advice), the gesture the creator chose and their words; the debate itself is never stored. The
 * engine answers who takes the gesture over: the agent who opens the point of decision, Izzy for a
 * story, the author of the document to update. Nothing is opened, created or changed here: the
 * owner does it, on the creator's word.
 */
export const roundTableCommand = defineCommand<RoundTableResult>({
  name: "round_table",
  audience: "agent",
  description:
    "Round table of agents in the chat (skill round-table), Noah only. Close: `table` with `agents` (all of the team who spoke, never Noah; `id`, `why` in one line, and `angle` for the three views), `guests` (`id` starting `guest-`, never an agent's; `role`, `why`, and `field` law, health or finance: leads to check), `synthesis` (`topic`, `agreed`, `disputed`, `advice`; `format: three_views` with `story`: product, delivery and quality, one agent each), `gesture` (`type`: decision with `subject` the question and `owner` one of those at the table; story with `subject` the title; document with `subject` its path in .agentplugged/docs/; none), and `quote` beside it, the creator's words: they choose the gesture. Answers `owner`, who takes it over: the table's agent opens the point, Izzy writes the story, the document's author updates it (`creator`: no author present, only proposals). The debate is not stored. A saved room (`.agentplugged/rooms/<room>.yaml`): `table` with `room` alone answers its cast checked against the team and its short memory; a close naming `room` may add `memory`, at most 4 lines of the session, written to its file when the room remembers (never to the journal). Propose (`table` with `story` alone): once Noah offered the three views of that sensitive story (state.next `table`); once per story. Never close without the creator's words.",
  inputSchema: RoundTableInputSchema,
  async run(context, input) {
    const parsed = RoundTableInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("round_table", parsed.error));
    const value = flatTable(parsed.data);
    // Noah leads the table: no other agent records one.
    if (value.agent !== NOAH_AGENT) return fail(roleForbidden(value.agent, "round_table"));
    const target = await agentWriteContext(context, value.agent);
    if (target instanceof AgentPluggedError) return fail(target);
    const prepared = await prepare(value, context, target.agents);
    const step = roundTableStepOf(value);
    if (step === "recall") {
      // A read: nothing is written to the journal, the room is handed over as it stands.
      const facts: TableFacts = { active: target.agents, state: {}, prepared };
      const problems = validateRecall(value, facts);
      if (problems.length > 0 || prepared.recalled === undefined) {
        return fail(invalid("recall", problems));
      }
      return ok({ room: prepared.recalled });
    }
    const written = await recordRoundTable(prepared).run(context, input);
    if (!written.ok) return fail(written.error);
    if (step === "propose") return ok({ offered: value.story });
    const gesture = value.gesture?.type;
    const subject = subjectOf(value);
    const lines = value.memory ?? [];
    let memory: RoundTableResult["memory"];
    if (value.room !== undefined && lines.length > 0) {
      const date = new Date((context.now ?? Date.now)()).toISOString().slice(0, 10);
      // The closing is recorded: a memory that cannot be written is said, not a failure.
      memory = await saveMemory(context.files, value.room, date, lines).then(
        () => "saved" as const,
        () => "failed" as const,
      );
    }
    return ok({
      ...(memory === undefined ? {} : { memory }),
      ...(gesture === undefined ? {} : { gesture }),
      ...(prepared.owner === undefined ? {} : { owner: prepared.owner }),
      ...(subject === undefined ? {} : { subject }),
      ...(gesture === undefined || gesture === "none" || value.synthesis === undefined
        ? {}
        : { advice: value.synthesis.advice }),
    });
  },
});

/** The agents' commands of the round table, exposed as an MCP action after the others. */
export const roundTableAgentCommands = [roundTableCommand] as const;
