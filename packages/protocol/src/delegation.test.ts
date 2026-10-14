import { describe, expect, it } from "vitest";
import {
  AgentDelegatedPayloadSchema,
  DELEGATION_EVENT_TYPES,
  DelegateInputSchema,
  ErrorCode,
  EVENT_TYPE_REGISTRY,
  NOAH_AGENT,
} from "./index.js";

describe("delegate", () => {
  const input = { agent: NOAH_AGENT, to: "iris", mode: "conversation", brief: "Frame Libère" };

  it("takes an agent or skill, a mode, a brief and an optional story", () => {
    expect(DelegateInputSchema.parse(input)).toEqual(input);
    expect(
      DelegateInputSchema.parse({ ...input, to: "sam", mode: "autonomous", story: "4-2" }),
    ).toMatchObject({ story: "4-2" });
  });

  it("refuses an unknown mode, an empty brief, a bad story and any other field", () => {
    expect(DelegateInputSchema.safeParse({ ...input, mode: "background" }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ ...input, brief: "  " }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ ...input, brief: "x".repeat(2001) }).success).toBe(
      false,
    );
    expect(DelegateInputSchema.safeParse({ ...input, story: "4.2" }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ ...input, actor: "human" }).success).toBe(false);
    expect(DelegateInputSchema.safeParse({ ...input, to: "Iris" }).success).toBe(false);
  });

  it("registers agent.delegated at version 1, with a strict payload", () => {
    expect(EVENT_TYPE_REGISTRY[DELEGATION_EVENT_TYPES.delegated]?.version).toBe(1);
    const payload = { to: "iris", kind: "agent", mode: "conversation", brief: "Frame it" };
    expect(AgentDelegatedPayloadSchema.parse(payload)).toEqual(payload);
    expect(AgentDelegatedPayloadSchema.safeParse({ ...payload, story: "1-1" }).success).toBe(false);
  });

  it("has stable error codes", () => {
    expect(ErrorCode.ROLE_FORBIDDEN).toBe("ROLE_FORBIDDEN");
    expect(ErrorCode.DELEGATION_INVALID).toBe("DELEGATION_INVALID");
  });
});
