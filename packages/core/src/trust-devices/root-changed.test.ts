import { ErrorCode, ROOT_CHANGED_MESSAGE_KEY } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { DeviceTrustView } from "../projection/device-trust.js";
import { assertOrdersAllowed, isTrustedDevice, rootChangedError } from "./root-changed.js";

const view = (patch: Partial<DeviceTrustView> = {}): DeviceTrustView => ({
  pinned: true,
  root: { device: "human:AAAAAAAAAAAAAAAA", public_key: "k" },
  blocked: false,
  faults: [],
  dismissed: [],
  devices: [
    {
      device: "human:AAAAAAAAAAAAAAAA",
      kind: "human",
      sig_key: "k",
      enc_key: null,
      bridge: null,
      provisional: false,
      authorized_by: null,
      event: null,
      root: true,
    },
  ],
  revoked: [],
  root_certified_by: null,
  ...patch,
});

describe("no order while SECURITY_ROOT_CHANGED stands", () => {
  const blocked = view({
    blocked: true,
    faults: [
      { id: "01K6KXJ5G0ABCDEFGHJKMNPQRS", hash: "h", device: "human:BBBBBBBBBBBBBBBB", at: "x" },
    ],
  });

  it("raises the error, naming the events, while the alert stands", () => {
    const error = rootChangedError(blocked);
    expect(error?.code).toBe(ErrorCode.SECURITY_ROOT_CHANGED);
    expect(error?.message_key).toBe(ROOT_CHANGED_MESSAGE_KEY);
    expect(error?.details).toEqual({ events: ["01K6KXJ5G0ABCDEFGHJKMNPQRS"] });
    expect(() => assertOrdersAllowed(blocked)).toThrow(/SECURITY_ROOT_CHANGED/);
  });

  it("lets orders through when nothing is wrong, or nothing is known", () => {
    expect(rootChangedError(view())).toBeUndefined();
    expect(rootChangedError(undefined)).toBeUndefined();
    expect(() => assertOrdersAllowed(view())).not.toThrow();
    expect(() => assertOrdersAllowed(undefined)).not.toThrow();
  });

  it("knows a trusted device by its identifier", () => {
    expect(isTrustedDevice(view(), "human:AAAAAAAAAAAAAAAA")).toBe(true);
    expect(isTrustedDevice(view(), "phone:AAAAAAAAAAAAAAAA")).toBe(false);
    expect(isTrustedDevice(undefined, "human:AAAAAAAAAAAAAAAA")).toBe(false);
  });
});
