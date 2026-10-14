import { z } from "zod";
import { MAX_QUOTE_LENGTH } from "./chat.js";
import { CheckpointIdSchema } from "./checkpoint.js";
import { CREATOR_ACTION_SOURCES, CreatorActionRecordSchema } from "./creator-action.js";

/**
 * `payload` of `creator_action.executed`: the action the engine carried out once the
 * creator approved its request, exactly as the request recorded it, and where the approval was
 * given. From the chat, the agent that relayed the answer writes it (`actor.kind: agent`, signed
 * by the machine key) with the creator's words; at the terminal, the creator's key signs it. The
 * projection accepts it only right after that approval, in the same write.
 */
export const CreatorActionExecutedPayloadSchema = z
  .strictObject({
    checkpoint: CheckpointIdSchema,
    action: CreatorActionRecordSchema,
    source: z.enum(CREATOR_ACTION_SOURCES),
    /** The creator's words, quoted from the chat (with `source: chat` only). */
    quote: z.string().max(MAX_QUOTE_LENGTH).trim().min(1).optional(),
  })
  .superRefine((value, context) => {
    if ((value.source === "chat") !== (value.quote !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["quote"],
        message: "a quote goes with the chat, and only with it",
      });
    }
  });
export type CreatorActionExecutedPayload = z.infer<typeof CreatorActionExecutedPayloadSchema>;
