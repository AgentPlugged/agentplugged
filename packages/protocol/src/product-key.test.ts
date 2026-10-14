import { describe, expect, it } from "vitest";
import {
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  IGNORED_REASONS,
  isSensitiveEventType,
  isSensitivePath,
  MAX_SENSITIVE_CONTENT_BYTES,
  PRODUCT_KEY_EVENT_TYPES,
  ProductKeyCreatedPayloadSchema,
  ProjectionWarningSchema,
  parseEventEnvelope,
  ReadSensitiveInputSchema,
  SensitiveUnreadableWarningSchema,
  WriteSensitiveInputSchema,
} from "./index.js";
import { utf8Length } from "./product-key.js";

const PROOF = "A".repeat(43);

describe("product key: protocol", () => {
  it("registers product.key_created with its key_id and its proof", () => {
    expect(EVENT_TYPE_REGISTRY[PRODUCT_KEY_EVENT_TYPES.keyCreated]?.version).toBe(1);
    const valid = { key_id: "pk:AbCd-_0123456789", proof: PROOF };
    expect(ProductKeyCreatedPayloadSchema.safeParse(valid).success).toBe(true);
    for (const key_id of ["pk:short", "AbCd-_0123456789AB", "pk:AbCd+_0123456789"]) {
      expect(ProductKeyCreatedPayloadSchema.safeParse({ ...valid, key_id }).success).toBe(false);
    }
    for (const proof of [undefined, "AAAA", `${"A".repeat(42)}B`]) {
      expect(ProductKeyCreatedPayloadSchema.safeParse({ ...valid, proof }).success).toBe(false);
    }
  });

  it("marks the sensitive types: cost.reported, and the salle, security and memory domains", () => {
    expect(isSensitiveEventType("cost.reported")).toBe(true);
    expect(isSensitiveEventType("salle.message_posted")).toBe(true);
    expect(isSensitiveEventType("security.note_added")).toBe(true);
    expect(isSensitiveEventType("memory.lesson_learned")).toBe(true);
    expect(isSensitiveEventType("agent.status_reported")).toBe(false);
    expect(isSensitiveEventType("product.key_created")).toBe(false);
    expect(isSensitiveEventType("checkpoint.resolved")).toBe(false);
  });

  it("requires a key_id in payload_enc", () => {
    const event = {
      v: 1,
      id: "01J9ZQ4V8E3M5N7P9R1S3T5V7X",
      type: "cost.reported",
      at: "2026-10-03T08:00:00.000Z",
      actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "iris" },
      product: "01JZ0000000000000000000000",
      provenance: "untrusted",
      prev: null,
      payload_enc: {
        alg: "xchacha20poly1305",
        key_id: "pk:AAAAAAAAAAAAAAAA",
        nonce: "AA",
        ct: "AA",
      },
      alg: "ed25519",
      sig: `${"A".repeat(85)}Q`,
    };
    expect(parseEventEnvelope(event).success).toBe(true);
    const { key_id: _keyId, ...without } = event.payload_enc;
    const missing = parseEventEnvelope({ ...event, payload_enc: without });
    expect(missing.success === false && missing.error.details.field).toBe("payload_enc.key_id");
  });

  it("adds its codes and reasons at the end of the shared lists", () => {
    // Added after the codes that existed before them (later stories add theirs after).
    const codes: string[] = Object.values(ErrorCode);
    const after = codes.indexOf("FILE_EXISTS") + 1;
    expect(codes.slice(after, after + 4)).toEqual([
      "PRODUCT_KEY_MISSING",
      "PRODUCT_KEY_MISMATCH",
      "PASSPHRASE_INVALID",
      "SENSITIVE_NOT_ENCRYPTED",
    ]);
    const reasons: string[] = [...IGNORED_REASONS];
    const from = reasons.indexOf("decrypt_failed");
    expect(reasons.slice(from, from + 5)).toEqual([
      "decrypt_failed",
      "key_proof_invalid",
      "sensitive_in_clear",
      "unexpected_encryption",
      "unsupported_alg",
    ]);
  });

  it("keeps sensitive_unreadable out of state.json: a machine-local warning", () => {
    const warning = { code: "sensitive_unreadable", count: 2 };
    expect(ProjectionWarningSchema.safeParse(warning).success).toBe(false);
    expect(SensitiveUnreadableWarningSchema.safeParse(warning).success).toBe(true);
    expect(SensitiveUnreadableWarningSchema.safeParse({ ...warning, count: 0 }).success).toBe(
      false,
    );
  });
});

describe("sensitive file tools: input", () => {
  it("accepts a relative path inside the area", () => {
    for (const path of [
      "lessons.md",
      "2026/octobre/notes.md",
      "équipe/réunion 1.md",
      "console.md",
    ]) {
      expect(isSensitivePath(path), path).toBe(true);
    }
  });

  it("refuses .., absolute paths, drives, backslashes, empty names and Windows traps", () => {
    for (const path of [
      "",
      "../x",
      "a/../../x",
      "./x",
      "/etc/passwd",
      "C:/x",
      "C:x",
      "a\\b",
      "a//b",
      "a/",
      ".",
      "..",
      " x",
      "a\u0000b",
      "notes.",
      "notes ",
      "dir./x.md",
      "CON",
      "nul.md",
      "Aux.txt",
      "a/com1.md",
      "LPT9",
    ]) {
      expect(isSensitivePath(path), path).toBe(false);
    }
  });

  it("reads and writes in salle or memory only, strictly", () => {
    const read = { agent: "iris", area: "memory", path: "lessons.md" };
    expect(ReadSensitiveInputSchema.safeParse(read).success).toBe(true);
    expect(ReadSensitiveInputSchema.safeParse({ ...read, area: "docs" }).success).toBe(false);
    expect(ReadSensitiveInputSchema.safeParse({ ...read, path: "../x" }).success).toBe(false);
    expect(ReadSensitiveInputSchema.safeParse({ ...read, actor: "human" }).success).toBe(false);
    const write = { ...read, area: "salle", content: "Bonjour" };
    expect(WriteSensitiveInputSchema.safeParse(write).success).toBe(true);
    expect(WriteSensitiveInputSchema.safeParse({ ...write, content: undefined }).success).toBe(
      false,
    );
  });

  it("limits the content to 256 KiB of UTF-8", () => {
    const write = { agent: "iris", area: "memory", path: "big.md" };
    const exact = "a".repeat(MAX_SENSITIVE_CONTENT_BYTES);
    expect(WriteSensitiveInputSchema.safeParse({ ...write, content: exact }).success).toBe(true);
    expect(WriteSensitiveInputSchema.safeParse({ ...write, content: `${exact}a` }).success).toBe(
      false,
    );
    const accents = "é".repeat(MAX_SENSITIVE_CONTENT_BYTES / 2 + 1);
    expect(WriteSensitiveInputSchema.safeParse({ ...write, content: accents }).success).toBe(false);
    expect(utf8Length("aé€😀")).toBe(1 + 2 + 3 + 4);
  });
});
