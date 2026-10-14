import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The Windows Credential Manager without any native module of ours: a `powershell.exe` (Windows
 * PowerShell 5.1, the one every Windows 10 and 11 has) compiles a few lines of C# that call
 * `CredReadW`, `CredWriteW`, `CredDeleteW` and `CredEnumerateW`, then answers one JSON line per
 * request on its standard output. It is started on first use and kept for the life of the process.
 *
 * Why: Smart App Control (on by default on a new Windows 11) refuses to load an unsigned `.node`
 * file such as the one of `@napi-rs/keyring`, while PowerShell, signed by Microsoft, may still
 * compile and run its own code.
 *
 * The entries are those `@napi-rs/keyring` (keyring-rs) writes, so a key written by one is read by
 * the other: a generic credential (`CRED_TYPE_GENERIC`) of target `<account>.<service>`, user name
 * `<account>`, persisted for the enterprise (`CRED_PERSIST_ENTERPRISE`), whose blob is the secret
 * in UTF-16 little-endian, with no terminator.
 *
 * Secrets travel on the helper's standard input only, as base64 inside JSON lines: never on its
 * command line (which only holds the script, secret-free), never in its environment, never in a
 * file. The helper's answers to a failure never repeat a request.
 */

/** What the key store needs from a keychain; one implementation per way of reaching it. */
export interface CredentialBackend {
  /** The secret of the entry, or undefined when there is none. */
  read(service: string, account: string): Promise<string | undefined>;
  write(service: string, account: string, secret: string): Promise<void>;
  /** True when there was an entry to delete. */
  remove(service: string, account: string): Promise<boolean>;
  /** The accounts of the entries of `service`. */
  accounts(service: string): Promise<string[]>;
}

