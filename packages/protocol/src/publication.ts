import { z } from "zod";

/**
 * The presentation of a deliverable of launch, marketing or sales: a
 * `publication` checkpoint shows its title (the checkpoint's), its angle, its audience and a short
 * version of about 15 seconds of reading; the full text, the files the checkpoint cites, stays one
 * command away. The agent writes the presentation when it opens the checkpoint; the engine checks
 * it and shows it the same way in the chat, at the terminal and in the AI tool's form. Nothing
 * here publishes, sends or pays: the creator publishes.
 */

/** The short version is read in about this many seconds: the target the agents are told. */
export const SHORT_VERSION_TARGET_SECONDS = 15;

/** Words read per second (about 240 a minute): the engine's measure of a reading time. */
export const READING_WORDS_PER_SECOND = 4;

/** The most the engine accepts: a third more than the target, 80 words. */
export const SHORT_VERSION_MAX_WORDS = 80;

/** Longest short version, whatever its script. */
export const SHORT_VERSION_MAX_CHARS = 600;

/** Longest angle or audience. */
export const PUBLICATION_LINE_MAX_CHARS = 300;

/** The most files a publication cites (the checkpoint's own limit). */
export const MAX_PUBLICATION_FILES = 20;

/** The folder a deliverable lives in: the knowledge base, where agents may write. */
export const PUBLICATION_DOCS_DIR = ".agentplugged/docs/";

/** Where `publication export` writes, one folder per checkpoint (the creator's, never an agent's). */
export const PUBLICATION_EXPORT_DIR = ".agentplugged/exports";

const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/**
 * The words of a text, as `Intl.Segmenter` splits them (scripts without spaces count too), so that
 * a limit in words holds in every language.
 */
export function countWords(text: string): number {
  let words = 0;
  for (const part of segmenter.segment(text)) if (part.isWordLike === true) words += 1;
  return words;
}

/** Seconds a text takes to read, rounded up. */
export function readingSeconds(text: string): number {
  return Math.ceil(countWords(text) / READING_WORDS_PER_SECOND);
}

/** Joiners that spell a script or an emoji sequence, allowed between two visible characters. */
const JOINERS = new Set([0x200c, 0x200d, 0xfe0f]);

/**
 * True when a text holds a character the creator cannot see or that moves other characters: a
 * control character (a line feed aside, when `lines`), an invisible or default-ignorable character
 * (writing direction, zero width, variation selectors, fillers), a space other than the plain one
 * (no-break, ideographic, braille blank), a line or paragraph separator. A joiner (ZWJ, ZWNJ,
 * variation selector 16) is allowed between two visible characters: Persian, Hindi and emoji
 * sequences need it. What the creator reads is what the agent wrote.
 */
export function hasHiddenCharacter(text: string, lines: boolean): boolean {
  const chars = [...text];
  for (const [index, char] of chars.entries()) {
    const code = char.codePointAt(0) ?? 0;
    if (lines && (code === 0x0a || code === 0x09)) continue;
    if (JOINERS.has(code)) {
      const before = chars[index - 1];
      const after = chars[index + 1];
      const visible = (other: string | undefined) =>
        other !== undefined && !/[\s\p{Cc}\p{Cf}]/u.test(other);
      // A variation selector 16 follows its character and may end the text.
      if (visible(before) && (visible(after) || code === 0xfe0f)) continue;
      return true;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if (code === 0x2028 || code === 0x2029 || code === 0x2800) return true;
    if (code !== 0x20 && /\p{Zs}/u.test(char)) return true;
    if (/[\p{Cf}\p{Default_Ignorable_Code_Point}]/u.test(char)) return true;
  }
  return false;
}

/**
 * True when a full text holds a character that would make the creator read something other than
 * what is published: a control character (line breaks and tabs aside) or a writing-direction
 * override or isolate. The zero-width and joiner characters real scripts use stay allowed here.
 */
export function hasMisleadingControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
    if ((code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) return true;
    if (code === 0x2028 || code === 0x2029) return true;
  }
  return false;
}

/** The most lines a short version holds: a few sentences, not a page. */
export const SHORT_VERSION_MAX_LINES = 12;

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => text.isWellFormed(), { message: "expected well-formed text" })
    .refine((text) => !hasHiddenCharacter(text, false), {
      message: "expected one line of visible characters",
    });

/**
 * The short version: a few sentences, about 15 seconds of reading, visible characters only, at
 * least one word, at most 12 lines and no empty line in a row. Windows line ends are read as line
 * feeds.
 */
export const ShortVersionSchema = z
  .string()
  .transform((text) => text.replace(/\r\n?/g, "\n").trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(SHORT_VERSION_MAX_CHARS)
      .refine((text) => text.isWellFormed(), { message: "expected well-formed text" })
      .refine((text) => !hasHiddenCharacter(text, true), {
        message: "expected visible characters (line breaks allowed)",
      })
      .refine(
        (text) => text.split("\n").length <= SHORT_VERSION_MAX_LINES && !/\n[ \t]*\n/.test(text),
        {
          message: `expected at most ${SHORT_VERSION_MAX_LINES} lines and no empty line`,
        },
      )
      .refine((text) => countWords(text) >= 1, { message: "expected at least one word" })
      .refine((text) => countWords(text) <= SHORT_VERSION_MAX_WORDS, {
        message: `expected at most ${SHORT_VERSION_MAX_WORDS} words (about ${SHORT_VERSION_TARGET_SECONDS} seconds of reading)`,
      }),
  );

/** What an agent gives when it opens a `publication` checkpoint. */
export const PublicationInputSchema = z.strictObject({
  /** The angle: what the piece says, and the way it says it. One line. */
  angle: oneLine(PUBLICATION_LINE_MAX_CHARS),
  /** The audience it is written for. One line. */
  audience: oneLine(PUBLICATION_LINE_MAX_CHARS),
  /** The deliverable in about 15 seconds of reading. */
  short_version: ShortVersionSchema,
});
export type PublicationInput = z.infer<typeof PublicationInputSchema>;

/** The presentation as recorded in the checkpoint, and as `get_state` shows it. */
export const PublicationRecordSchema = PublicationInputSchema;
export type PublicationRecord = PublicationInput;
