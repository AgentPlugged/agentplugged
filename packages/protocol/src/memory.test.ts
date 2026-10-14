import { describe, expect, it } from "vitest";
import { OpenCheckpointInputSchema } from "./checkpoint.js";
import { ErrorCode } from "./error-payload.js";
import { EVENT_TYPE_REGISTRY, isSensitiveEventType } from "./event-types.js";
import {
  commonIdOf,
  LESSON_EVENT_TYPES,
  LessonIdSchema,
  LessonsRecordedPayloadSchema,
  lessonIdOf,
  MEMORY_EVENT_TYPES,
  MemoryRecordSchema,
  ProposeRetrospectiveInputSchema,
  ReadMemoryInputSchema,
  RecordLessonsInputSchema,
  retroIdOf,
  retroTitle,
} from "./memory.js";

const LESSON = { title: "Run the checks first", text: "Run the whole suite before review." };

describe("ids of the memory", () => {
  it("draws the retrospective, lesson and common ids from the events", () => {
    const retro = retroIdOf("01JZ00000000000000007M2K9QX4TB");
    expect(retro).toBe("R-7M2K9QX4TB");
    expect(lessonIdOf(retro, 3)).toBe("L-7M2K9QX4TB-3");
    expect(LessonIdSchema.safeParse(lessonIdOf(retro, 12)).success).toBe(true);
    expect(LessonIdSchema.safeParse("L-7M2K9QX4TB-0").success).toBe(false);
    expect(commonIdOf("G-7M2K9QX4TB")).toBe("C-7M2K9QX4TB");
  });
  it("titles a retrospective by its scope", () => {
    expect(retroTitle({ kind: "epic", id: "4" })).toBe("Retrospective: epic 4");
  });
});

describe("propose_retrospective input", () => {
  const base = { agent: "izzy", scope: { kind: "epic", id: "4" }, summary: "What we saw." };
  it("takes lessons, retirements and actions, at least one", () => {
    expect(ProposeRetrospectiveInputSchema.safeParse({ ...base, lessons: [LESSON] }).success).toBe(
      true,
    );
    expect(ProposeRetrospectiveInputSchema.safeParse(base).success).toBe(false);
    expect(
      ProposeRetrospectiveInputSchema.safeParse({ ...base, actions: [{ text: "Add a test." }] })
        .success,
    ).toBe(true);
  });
  it("refuses a bad scope, a control character, a long text and unknown fields", () => {
    const parse = (extra: object) =>
      ProposeRetrospectiveInputSchema.safeParse({ ...base, lessons: [LESSON], ...extra }).success;
    expect(parse({ scope: { kind: "epic", id: "epic-4" } })).toBe(false);
    expect(parse({ scope: { kind: "sprint", id: "S-7M2K9QX4TB" } })).toBe(true);
    expect(parse({ lessons: [{ ...LESSON, text: "a\u0000b" }] })).toBe(false);
    expect(parse({ lessons: [{ ...LESSON, title: "a\nb" }] })).toBe(false);
    expect(parse({ lessons: [{ ...LESSON, text: "x".repeat(1001) }] })).toBe(false);
    expect(parse({ lessons: Array.from({ length: 13 }, () => LESSON) })).toBe(false);
    expect(parse({ lessons: [{ ...LESSON, tags: ["Bad Tag"] }] })).toBe(false);
    expect(
      parse({ lessons: [{ ...LESSON, replaces: ["L-7M2K9QX4TB-1", "L-7M2K9QX4TB-1"] }] }),
    ).toBe(false);
    expect(parse({ extra: 1 })).toBe(false);
  });
});

describe("the other inputs and payloads", () => {
  it("reads a checkpoint id without case, and bounds read_memory", () => {
    const parsed = RecordLessonsInputSchema.parse({ agent: "izzy", checkpoint: " g-7m2k9qx4tb " });
    expect(parsed.checkpoint).toBe("G-7M2K9QX4TB");
    expect(ReadMemoryInputSchema.safeParse({ agent: "sam", limit: 101 }).success).toBe(false);
    expect(ReadMemoryInputSchema.safeParse({ agent: "sam", limit: 5, tags: ["a"] }).success).toBe(
      true,
    );
  });
  it("keeps the lessons.recorded payload free of any text", () => {
    const payload = {
      checkpoint: "G-7M2K9QX4TB",
      retro: "R-7M2K9QX4TB",
      lessons: [{ id: "L-7M2K9QX4TB-1", digest: "a".repeat(64) }],
      retired: [],
      excepted: [],
    };
    expect(LessonsRecordedPayloadSchema.safeParse(payload).success).toBe(true);
    expect(LessonsRecordedPayloadSchema.safeParse({ ...payload, text: "x" }).success).toBe(false);
  });
  it("describes a memory record by kind", () => {
    expect(
      MemoryRecordSchema.safeParse({ kind: "promotion", lesson: "L-7M2K9QX4TB-1" }).success,
    ).toBe(true);
    expect(MemoryRecordSchema.safeParse({ kind: "promotion", lesson: "x" }).success).toBe(false);
  });
});

describe("registry", () => {
  it("encrypts the proposal and leaves the anchors in clear", () => {
    expect(isSensitiveEventType(MEMORY_EVENT_TYPES.retrospectiveProposed)).toBe(true);
    expect(EVENT_TYPE_REGISTRY[MEMORY_EVENT_TYPES.retrospectiveProposed]?.sensitive).toBe(true);
    for (const type of Object.values(LESSON_EVENT_TYPES)) {
      expect(isSensitiveEventType(type), type).toBe(false);
    }
  });
  it("opens no memory checkpoint for an agent", () => {
    const result = OpenCheckpointInputSchema.safeParse({
      agent: "izzy",
      type: "memory",
      risk: "low",
      title: "x",
      summary: "y",
    });
    expect(result.success).toBe(false);
  });
  it("puts MEMORY_INVALID with the key codes, away from the end of the list", () => {
    const codes = Object.values(ErrorCode);
    expect(codes[codes.indexOf("KEYCHAIN_FULL") + 1]).toBe("MEMORY_INVALID");
  });
});
