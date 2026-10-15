import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { isKeychainFullError, unavailableKeychainError } from "./node-key-store.js";
import { removeTestKeys } from "./test-keychain.js";
import {
  HELPER_SCRIPT,
  PowerShellCredentials,
  PowerShellUnavailableError,
  windowsPowerShellPath,
} from "./windows-credentials.js";

// A service of its own per run, never the real `agentplugged`: its entries are deleted afterwards.
const service = `agentplugged-test-${process.pid}-${Date.now()}-ps`;

afterAll(async () => {
  await removeTestKeys(service);
});

const onWindows = process.platform === "win32";

/**
 * One helper for the tests that only use it: it compiles itself when it starts, which can take
 * long on a loaded Windows runner.
 */
let shared: Promise<PowerShellCredentials> | undefined;
const sharedHelper = () => {
  shared ??= PowerShellCredentials.open({ startupTimeoutMs: 170_000 });
  return shared;
};

/**
 * `read` until it gives `expected`, five tries at most: the Credential Manager can answer empty
 * right after a write while other processes use it.
 */
async function settled(read: () => Promise<string | undefined>, expected: string) {
  let value = await read();
  for (let attempt = 0; attempt < 5 && value !== expected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    value = await read();
  }
  return value;
}

/** The native module can be blocked by Smart App Control: then the interop tests have no peer. */
async function nativeKeyring() {
  try {
    return await import("@napi-rs/keyring");
  } catch {
    return undefined;
  }
}

describe.skipIf(!onWindows)("the PowerShell Credential Manager helper (Windows)", { timeout: 180_000 }, () => {
  const SECRET = "héllo ✓ 𝄞 secret=value+/";

  it("reads what @napi-rs/keyring wrote, and the other way round, entry for entry", async (context) => {
    const native = await nativeKeyring();
    if (native === undefined)
      return context.skip("@napi-rs/keyring cannot be loaded on this machine");
    const helper = await sharedHelper();
    const written = new native.AsyncEntry(service, "interop-native");
    await written.setPassword(SECRET);
    expect(await helper.read(service, "interop-native")).toBe(SECRET);

    await helper.write(service, "interop-helper", SECRET);
    const read = new native.AsyncEntry(service, "interop-helper");
    expect(await read.getPassword()).toBe(SECRET);

    // The same entries from both sides: the same accounts, deleted by the other side.
    const listed = (await native.findCredentialsAsync(service)).map((found) => found.account);
    expect(listed.sort()).toEqual(["interop-helper", "interop-native"]);
    expect((await helper.accounts(service)).sort()).toEqual(listed);
    expect(await read.deleteCredential()).toBe(true);
    expect(await helper.read(service, "interop-helper")).toBeUndefined();
    expect(await helper.remove(service, "interop-native")).toBe(true);
    expect(await written.getPassword()).toBeNull();
  });

  it("overwrites, reads a missing entry as undefined and deletes a missing one as false", async () => {
    const helper = await sharedHelper();
    expect(await helper.read(service, "plain")).toBeUndefined();
    expect(await helper.remove(service, "plain")).toBe(false);
    await helper.write(service, "plain", "one");
    await helper.write(service, "plain", "two");
    expect(await settled(() => helper.read(service, "plain"), "two")).toBe("two");
    await helper.write(service, "empty", "");
    expect(await settled(() => helper.read(service, "empty"), "")).toBe("");
    expect(await helper.remove(service, "plain")).toBe(true);
    expect(await helper.remove(service, "empty")).toBe(true);
    expect(await helper.accounts(service)).toEqual([]);
  });

  it("keeps a long secret and answers concurrent requests each with its own answer", async () => {
    const helper = await sharedHelper();
    const long = "k".repeat(1200);
    await helper.write(service, "long", long);
    expect(await helper.read(service, "long")).toBe(long);
    const accounts = Array.from({ length: 12 }, (_, index) => `many-${index}`);
    await Promise.all(
      accounts.map((account) => helper.write(service, account, `value ${account}`)),
    );
    const values = await Promise.all(accounts.map((account) => helper.read(service, account)));
    expect(values).toEqual(accounts.map((account) => `value ${account}`));
    await Promise.all([...accounts, "long"].map((account) => helper.remove(service, account)));
  });

  it("reports a refusal of the Credential Manager with its Windows error code", async () => {
    const helper = await sharedHelper();
    // Past the 2,560 bytes a credential can hold.
    const error = await helper
      .write(service, "too-big", "x".repeat(2000))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Windows error code \d+/);
    expect((error as Error).message).not.toContain("xxxx");
  });

  it("is unavailable, not broken, without PowerShell or in constrained language mode", async () => {
    expect(windowsPowerShellPath()).toMatch(/powershell\.exe$/i);
    await expect(
      PowerShellCredentials.open({ powershell: "C:\\no\\such\\powershell.exe" }),
    ).rejects.toBeInstanceOf(PowerShellUnavailableError);
    // A session switched to constrained language mode first, which forbids `Add-Type`: the helper
    // says so instead of failing in the compiler.
    const script = `$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'
${HELPER_SCRIPT}`;
    const child = spawn(
      windowsPowerShellPath() ?? "",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    await new Promise((resolve) => child.once("exit", resolve));
    const answer = JSON.parse(output.trim()) as { ready: boolean; message: string };
    expect(answer.ready).toBe(false);
    expect(answer.message).toMatch(/ConstrainedLanguage/);
  });

  it("does not keep Node from exiting once its requests are answered", async () => {
    const module = pathToFileURL(
      new URL("./windows-credentials.ts", import.meta.url).pathname.slice(1),
    );
    const script = `
      import { PowerShellCredentials } from ${JSON.stringify(module.href)};
      const helper = await PowerShellCredentials.open({ startupTimeoutMs: 170_000 });
      console.log(JSON.stringify(await helper.read(${JSON.stringify(service)}, "absent") ?? null));
    `;
    // A helper that kept Node alive would never let the child exit: the test's timeout catches it.
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    expect({ code, output: output.trim(), errors }).toEqual({
      code: 0,
      output: "null",
      errors: "",
    });
  });
});

