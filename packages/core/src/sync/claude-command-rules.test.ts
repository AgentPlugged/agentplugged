import { describe, expect, it } from "vitest";
import { claudeCommandRules } from "./rule-permissions.js";

describe("claudeCommandRules", () => {
  it("doubles only a lone final backslash and gives each Bash rule its PowerShell twin", () => {
    expect(claudeCommandRules(["Bash(rd /s* C:\\)", "Bash(rd /s* C:/)", "Edit(/x)"])).toEqual([
      "Bash(rd /s* C:\\\\)",
      "PowerShell(rd /s* C:\\\\)",
      "Bash(rd /s* C:/)",
      "PowerShell(rd /s* C:/)",
      "Edit(/x)",
    ]);
  });

  it("leaves a rule that already ends with two backslashes as it is", () => {
    expect(claudeCommandRules(["Bash(echo C:\\\\)"])).toEqual([
      "Bash(echo C:\\\\)",
      "PowerShell(echo C:\\\\)",
    ]);
  });
});
