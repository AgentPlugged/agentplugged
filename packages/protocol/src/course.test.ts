import { describe, expect, it } from "vitest";
import {
  COURSE_KINDS,
  CourseInputSchema,
  CourseOpenedPayloadSchema,
  courseIdOf,
  MAX_COURSE_STACK,
  parseCourseStart,
} from "./course.js";

describe("the input of a correction of course", () => {
  it("accepts the four steps and reads the id of a course in any case", () => {
    const open = CourseInputSchema.parse({
      agent: "maya",
      step: "open",
      summary: "No more password.",
      starts: ["EF-1", "4-3#2"],
      quote: "plus de mot de passe",
    });
    expect(open.starts).toEqual(["EF-1", "4-3#2"]);
    const decide = CourseInputSchema.parse({
      agent: "maya",
      step: "decide",
      item: "c-7m2k9qx4tb",
      items: [{ n: 1, gesture: "keep", reason: "Still true." }],
      quote: "oui",
    });
    expect(decide.item).toBe("C-7M2K9QX4TB");
    expect(CourseInputSchema.parse({ agent: "maya", step: "show" }).step).toBe("show");
  });

  it("refuses an unknown step or gesture, too many starts, and an extra field", () => {
    expect(CourseInputSchema.safeParse({ agent: "maya", step: "start" }).success).toBe(false);
    expect(
      CourseInputSchema.safeParse({
        agent: "maya",
        step: "decide",
        items: [{ n: 1, gesture: "drop" }],
      }).success,
    ).toBe(false);
    expect(
      CourseInputSchema.safeParse({
        agent: "maya",
        step: "open",
        starts: Array.from({ length: 9 }, (_, index) => `EF-${index + 1}`),
      }).success,
    ).toBe(false);
    expect(CourseInputSchema.safeParse({ agent: "maya", step: "show", actor: "x" }).success).toBe(
      false,
    );
  });

  it("derives the id from the event that opened the course, stable", () => {
    expect(courseIdOf("01JABCDEFGHJKMNPQRSTVWXYZ0")).toBe("C-QRSTVWXYZ0");
  });
});

describe("what a change starts from", () => {
  it("reads an identifier, a story, a criterion and a passage; nothing else", () => {
    expect(parseCourseStart("ef-3")).toEqual({ kind: "id", id: "EF-3" });
    expect(parseCourseStart("AD-12")).toEqual({ kind: "id", id: "AD-12" });
    expect(parseCourseStart("4-3")).toEqual({ kind: "story", story: "4-3" });
    expect(parseCourseStart("4-3#2")).toEqual({ kind: "criterion", story: "4-3", n: 2 });
    expect(parseCourseStart("prd#Public cible")).toEqual({
      kind: "passage",
      document: "prd",
      passage: "Public cible",
    });
    expect(parseCourseStart("UX#EF-3")).toEqual({
      kind: "passage",
      document: "ux",
      passage: "EF-3",
    });
    for (const nothing of ["EF-0", "EF-03", "prd#", "notes#Heading", "hello", "4-3#0", "#x"]) {
      expect(parseCourseStart(nothing), nothing).toBeUndefined();
    }
  });
});

describe("the payload of an opening", () => {
  it("keeps a bounded stack of sorted kinds and refuses an empty or an oversized one", () => {
    const entry = { kind: "story", ref: "1-1", why: "to do" };
    const base = { summary: "s", quote: "q", starts: ["EF-1"], more: 0, proofs: [] };
    expect(CourseOpenedPayloadSchema.safeParse({ ...base, stack: [entry] }).success).toBe(true);
    expect(CourseOpenedPayloadSchema.safeParse({ ...base, stack: [] }).success).toBe(false);
    expect(
      CourseOpenedPayloadSchema.safeParse({
        ...base,
        stack: Array.from({ length: MAX_COURSE_STACK + 1 }, () => entry),
      }).success,
    ).toBe(false);
    expect(
      CourseOpenedPayloadSchema.safeParse({ ...base, stack: [{ ...entry, kind: "epic" }] }).success,
    ).toBe(false);
    expect(COURSE_KINDS[0]).toBe("decision");
  });
});
