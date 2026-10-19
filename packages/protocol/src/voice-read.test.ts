import { describe, expect, it } from "vitest";
import { FilesRequestSchema, FilesResponseReader, FilesResponseSchema } from "./repo-files.js";
import {
  TRANSCRIBE_CHUNK_MAX_BYTES,
  TRANSCRIBE_PHRASE_MAX_BYTES,
  TRANSCRIBE_PIECES_MAX,
  TranscribeDataSchema,
} from "./voice-read.js";

const ID = "01J9ZQ4V8E3M5N7P9R1S3T5V7X";
const PRODUCT = "01J9ZQ4V8E3M5N7P9R1S3T5V80";
const SESSION = "01J9ZQ4V8E3M5N7P9R1S3T5V81";
const base = { v: 1, id: ID, product: PRODUCT, op: "transcribe" };

describe("the transcription request", () => {
  it("accepts a probe with no audio", () => {
    expect(FilesRequestSchema.safeParse({ ...base, step: "probe" }).success).toBe(true);
  });

  it("accepts a piece of a phrase and the last one", () => {
    const piece = { ...base, step: "audio", session: SESSION, seq: 0, language: "fr-FR" };
    expect(FilesRequestSchema.safeParse({ ...piece, audio: "AAAA" }).success).toBe(true);
    expect(
      FilesRequestSchema.safeParse({ ...piece, seq: 2, final: true, audio: "AAAA" }).success,
    ).toBe(true);
  });

  it("refuses anything the request does not name, a step it does not know and a piece too large", () => {
    expect(FilesRequestSchema.safeParse({ ...base, step: "probe", extra: 1 }).success).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, step: "listen" }).success).toBe(false);
    expect(FilesRequestSchema.safeParse({ ...base, step: "audio" }).success).toBe(true);
    const tooLarge = "A".repeat(Math.ceil((TRANSCRIBE_CHUNK_MAX_BYTES * 4) / 3) + 1);
    expect(
      FilesRequestSchema.safeParse({ ...base, step: "audio", session: SESSION, audio: tooLarge })
        .success,
    ).toBe(false);
    expect(
      FilesRequestSchema.safeParse({ ...base, step: "audio", audio: "not base64 +/=" }).success,
    ).toBe(false);
    expect(
      FilesRequestSchema.safeParse({ ...base, step: "audio", language: "fr; rm -rf" }).success,
    ).toBe(false);
  });

  it("allows a phrase of at most twenty seconds in a handful of pieces", () => {
    expect(TRANSCRIBE_PHRASE_MAX_BYTES / 2 / 16_000).toBe(20);
    expect(TRANSCRIBE_PIECES_MAX).toBe(7);
  });
});

describe("the transcription answer", () => {
  const answer = (data: unknown) => ({
    v: 1,
    id: ID,
    product: PRODUCT,
    ok: true,
    at: "worktree",
    read_at: 1,
    data,
  });

  it("carries the readiness, and the text on the last piece", () => {
    expect(TranscribeDataSchema.safeParse({ op: "transcribe", ready: false }).success).toBe(true);
    const full = answer({ op: "transcribe", ready: true, text: "où en est le sprint" });
    expect(FilesResponseSchema.safeParse(full).success).toBe(true);
    expect(FilesResponseReader.safeParse(full).success).toBe(true);
  });

  it("refuses a text that is too long and a field it does not know", () => {
    expect(
      TranscribeDataSchema.safeParse({ op: "transcribe", ready: true, text: "a".repeat(4_001) })
        .success,
    ).toBe(false);
    expect(
      FilesResponseSchema.safeParse(answer({ op: "transcribe", ready: true, audio: "AAAA" }))
        .success,
    ).toBe(false);
  });
});