/** The C# the helper compiles. C# 5 only: Windows PowerShell 5.1 compiles with the .NET 4 compiler. */
const CSHARP = String.raw`
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
using System.Web.Script.Serialization;

public static class ApCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct CREDENTIAL {
    public uint Flags;
    public uint Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public uint CredentialBlobSize;
    public IntPtr CredentialBlob;
    public uint Persist;
    public uint AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }

  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL credential, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("advapi32.dll", EntryPoint = "CredEnumerateW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredEnumerate(string filter, uint flags, out uint count, out IntPtr credentials);
  [DllImport("advapi32.dll", EntryPoint = "CredFree")]
  static extern void CredFree(IntPtr buffer);

  const uint Generic = 1;
  const uint PersistEnterprise = 3;
  const int NotFound = 1168;

  static string Text(string b64) {
    return b64 == null ? null : Encoding.UTF8.GetString(Convert.FromBase64String(b64));
  }
  static string B64(string text) {
    return Convert.ToBase64String(Encoding.UTF8.GetBytes(text == null ? "" : text));
  }
  public static string Failure(int code, string message) {
    return "{\"ok\":false,\"code\":" + code + ",\"message\":\"" + B64(message) + "\"}";
  }
  static string Win32Failure(int code) {
    string message;
    try { message = new System.ComponentModel.Win32Exception(code).Message; } catch (Exception) { message = ""; }
    return Failure(code, message);
  }

  // One request line in, one answer line out. The line is parsed here, not by a cmdlet, so that
  // PowerShell module logging (when a policy turns it on) never records a secret.
  public static string HandleLine(string line) {
    int id = 0;
    try {
      Dictionary<string, object> request =
        (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(line);
      id = Convert.ToInt32(request["id"]);
      string answer = Handle(Field(request, "op"), Field(request, "target"), Field(request, "user"), Field(request, "secret"));
      return "{\"id\":" + id + "," + answer.Substring(1);
    } catch (Exception) {
      return "{\"id\":" + id + "," + Failure(0, "the credential helper could not read a request").Substring(1);
    }
  }
  static string Field(Dictionary<string, object> request, string name) {
    object value;
    return request.TryGetValue(name, out value) && value != null ? value.ToString() : "";
  }

  public static string Handle(string op, string targetB64, string userB64, string secretB64) {
    try {
      string target = Text(targetB64);
      if (op == "read") return Read(target);
      if (op == "write") return Write(target, Text(userB64), Convert.FromBase64String(secretB64));
      if (op == "delete") return Delete(target);
      if (op == "list") return List(target);
      return Failure(0, "unknown operation");
    } catch (Exception) {
      return Failure(0, "the credential helper failed");
    }
  }

  static string Read(string target) {
    IntPtr pointer;
    if (!CredRead(target, Generic, 0, out pointer)) {
      int error = Marshal.GetLastWin32Error();
      return error == NotFound ? "{\"ok\":true,\"found\":false}" : Win32Failure(error);
    }
    try {
      CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
      byte[] blob = new byte[credential.CredentialBlobSize];
      if (blob.Length > 0) Marshal.Copy(credential.CredentialBlob, blob, 0, blob.Length);
      string answer = "{\"ok\":true,\"found\":true,\"secret\":\"" + Convert.ToBase64String(blob) + "\"}";
      Array.Clear(blob, 0, blob.Length);
      return answer;
    } finally {
      CredFree(pointer);
    }
  }

  static string Write(string target, string user, byte[] blob) {
    IntPtr memory = Marshal.AllocHGlobal(blob.Length == 0 ? 1 : blob.Length);
    try {
      if (blob.Length > 0) Marshal.Copy(blob, 0, memory, blob.Length);
      CREDENTIAL credential = new CREDENTIAL();
      credential.Type = Generic;
      credential.TargetName = target;
      credential.CredentialBlobSize = (uint)blob.Length;
      credential.CredentialBlob = memory;
      credential.Persist = PersistEnterprise;
      credential.UserName = user;
      if (!CredWrite(ref credential, 0)) return Win32Failure(Marshal.GetLastWin32Error());
      return "{\"ok\":true}";
    } finally {
      byte[] zeros = new byte[blob.Length];
      if (zeros.Length > 0) Marshal.Copy(zeros, 0, memory, zeros.Length);
      Marshal.FreeHGlobal(memory);
      Array.Clear(blob, 0, blob.Length);
    }
  }

  static string Delete(string target) {
    if (CredDelete(target, Generic, 0)) return "{\"ok\":true,\"found\":true}";
    int error = Marshal.GetLastWin32Error();
    return error == NotFound ? "{\"ok\":true,\"found\":false}" : Win32Failure(error);
  }

  // The accounts of a service: every generic credential whose target is "<user>.<service>".
  static string List(string service) {
    uint count;
    IntPtr array;
    if (!CredEnumerate(null, 0, out count, out array)) {
      int error = Marshal.GetLastWin32Error();
      return error == NotFound ? "{\"ok\":true,\"users\":[]}" : Win32Failure(error);
    }
    try {
      List<string> users = new List<string>();
      for (int index = 0; index < count; index++) {
        IntPtr pointer = Marshal.ReadIntPtr(array, index * IntPtr.Size);
        CREDENTIAL credential = (CREDENTIAL)Marshal.PtrToStructure(pointer, typeof(CREDENTIAL));
        if (credential.Type == Generic && credential.UserName != null
            && credential.TargetName == credential.UserName + "." + service) {
          users.Add("\"" + B64(credential.UserName) + "\"");
        }
      }
      return "{\"ok\":true,\"users\":[" + string.Join(",", users.ToArray()) + "]}";
    } finally {
      CredFree(array);
    }
  }
}
`;

/**
 * The helper's script: compiles the C#, says it is ready (or why it cannot be), then answers one
 * JSON line per request line until its input closes. Constrained language mode forbids `Add-Type`,
 * which is said before trying.
 */
