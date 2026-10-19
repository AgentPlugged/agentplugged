import type { EventEnvelope } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import { emptyDraft, REDUCERS } from "../projection/reducers.js";

const A = "machine:AAAAAAAAAAAAAAAA";
const B = "machine:BBBBBBBBBBBBBBBB";

function event(over: Partial<EventEnvelope> & { device: string; bridge: string }): EventEnvelope {
  return {
    id: over.id ?? "01J00000000000000000000001",
    type: "bridge.primary_changed",
    at: "2026-10-15T08:00:00.000Z",
    actor: { kind: over.actor?.kind ?? "system", device: over.device },
    payload: { bridge: over.bridge, previous: null },
  } as unknown as EventEnvelope;
}

describe("the main bridge in the projection", () => {
  it("keeps the last change written by a machine", () => {
    const draft = emptyDraft();
    const reduce = REDUCERS["bridge.primary_changed"];
    reduce?.(draft, event({ id: "01J00000000000000000000001", device: A, bridge: A }));
    reduce?.(draft, event({ id: "01J00000000000000000000002", device: B, bridge: B }));
    expect(draft.state.primary_bridge).toMatchObject({ bridge: B, device: B });
  });

  it("ignores a change that no machine wrote", () => {
    const draft = emptyDraft();
    REDUCERS["bridge.primary_changed"]?.(
      draft,
      event({ device: "human:HHHHHHHHHHHHHHHH", bridge: B, actor: { kind: "human", device: "x" } }),
    );
    expect(draft.state.primary_bridge).toBeUndefined();
  });
});
