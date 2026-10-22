import { z } from "zod";

/**
 * The creator's single conversation with Noah, read through the bridge (`thread`). The
 * conversation is the named session Noah runs in the creator's AI tool; the bridge reads the
 * messages the tool kept for that session and hands them to a device so that the thread reloads
 * when the device opens, after a restart, and shows what the creator said in the tool's own chat.
 *
 * Nothing is invented or summarised here: a message is a whole message of the session (the
 * creator's or Noah's), never a tool call, a sub-agent's line or a notice of the system. Every
 * text is untrusted (an agent wrote it): the bridge passes it through the secret guard, a device
 * draws it as it draws any answer of Noah. The device keeps none of it (never stored sealed).
 */

/** The most messages one answer carries (the most recent ones). */
export const THREAD_MESSAGES_MAX = 60;
/** The longest message told, in characters (a longer one is cut at the end). */
export const THREAD_TEXT_MAX_CHARS = 4000;

/** The request shape (without the identifier, the version and the product, which the file reading adds). */
export const ThreadRequestFields = {
  op: z.literal("thread"),
} as const;

/** Who wrote a message of the thread. */
export const THREAD_AUTHORS = ["you", "noah"] as const;
export type ThreadAuthor = (typeof THREAD_AUTHORS)[number];

export const ThreadMessageSchema = z.strictObject({
  /** Stable for the message, so that a device reads the same message once. */
  id: z.string().min(1).max(80),
  from: z.enum(THREAD_AUTHORS),
  text: z.string().min(1).max(THREAD_TEXT_MAX_CHARS),
  /** Milliseconds since the epoch, as the tool recorded it. */
  at: z.number().int().min(0),
});
export type ThreadMessage = z.infer<typeof ThreadMessageSchema>;

/** Why the thread cannot be read, in codes a device writes in clear. */
export const THREAD_UNREADABLE_CAUSES = [
  /** The tool no longer has the session (deleted, or the tool's folder moved). */
  "missing",
  /** The session's file is there but is not a record the bridge understands. */
  "damaged",
  /** The session's file is larger than the bridge reads. */
  "too_large",
] as const;
export type ThreadUnreadableCause = (typeof THREAD_UNREADABLE_CAUSES)[number];

export const ThreadDataSchema = z.strictObject({
  op: z.literal("thread"),
  /**
   * `ready`: the messages of the session. `empty`: no conversation yet. `unreadable`: the session
   * exists in the memo but cannot be read (`cause`). `unsupported`: the tool that carries Noah
   * keeps no history the bridge reads (`tool`).
   */
  state: z.enum(["ready", "empty", "unreadable", "unsupported"]),
  messages: z.array(ThreadMessageSchema).max(THREAD_MESSAGES_MAX),
  /** True when older messages exist than the ones told. */
  more: z.boolean(),
  /** The name the tool lists the session under (`/resume`), when the bridge knows it. */
  title: z.string().min(1).max(160).optional(),
  cause: z.enum(THREAD_UNREADABLE_CAUSES).optional(),
  tool: z.string().min(1).max(32).optional(),
});
export type ThreadData = z.infer<typeof ThreadDataSchema>;