export const HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$out = [Console]::Out
try {
  $mode = [string]$ExecutionContext.SessionState.LanguageMode
  if ($mode -ne 'FullLanguage') { throw ('PowerShell is in ' + $mode + ' mode, which forbids compiling code') }
  Add-Type -ReferencedAssemblies 'System.Web.Extensions' -TypeDefinition @'
${CSHARP}
'@
  $out.WriteLine('{"ready":true}')
} catch {
  # Constrained language mode forbids method calls: the reason goes out as plain ASCII text,
  # through a cmdlet.
  $reason = ([string]$_) -replace '[^ -~]', ' ' -replace '["\\\\]', ' '
  Write-Output ('{"ready":false,"message":"' + $reason + '"}')
  exit 0
}
while ($null -ne ($line = [Console]::In.ReadLine())) {
  if ($line.Trim().Length -eq 0) { continue }
  $out.WriteLine([ApCredentials]::HandleLine($line))
}
`;

/** Windows PowerShell 5.1 by its full path: never a `powershell` found on the PATH. */
export function windowsPowerShellPath(): string | undefined {
  const root = process.env.SystemRoot ?? process.env.windir;
  if (root === undefined) return undefined;
  const path = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(path) ? path : undefined;
}

/** The helper cannot be used on this machine (no PowerShell, constrained language, a crash...). */
export class PowerShellUnavailableError extends Error {
  override name = "PowerShellUnavailableError";
}

interface Answer {
  id?: number;
  ok?: boolean;
  ready?: boolean;
  found?: boolean;
  secret?: string;
  users?: string[];
  code?: number;
  message?: string;
}

interface Pending {
  resolve(answer: Answer): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/** A pipe or a process that Node can stop waiting for. */
interface Unreferenceable {
  ref?(): unknown;
  unref?(): unknown;
}

const decode = (text: string | undefined) => Buffer.from(text ?? "", "base64").toString("utf8");

/** One running helper process. */
class Session {
  readonly #child: ChildProcess;
  readonly #pending = new Map<number, Pending>();
  #nextId = 1;
  #buffer = "";
  #alive = true;
  #onReady: ((answer: Answer) => void) | undefined;

  private constructor(child: ChildProcess) {
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#receive(chunk));
    child.stdin?.on("error", () => {
      // A helper that died is reported by its exit; a write to it must not crash the process.
    });
    child.on("error", () => this.#end("PowerShell could not be started"));
    child.on("close", () => this.#end("the PowerShell credential helper stopped"));
  }

  /** Starts a helper and waits until it is ready, or says why it cannot be. */
  static start(powershell: string, startupTimeoutMs: number): Promise<Session> {
    const script = Buffer.from(HELPER_SCRIPT, "utf16le").toString("base64");
    const child = spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    const session = new Session(child);
    return new Promise<Session>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.close();
        reject(new PowerShellUnavailableError("PowerShell did not answer in time"));
      }, startupTimeoutMs);
      session.#onReady = (answer) => {
        clearTimeout(timer);
        if (answer.ready === true) {
          session.#idle();
          resolve(session);
        } else {
          session.close();
          reject(new PowerShellUnavailableError(answer.message || "PowerShell refused"));
        }
      };
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new PowerShellUnavailableError(error.message));
      });
      child.once("close", () => {
        clearTimeout(timer);
        reject(new PowerShellUnavailableError("PowerShell stopped before it was ready"));
      });
    });
  }

  get alive(): boolean {
    return this.#alive;
  }

  /** Stops the helper; its input closing also ends it if the kill fails. */
  close(): void {
    this.#alive = false;
    this.#child.stdin?.end();
    this.#child.kill();
  }

  /** Sends one request and waits for its answer (a failure of the Credential Manager is thrown). */
  request(
    fields: { op: string; target: string; user?: string; secret?: string },
    timeoutMs: number,
  ): Promise<Answer> {
    if (!this.#alive) {
      return Promise.reject(new Error("the PowerShell credential helper is not running"));
    }
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        this.close();
        reject(new Error("the PowerShell credential helper did not answer in time"));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#busy();
      const line = JSON.stringify({
        id,
        op: fields.op,
        target: Buffer.from(fields.target, "utf8").toString("base64"),
        user: Buffer.from(fields.user ?? "", "utf8").toString("base64"),
        secret: fields.secret,
      });
      this.#child.stdin?.write(`${line}\n`);
    });
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    for (let end = this.#buffer.indexOf("\n"); end >= 0; end = this.#buffer.indexOf("\n")) {
      const line = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end + 1);
      if (line === "") continue;
      let answer: Answer;
      try {
        answer = JSON.parse(line) as Answer;
      } catch {
        continue;
      }
      if (answer.ready !== undefined) {
        this.#onReady?.(answer);
      } else if (answer.id !== undefined) {
        const pending = this.#pending.get(answer.id);
        if (pending === undefined) continue;
        this.#pending.delete(answer.id);
        clearTimeout(pending.timer);
        pending.resolve(answer);
        if (this.#pending.size === 0) this.#idle();
      }
    }
  }

  #end(reason: string): void {
    this.#alive = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  /** While a request is in flight, Node must wait for the answer. */
  #busy(): void {
    for (const handle of this.#handles()) handle.ref?.();
  }

  /** With nothing in flight, the helper never keeps Node from exiting. */
  #idle(): void {
    for (const handle of this.#handles()) handle.unref?.();
  }

  #handles(): Unreferenceable[] {
    return [this.#child, this.#child.stdin, this.#child.stdout] as Unreferenceable[];
  }
}

const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

/** `CredentialBackend` through a PowerShell helper, started on the first request. */
export class PowerShellCredentials implements CredentialBackend {
  readonly #powershell: string;
  #session: Promise<Session> | undefined;

  private constructor(powershell: string) {
    this.#powershell = powershell;
  }

  /**
   * Starts the helper now. Rejects with `PowerShellUnavailableError` when PowerShell is absent, in
   * constrained language mode, or otherwise unable to compile the helper.
   */
  static async open(options: { powershell?: string } = {}): Promise<PowerShellCredentials> {
    const powershell = options.powershell ?? windowsPowerShellPath();
    if (powershell === undefined) {
      throw new PowerShellUnavailableError("Windows PowerShell was not found");
    }
    const backend = new PowerShellCredentials(powershell);
    await backend.#ensure();
    return backend;
  }

  /** The running helper; a new one when the last stopped. */
  async #ensure(): Promise<Session> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      this.#session ??= Session.start(this.#powershell, STARTUP_TIMEOUT_MS).catch(
        (error: unknown) => {
          this.#session = undefined;
          throw error;
        },
      );
      const pending = this.#session;
      const session = await pending;
      if (session.alive) return session;
      if (this.#session === pending) this.#session = undefined;
    }
    throw new Error("the PowerShell credential helper keeps stopping");
  }

  async #ask(fields: { op: string; target: string; user?: string; secret?: string }) {
    const answer = await (await this.#ensure()).request(fields, REQUEST_TIMEOUT_MS);
    if (answer.ok !== true) {
      const message = decode(answer.message) || "the Credential Manager refused";
      throw new Error(
        `Windows Credential Manager failed: ${message} (Windows error code ${answer.code ?? 0})`,
      );
    }
    return answer;
  }

  async read(service: string, account: string): Promise<string | undefined> {
    const answer = await this.#ask({ op: "read", target: `${account}.${service}`, user: account });
    if (answer.found !== true) return undefined;
    return Buffer.from(answer.secret ?? "", "base64").toString("utf16le");
  }

  async write(service: string, account: string, secret: string): Promise<void> {
    await this.#ask({
      op: "write",
      target: `${account}.${service}`,
      user: account,
      secret: Buffer.from(secret, "utf16le").toString("base64"),
    });
  }

  async remove(service: string, account: string): Promise<boolean> {
    const answer = await this.#ask({
      op: "delete",
      target: `${account}.${service}`,
      user: account,
    });
    return answer.found === true;
  }

  async accounts(service: string): Promise<string[]> {
    const answer = await this.#ask({ op: "list", target: service });
    return (answer.users ?? []).map(decode);
  }
}
