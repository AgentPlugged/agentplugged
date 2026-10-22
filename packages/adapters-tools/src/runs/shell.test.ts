import { describe, expect, it } from "vitest";
import { chooseShell } from "./shell.js";

const only =
  (...present: string[]) =>
  (path: string): boolean =>
    present.includes(path);

describe("the shell an agent's commands go through", () => {
  it("is the Unix-like shell anywhere but Windows", () => {
    expect(chooseShell({ platform: "linux", exists: () => false })).toBe("bash");
    expect(chooseShell({ platform: "darwin", exists: () => false })).toBe("bash");
  });

  it("is the Unix-like shell on Windows when Git for Windows is installed", () => {
    const env = { ProgramFiles: "C:\\Program Files" };
    expect(
      chooseShell({
        platform: "win32",
        env,
        exists: only("C:\\Program Files\\Git\\bin\\bash.exe"),
      }),
    ).toBe("bash");
  });

  it("finds Git for Windows by the path to git, or by the tool's own setting", () => {
    expect(
      chooseShell({
        platform: "win32",
        env: { PATH: "C:\\Windows;D:\\Tools\\Git\\cmd" },
        exists: only("D:\\Tools\\Git\\bin\\bash.exe"),
      }),
    ).toBe("bash");
    expect(
      chooseShell({
        platform: "win32",
        env: { CLAUDE_CODE_GIT_BASH_PATH: "E:\\git\\bash.exe" },
        exists: only("E:\\git\\bash.exe"),
      }),
    ).toBe("bash");
  });

  it("is PowerShell on Windows without Git for Windows", () => {
    expect(
      chooseShell({
        platform: "win32",
        env: { ProgramFiles: "C:\\Program Files", PATH: "C:\\Windows\\System32" },
        exists: () => false,
      }),
    ).toBe("powershell");
  });

  it("does not trust a file system that throws", () => {
    expect(
      chooseShell({
        platform: "win32",
        env: { ProgramFiles: "C:\\Program Files" },
        exists: () => {
          throw new Error("denied");
        },
      }),
    ).toBe("powershell");
  });
});
