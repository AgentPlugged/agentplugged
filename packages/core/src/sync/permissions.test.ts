import { describe, expect, it } from "vitest";
import { cursorDenyRules, denyRules } from "./permissions.js";

const inputs = {
  rootAgentsGenerated: true,
  claudeMdGenerated: true,
  generatedRoots: [".claude"],
  mcpConfigGenerated: true,
};

describe("what the deny rules keep (only what destroys, gives away or carries the rules)", () => {
  it("protects the secrets, the files that carry the rules and the proof of the trace", () => {
    const claude = denyRules(inputs);
    expect(claude).toEqual(
      expect.arrayContaining([
        // The files that carry the rules.
        "Edit(/.agentplugged/method.yaml)",
        "Edit(/.agentplugged/AGENTS.md)",
        "Edit(/.claude/**)",
        "Edit(/AGENTS.md)",
        "Edit(/CLAUDE.md)",
        "Edit(/.mcp.json)",
        "Edit(~/.claude/settings.json)",
        // The secrets: never read, never overwritten.
        "Read(**/.env)",
        "Read(~/.ssh/**)",
        "Read(~/.config/gh/**)",
        "Read(~/.claude/.credentials.json)",
        "Edit(**/.env.local)",
        // The proof of the trace.
        "Edit(~/.agentplugged/chat/**)",
        "Edit(/.git/agentplugged/**)",
        "Bash(git push *agentplugged/journal*)",
        "Bash(git branch*agentplugged/journal*)",
        "Bash(rm *.git/agentplugged*)",
        "Bash(gh api*merge*)",
        // The branch the rules are read from, and the hooks that record the creator's messages.
        "Bash(git update-ref*refs/remotes*)",
        "Bash(claude *)",
        "Bash(agy *)",
        // A merge that bypasses the validation, the token, the remote repository.
        "Bash(gh pr merge*)",
        "Bash(glab mr merge*)",
        "Bash(gh auth*)",
        "Bash(gh repo delete*)",
      ]),
    );
  });

  it("no longer denies what a real guard holds, nor the work (the creator's commands, publishing, the project's folders)", () => {
    const all = [...denyRules(inputs), ...cursorDenyRules(inputs)];
    for (const gone of [
      "agentplugged review",
      "agentplugged key",
      "agentplugged sync",
      "rules set",
      "story ci",
      "curl -d",
      "gh pr create",
      "git rebase",
      "--no-verify",
      "/.agentplugged/agents",
      "/.agentplugged/skills",
      "/.agentplugged/salle",
      "/.agentplugged/memory",
      "~/.agentplugged/memory",
    ]) {
      expect(
        all.some((rule) => rule.includes(gone)),
        gone,
      ).toBe(false);
    }
    // An example of an environment file is no secret.
    expect(all.some((rule) => rule.includes(".env*"))).toBe(false);
  });

  it("writes the same protections in Cursor's syntax", () => {
    const cursor = cursorDenyRules(inputs);
    expect(cursor).toEqual(
      expect.arrayContaining([
        "Write(.agentplugged/method.yaml)",
        "Read(**/.env)",
        "Read(~/.ssh/**)",
        "Shell(gh:pr merge*)",
        "Shell(git:push *agentplugged/journal*)",
      ]),
    );
  });

  it("forbids the agents to pair a device and to read or write what the pairing keeps", () => {
    const claude = denyRules(inputs);
    const cursor = cursorDenyRules(inputs);
    expect(claude).toEqual(
      expect.arrayContaining([
        "Bash(agentplugged pair*)",
        "Bash(agentplugged device*)",
        "Bash(agentplugged-bridge *)",
        "Bash(npx *agentplugged*pair*)",
        "Bash(npx *agentplugged*device*)",
        // The pin of the root, the bridge's folder (link with the account, pairing in progress,
        // logs): neither read nor written, on each system.
        "Read(~/.agentplugged/trust/**)",
        "Edit(~/.agentplugged/trust/**)",
        "Read(~/AppData/Local/AgentPlugged/bridge/**)",
        "Edit(~/AppData/Local/AgentPlugged/bridge/**)",
        "Read(~/Library/Application Support/AgentPlugged/bridge/**)",
        "Read(~/.local/state/agentplugged/bridge/**)",
        "Edit(~/.local/state/agentplugged/bridge/**)",
      ]),
    );
    expect(cursor).toEqual(
      expect.arrayContaining([
        "Shell(agentplugged:pair*)",
        "Shell(agentplugged:device*)",
        "Read(~/.agentplugged/trust/**)",
        "Write(~/.agentplugged/trust/**)",
      ]),
    );
  });

  it("is short: a few dozen rules, not a thousand", () => {
    // 100 since the pairing: its commands and the folders it keeps are protected.
    expect(denyRules(inputs).length).toBeLessThan(100);
  });
});