describe("the helper's failure message", () => {
  it("is read as a full keychain for error codes 8 and 14 only", () => {
    const failure = (code: number) =>
      new Error(`Windows Credential Manager failed: no memory (Windows error code ${code})`);
    expect(isKeychainFullError(failure(8))).toBe(true);
    expect(isKeychainFullError(failure(14))).toBe(true);
    expect(isKeychainFullError(failure(80))).toBe(false);
  });
});

describe("the message of a keychain that cannot be reached", () => {
  const blocked = Object.assign(
    new Error(
      "Cannot find native binding. npm has a bug related to optional dependencies (https://github.com/npm/cli/issues/4828). Please try `npm i` again.",
    ),
    {
      cause: Object.assign(
        new Error(
          "An Application Control policy has blocked this file.\r\n \\\\?\\C:\\Users\\ada\\AppData\\Roaming\\npm\\node_modules\\agentplugged\\node_modules\\@napi-rs\\keyring\\keyring.win32-x64-msvc.node",
        ),
        { cause: null },
      ),
    },
  );

  it("names the Windows policy and the file it blocks, and never the npm bug alone", () => {
    const error = unavailableKeychainError(
      blocked,
      new Error("PowerShell is in ConstrainedLanguage mode"),
    );
    expect(error.message).toContain("Smart App Control");
    expect(error.message).toContain("keyring.win32-x64-msvc.node");
    expect(error.message).toContain("ConstrainedLanguage");
    expect(error.message).not.toMatch(/npm has a bug|cannot find native binding/i);
    expect(error.cause).toBe(blocked);
  });

  it("reads the French wording of the same refusal", () => {
    const french = new Error("Une stratégie de contrôle d'application a bloqué ce fichier.");
    expect(unavailableKeychainError(french).message).toContain("Smart App Control");
  });

  it("reads the French wording when Node decoded its accents wrongly", () => {
    // As Node reports it on a French Windows: the system message in the wrong code page.
    const garbled = new Error(
      "Une strat\uFFFDgie de contr\uFFFDle d\uFFFDapplication a bloqu\uFFFD ce fichier.\r\n" +
        "\\\\?\\C:\\Users\\someone\\AppData\\Local\\npm-cache\\_npx\\0\\node_modules\\@napi-rs\\keyring-win32-x64-msvc\\keyring.win32-x64-msvc.node",
    );
    const said = unavailableKeychainError(garbled).message;
    expect(said).toContain("Smart App Control");
    expect(said).toContain("keyring.win32-x64-msvc.node");
  });

  it("gives the real reasons of any other load failure, or says there is none", () => {
    const missing = new Error(
      "Cannot find native binding. npm has a bug related to optional dependencies.",
      {
        cause: new Error("Cannot find module './keyring.linux-x64-gnu.node'"),
      },
    );
    const said = unavailableKeychainError(missing).message;
    expect(said).toContain("Cannot find module './keyring.linux-x64-gnu.node'");
    expect(said).not.toMatch(/npm has a bug/i);
    const bare = unavailableKeychainError(
      new Error("Cannot find native binding. npm has a bug related to optional dependencies."),
    );
    expect(bare.message).toContain("Node gave no further reason");
  });
});
