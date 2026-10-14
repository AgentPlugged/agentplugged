import { describe, expect, it } from "vitest";
import {
  GetStateInputSchema,
  MAX_CHECKPOINTS_PAGE,
  MAX_DELEGATIONS_PAGE,
  STATE_OPTIONS,
} from "./index.js";

const ID = "G-7M2K9QX4TB";
const ULID = "01M43XAJ69T2M7V14JYQRXKY7H";

describe("the input of get_state", () => {
  it("accepts nothing, or one option", () => {
    expect(GetStateInputSchema.safeParse({}).success).toBe(true);
    for (const input of [
      { checkpoint: ID },
      { checkpoints: {} },
      { checkpoints: { status: "resolved", type: "document", story: "2-6", limit: 5, before: ID } },
      { agent: "iris" },
      { story: "2-6" },
      { delegations: {} },
      { delegations: { limit: 3, before: ULID } },
    ]) {
      expect(GetStateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(true);
    }
  });

  it("names its options", () => {
    expect(STATE_OPTIONS).toEqual([
      "checkpoint",
      "checkpoints",
      "agent",
      "story",
      "delegations",
      "full",
    ]);
  });

  it("reads the whole abridged state with `full: true` alone, and has no `detail` option", () => {
    expect(GetStateInputSchema.safeParse({ full: true }).success).toBe(true);
    expect(GetStateInputSchema.safeParse({ full: false }).success).toBe(false);
    expect(GetStateInputSchema.safeParse({ full: true, story: "2-6" }).success).toBe(false);
    expect(GetStateInputSchema.safeParse({ detail: "full" }).success).toBe(false);
    expect(GetStateInputSchema.safeParse({ detail: true }).success).toBe(false);
  });

  it("refuses two options at once, and any field outside the schema", () => {
    const both = GetStateInputSchema.safeParse({ checkpoint: ID, story: "2-6" });
    expect(both.success).toBe(false);
    expect(both.error?.issues[0]?.message).toContain("one option at a time");
    for (const input of [
      { actor: "iris" },
      { checkpoints: { status: "archived" } },
      { checkpoints: { extra: 1 } },
      { delegations: { story: "2-6" } },
    ]) {
      expect(GetStateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });

  it("bounds the identifiers and the pages", () => {
    for (const input of [
      { checkpoint: "G-short" },
      { checkpoint: "g-7m2k9qx4tb" },
      { story: "two-six" },
      { agent: "Iris" },
      { agent: "" },
      { checkpoints: { before: "2-6" } },
      { checkpoints: { limit: 0 } },
      { checkpoints: { limit: MAX_CHECKPOINTS_PAGE + 1 } },
      { checkpoints: { limit: 1.5 } },
      { checkpoints: { story: "x" } },
      { delegations: { limit: 0 } },
      { delegations: { limit: MAX_DELEGATIONS_PAGE + 1 } },
      { delegations: { before: "G-7M2K9QX4TB" } },
    ]) {
      expect(GetStateInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
    expect(
      GetStateInputSchema.safeParse({ checkpoints: { limit: MAX_CHECKPOINTS_PAGE } }).success,
    ).toBe(true);
    expect(
      GetStateInputSchema.safeParse({ delegations: { limit: MAX_DELEGATIONS_PAGE } }).success,
    ).toBe(true);
  });
});
