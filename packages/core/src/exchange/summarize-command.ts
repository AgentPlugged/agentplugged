import {
  EXCHANGE_EVENT_TYPES,
  NOAH_AGENT,
  type SummarizeInput,
  SummarizeInputSchema,
} from "@agentplugged/protocol";
import { agentEventCommand } from "../agent-activity/agent-commands.js";
import { roleForbidden } from "../agents/noah-role.js";

/**
 * `summarize`: Noah writes the short note of an exchange with the creator (what was asked, what
 * was decided, what was promised) to the journal. A session that starts later, in the AI tool or
 * in the bridge, reads the latest notes in `get_state` and takes the thread up from there. Only
 * Noah writes it (`ROLE_FORBIDDEN` otherwise); it is allowed while the team is paused and while
 * a checkpoint is open: it only records, it starts nothing.
 */
export const summarizeCommand = agentEventCommand<typeof SummarizeInputSchema>({
  name: "summarize",
  description:
    "Noah only: at the end of each exchange with the creator, write a short note to the journal so that a session that starts later takes the thread up. `agent` is `noah`; `summary` one line of 300 characters at most, in the creator's language: what was asked, decided and promised, never a secret, a key or a password. Once per exchange, after your answer is settled. Refused, nothing written: ROLE_FORBIDDEN (only Noah summarizes).",
  inputSchema: SummarizeInputSchema,
  events(input: SummarizeInput) {
    return {
      events: [{ type: EXCHANGE_EVENT_TYPES.summarized, payload: { summary: input.summary } }],
    };
  },
  check(input) {
    if (input.agent !== NOAH_AGENT) return roleForbidden(input.agent, "summarize");
    return undefined;
  },
});
