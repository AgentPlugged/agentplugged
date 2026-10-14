import type { CommandContext } from "../command.js";
import type { CreatorReply } from "./decision-prompt.js";

/**
 * What the commands that ask the creator through the client's form (a checkpoint, a stack) do the
 * same way around the question: ask one at a time, then remember what the client did with the form.
 */

/**
 * Asks through `ask`, marking `session` (one form open at a time) and `id` (one question per
 * subject) as busy meanwhile; a form that throws is a reply `failed`.
 */
export async function askOnce(
  open: WeakSet<object>,
  asked: Set<string>,
  session: object,
  id: string,
  ask: () => Promise<CreatorReply>,
): Promise<CreatorReply> {
  open.add(session);
  asked.add(id);
  try {
    return await ask();
  } catch {
    return { action: "failed" };
  } finally {
    open.delete(session);
    asked.delete(id);
  }
}

/**
 * What the client did with the form is remembered, never guessed. An answer shows that
 * it shows forms; a refusal that came back before a person could read it, that it does not. A form
 * seen working is never taken for a refused one: a creator who closes it quickly there answers for
 * themselves. A form that gave no sign of life within the probe delay (Cursor) is not shown (story
 * 3.32). True when the creator refused it at once.
 */
export function noteFormReply(context: CommandContext, reply: CreatorReply): boolean {
  const quick =
    (reply.action === "decline" || reply.action === "cancel") &&
    reply.quick === true &&
    context.session?.form !== "works";
  if (reply.action === "accept") context.session?.noteForm("works");
  if (quick) context.session?.noteForm("refused");
  if (reply.action === "failed" && reply.timedOut === true && context.session?.form !== "works") {
    context.session?.noteForm("refused");
  }
  return quick;
}
