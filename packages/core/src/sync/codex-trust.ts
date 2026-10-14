import { sha256Hex } from "@agentplugged/crypto";
import { CODEX_HOOK_DEFINITIONS, codexHookCommands } from "../chat/codex-hook.js";

/**
 * Codex's approval of the project's hooks (layer 2). Codex runs a hook of a project only
 * once the creator approved it, and records the approval in the user's `~/.codex/config.toml`:
 *
 *     [hooks.state.'<project>\.codex\config.toml:<event label>:<group>:<handler>']
 *     trusted_hash = "sha256:<hash of the hook>"
 *
 * The hash is Codex's own (`hook_hash` and `version_for_toml` in `codex-rs`, read on GitHub
 * 2026-10-08): the SHA-256 of the compact JSON, object keys sorted, of
 * `{ event_name: <label>, matcher?, hooks: [{ type: "command", command: <the command of the
 * platform>, timeout, async: false }] }`. It was recomputed on the three real entries of a project
 * approved on Windows (Codex 0.160.1) and found identical; it is not verified on another platform,
 * so nothing is proposed there. The approval is only written when the creator says yes, here, and
 * the file is merged: every other byte of it is kept.
 */

/** The platforms whose hash was checked against Codex's own entries. */
export function codexTrustSupported(platform: string | undefined): boolean {
  return platform === "win32";
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sorted(record[key])]),
    );
  }
  return value;
}

/** The hash Codex records for each hook of `.codex/config.toml`, in the order they are declared. */
export function codexHookHashes(): { readonly label: string; readonly hash: string }[] {
  const { commandWindows } = codexHookCommands();
  return CODEX_HOOK_DEFINITIONS.map((def) => {
    const identity = {
      event_name: def.label,
      ...(def.matcher === undefined ? {} : { matcher: def.matcher }),
      hooks: [
        {
          type: "command",
          command: commandWindows(def.script),
          timeout: def.timeout,
          async: false,
        },
      ],
    };
    return { label: def.label, hash: `sha256:${sha256Hex(JSON.stringify(sorted(identity)))}` };
  });
}

/** Where `~/.codex/config.toml` is read and written: the user's own file, outside the project. */
export interface CodexUserConfig {
  /** The file's path, for the creator to read. */
  readonly path: string;
  /** Its text, or undefined when it does not exist. */
  read(): Promise<string | undefined>;
  /** Replaces the file's text (the engine only calls it with the merged text, after a yes). */
  write(text: string): Promise<void>;
}

export interface CodexTrustEntry {
  readonly key: string;
  readonly hash: string;
  readonly change: "add" | "update" | "keep";
}

export type CodexTrustPlan =
  | { readonly ok: true; readonly entries: readonly CodexTrustEntry[]; readonly text: string }
  | { readonly ok: false; readonly reason: "unsupported" | "unsafe_path" | "unreadable_file" };

/** The keys Codex writes for a project on Windows: both spellings of the drive letter. */
function keyPaths(projectRoot: string): string[] {
  const config = `${projectRoot.trim().replace(/[\\/]+$/, "")}\\.codex\\config.toml`.replaceAll(
    "/",
    "\\",
  );
  const drive = /^([A-Za-z]):/.exec(config);
  if (drive === null) return [config];
  const letter = drive[1] as string;
  const rest = config.slice(2);
  return [...new Set([`${letter.toUpperCase()}:${rest}`, `${letter.toLowerCase()}:${rest}`])];
}

const header = (key: string) => `[hooks.state.'${key}']`;

/** A line without its spaces, separators and quotes: to spot any spelling of a key. */
const loose = (text: string) => text.replace(/[\\/'"\s]/g, "");

/** The line of `trusted_hash` in the table that starts at line `at` (it ends at the next `[`), or -1. */
function trustedHashAt(lines: readonly string[], at: number): number {
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    if ((lines[i] as string).trimStart().startsWith("[")) {
      end = i;
      break;
    }
  }
  return lines.findIndex(
    (line, index) => index > at && index < end && /^\s*trusted_hash\s*=/.test(line),
  );
}

/**
 * What to write in the user's `config.toml` so that the project's hooks are approved, as a merge:
 * the approvals of this project are added or corrected, every other line stays as it is. Refuses
 * (writes nothing) when the file speaks of one of our keys in a form this merge does not know, or
 * the project's path cannot be written as a TOML literal key.
 */
export function planCodexTrust(input: {
  readonly projectRoot: string;
  readonly platform: string | undefined;
  readonly userConfig: string | undefined;
}): CodexTrustPlan {
  try {
    return mergeTrust(input);
  } catch (error) {
    if (error instanceof UnknownSpelling) return { ok: false, reason: "unreadable_file" };
    throw error;
  }
}

function mergeTrust(input: {
  readonly projectRoot: string;
  readonly platform: string | undefined;
  readonly userConfig: string | undefined;
}): CodexTrustPlan {
  if (!codexTrustSupported(input.platform)) return { ok: false, reason: "unsupported" };
  const paths = keyPaths(input.projectRoot);
  // A literal key cannot hold a quote nor a line break.
  if (paths.some((path) => /['\r\n]/.test(path))) return { ok: false, reason: "unsafe_path" };
  const original = input.userConfig ?? "";
  const eol = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original === "" ? [] : original.split(/\r?\n/);
  const hashes = codexHookHashes();
  const entries: CodexTrustEntry[] = [];

  for (const path of paths) {
    hashes.forEach(({ label, hash }) => {
      const key = `${path}:${label}:0:0`;
      const title = header(key);
      const at = lines.findIndex((line) => line.trim() === title);
      // Any other line that names this key (double quotes, dotted keys, inline tables): not ours.
      const spelling = loose(key);
      const strange = lines.findIndex(
        (line, index) => index !== at && loose(line).includes(spelling),
      );
      if (strange !== -1) throw new UnknownSpelling();
      if (at === -1) {
        entries.push({ key, hash, change: "add" });
        return;
      }
      const valueAt = trustedHashAt(lines, at);
      const current =
        valueAt === -1
          ? undefined
          : /^\s*trusted_hash\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(lines[valueAt] as string)?.[1];
      if (valueAt !== -1 && current === undefined) throw new UnknownSpelling();
      entries.push({ key, hash, change: current === hash ? "keep" : "update" });
    });
  }
  return finish();

  function finish(): CodexTrustPlan {
    const out = [...lines];
    for (const entry of entries) {
      if (entry.change === "keep") continue;
      const title = header(entry.key);
      const value = `trusted_hash = "${entry.hash}"`;
      const at = out.findIndex((line) => line.trim() === title);
      if (at === -1) {
        // Appended after the last line, a blank line between tables.
        while (out.length > 0 && (out[out.length - 1] as string).trim() === "") out.pop();
        if (out.length > 0) out.push("");
        out.push(title, value);
        continue;
      }
      const valueAt = trustedHashAt(out, at);
      if (valueAt === -1) out.splice(at + 1, 0, value);
      else out[valueAt] = value;
    }
    const pending = entries.some((entry) => entry.change !== "keep");
    return {
      ok: true,
      entries,
      // The file ends with a line break (the one its last empty element already stands for, or ours).
      text: pending ? `${out.join(eol)}${out[out.length - 1] === "" ? "" : eol}` : original,
    };
  }
}

/** Thrown inside the merge when the file names a key in a form it does not know. */
class UnknownSpelling extends Error {}
