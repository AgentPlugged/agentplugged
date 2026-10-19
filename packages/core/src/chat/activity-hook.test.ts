import { describe, expect, it } from "vitest";
import { DEFAULT_RULES } from "../index.js";
import { claudeTrustHooks, isTrustHook, withTrustHooks } from "../sync/trust-hooks.js";
import {
  ACTIVITY_HOOK_COMMAND,
  ACTIVITY_HOOK_TIMEOUT,
  isActivityHook,
  settingsHaveActivityHook,
} from "./activity-hook.js";

describe("the activity hook in the project's settings", () => {
  it("is registered on the three events, recognised as ours, and removed without touching the creator's", () => {
    const hooks = claudeTrustHooks(DEFAULT_RULES);
    const settings = withTrustHooks({}, hooks);
    expect(settingsHaveActivityHook(JSON.stringify(settings))).toBe(true);
    expect(settingsHaveActivityHook(JSON.stringify({ ...settings, disableAllHooks: true }))).toBe(
      false,
    );
    expect(settingsHaveActivityHook("{}")).toBe(false);
    expect(settingsHaveActivityHook("nonsense")).toBe(false);
    expect(
      isActivityHook({
        type: "command",
        command: ACTIVITY_HOOK_COMMAND,
        timeout: ACTIVITY_HOOK_TIMEOUT,
      }),
    ).toBe(true);
    expect(isTrustHook({ type: "command", command: ACTIVITY_HOOK_COMMAND })).toBe(true);
    const mine = {
      hooks: {
        PreToolUse: [{ matcher: "Read", hooks: [{ type: "command", command: "echo mine" }] }],
      },
    };
    const cleaned = withTrustHooks(withTrustHooks(mine, hooks), undefined);
    expect(cleaned).toEqual(mine);
  });
});
