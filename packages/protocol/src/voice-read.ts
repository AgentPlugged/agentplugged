import { z } from "zod";
import { ULID_PATTERN } from "./event-envelope.js";
import { base64urlLength } from "./relay.js";

/**
 * The creator's voice transcribed by their own machine, read through its bridge (`transcribe`):
 * the shapes the request and the answer of the file reading carry.
 *
 * This is the web view's optional voice path (« my machine transcribes »). The browser records
 * a phrase, cuts it into pieces and sends each piece to the bridge on the same end-to-end
 * encrypted channel as every other reading: the relay only carries sealed bytes. The bridge holds
 * the pieces in memory only, gives them to the transcription command the creator set up on that
 * machine, and answers with the text. The audio is never written to a file, never put in the
 * journal, never kept after the answer, and the device never keeps the answer either.
 *
 * Audio format: raw PCM, signed 16-bit little-endian, mono, 16 kHz, in base64url pieces.
 */

/** The only sampling rate and sample size: what the bridge hands to the command. */
export const TRANSCRIBE_SAMPLE_RATE = 16_000;
/** The largest piece of audio of one request, in bytes of PCM (3 seconds); the envelope must hold it sealed. */
export const TRANSCRIBE_CHUNK_MAX_BYTES = 96_000;
/** The longest phrase, in bytes of PCM (20 seconds): a longer one is refused as too large. */
export const TRANSCRIBE_PHRASE_MAX_BYTES = 640_000;
/** The most pieces of one phrase. */
export const TRANSCRIBE_PIECES_MAX = Math.ceil(
  TRANSCRIBE_PHRASE_MAX_BYTES / TRANSCRIBE_CHUNK_MAX_BYTES,
);
/** The longest text the machine gives back, in characters. */
export const TRANSCRIBE_TEXT_MAX_CHARS = 4_000;

/** What the request carries on top of the file reading's own fields. */
export const TranscribeRequestFields = {
  op: z.literal("transcribe"),
  /**
   * `probe`: asks whether the machine can transcribe, with no audio. `audio`: one piece of a
   * phrase; the last one (`final`) makes the machine transcribe and answer with the text.
   */
  step: z.enum(["probe", "audio"]),
  /** The phrase the piece belongs to (audio only). */
  session: z.string().regex(ULID_PATTERN).optional(),
  /** The place of the piece in the phrase, from 0 (audio only). */
  seq: z.int().min(0).max(TRANSCRIBE_PIECES_MAX).optional(),
  /** True on the last piece of the phrase (audio only). */
  final: z.boolean().optional(),
  /** The language to recognize, a BCP-47 tag (audio only). */
  language: z
    .string()
    .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/)
    .optional(),
  /** The PCM of the piece, base64url (audio only). */
  audio: z
    .string()
    .regex(/^[A-Za-z0-9_-]*$/)
    .max(base64urlLength(TRANSCRIBE_CHUNK_MAX_BYTES))
    .optional(),
} as const;

export const TranscribeDataSchema = z.strictObject({
  op: z.literal("transcribe"),
  /** True when the machine has a transcription command set up. */
  ready: z.boolean(),
  /** The words understood: only on the answer to the last piece of a phrase. */
  text: z.string().max(TRANSCRIBE_TEXT_MAX_CHARS).optional(),
});
export type TranscribeData = z.infer<typeof TranscribeDataSchema>;
