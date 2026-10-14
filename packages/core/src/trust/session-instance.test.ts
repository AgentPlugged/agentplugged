import { describe, expect, it } from "vitest";
import { AgentSession } from "./session.js";

describe("the name of a session", () => {
  it("keeps the name the launcher of the server gives it, so a move to a newer engine changes nothing", () => {
    const given = `server:${"ab12".repeat(8)}`;
    expect(new AgentSession(1, given).instance).toBe(given);
    expect(new AgentSession(1, given).identities[0]).toBe(given);
  });

  it("makes its own name when none is given, or when the one given is not one", () => {
    const own = new AgentSession(1).instance;
    expect(own).toMatch(/^server:[0-9A-Z]{26}$/);
    for (const bad of [
      "",
      "server:",
      "server:short",
      "other:abcdefghijklmnopqrstuvwxyz",
      "server:a b c d e f g h i j k l m n o p",
    ]) {
      const made = new AgentSession(1, bad).instance;
      expect(made, bad).toMatch(/^server:[0-9A-Z]{26}$/);
      expect(made).not.toBe(bad);
    }
    expect(new AgentSession(1).instance).not.toBe(own);
  });
});
