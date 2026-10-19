import type { EventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_REDUCERS, type CheckpointState } from "../projection/checkpoint-reducers.js";
import { emptyDraft } from "../projection/reducers.js";
import { checkpointPayload } from "./checkpoint-rules.js";

const CARD = {
  effect: "Customers get a reminder three days before a bill is due.",
  risks: ["A wrong address would send the reminder to a stranger."],
  opinions: [{ agent: "chloe", view: "No personal data leaves the product." }],
  why: { reason: "Late bills are the first cash loss.", rejected: "A reminder on the day." },
};

function opened(payload: unknown) {
  const draft = emptyDraft();
  CHECKPOINT_REDUCERS["checkpoint.opened"]?.(draft, {
    v: 16,
    id: "01JZ0000000000000000000001",
    type: "checkpoint.opened",
    at: "2026-10-03T12:00:00.000Z",
    actor: { kind: "agent", device: "machine:AAAAAAAAAAAAAAAA", agent: "iris" },
    product: "01JZ0000000000000000000000",
    provenance: "untrusted",
    prev: null,
    payload,
  } as unknown as EventEnvelope);
  const checkpoints = draft.state.checkpoints as Record<string, CheckpointState>;
  return Object.values(checkpoints)[0];
}

describe("the card of a checkpoint in the engine", () => {
  it("is written in the payload as a copy, and only when the agent gave one", () => {
    const input = { type: "document", risk: "low", title: "Brief", summary: "Read it." } as const;
    expect(checkpointPayload(input)).not.toHaveProperty("card");
    const payload = checkpointPayload({ ...input, card: CARD });
    expect(payload.card).toEqual(CARD);
    expect(payload.card).not.toBe(CARD);
    expect(payload.card?.risks).not.toBe(CARD.risks);
  });

  it("is kept by the projection, and absent from a checkpoint that has none", () => {
    const base = { type: "document", risk: "low", title: "Brief", summary: "Read it." } as const;
    expect(opened(checkpointPayload({ ...base, card: CARD }))?.card).toEqual(CARD);
    expect(opened(checkpointPayload(base))).not.toHaveProperty("card");
  });
});
