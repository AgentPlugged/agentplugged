import { describe, expect, it } from "vitest";
import { codexHookHashes, planCodexTrust } from "./codex-trust.js";

/**
 * The three entries Codex 0.160.1 wrote in `~/.codex/config.toml` when the creator approved the
 * hooks of a real project on Windows (2026-10-08, read-only copy of the trial): the hashes this
 * module computes must be these, to the letter.
 */
const REAL = {
  user_prompt_submit: "sha256:b0abbb82a6b4c9e17d3476790aff5b7ae7728017c61966768b3c9ff725a732cf",
  pre_tool_use: "sha256:35be4de157bae2a2975822ae7d8f538c6054a9bd9123d1d382cb9e671a12ec11",
  post_tool_use: "sha256:e37aec192b52cc2f771bf5059d4e93c3f4757cf163ea669528a4adcd8074870b",
} as const;

const ROOT = "C:\\Users\\Ada\\Desktop\\demo-zero";

const realFile = (): string => {
  const lines: string[] = ['model = "gpt-6.1-sol"', ""];
  for (const drive of ["C", "c"]) {
    for (const [label, hash] of Object.entries(REAL)) {
      lines.push(
        `[hooks.state.'${drive}:\\Users\\Ada\\Desktop\\demo-zero\\.codex\\config.toml:${label}:0:0']`,
        `trusted_hash = "${hash}"`,
        "",
      );
    }
  }
  return lines.join("\n");
};

describe("Codex's approval of the project's hooks (layer 2)", () => {
  it("recomputes the three hashes Codex really wrote", () => {
    const hashes = Object.fromEntries(codexHookHashes().map((h) => [h.label, h.hash]));
    expect(hashes).toEqual(REAL);
  });

  it("finds nothing to do in a file where Codex already recorded them (both drive cases)", () => {
    const plan = planCodexTrust({ projectRoot: ROOT, platform: "win32", userConfig: realFile() });
    expect(plan.ok && plan.entries.map((e) => e.change)).toEqual(Array(6).fill("keep"));
    expect(plan.ok && plan.text).toBe(realFile());
  });

  it("adds the six entries to a missing file, then to a file with other content, keeping every other byte", () => {
    const fresh = planCodexTrust({ projectRoot: ROOT, platform: "win32", userConfig: undefined });
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.entries).toHaveLength(6);
    expect(fresh.entries.every((e) => e.change === "add")).toBe(true);
    // What it writes is what Codex writes: the same headers and hashes.
    const real = realFile().replace('model = "gpt-6.1-sol"\n\n', "");
    expect(new Set(fresh.text.split("\n").filter((l) => l !== ""))).toEqual(
      new Set(real.split("\n").filter((l) => l !== "")),
    );

    const mine =
      '# my settings\r\nmodel = "x"\r\n\r\n[projects.\'C:\\work\']\r\ntrust_level = "trusted"\r\n';
    const merged = planCodexTrust({ projectRoot: ROOT, platform: "win32", userConfig: mine });
    expect(merged.ok && merged.text.startsWith(mine.trimEnd())).toBe(true);
    // The file's line endings are kept.
    expect(merged.ok && merged.text.includes("\r\n[hooks.state.'C:")).toBe(true);
    expect(merged.ok && merged.text.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it("corrects a hash Codex recorded for an older definition, without touching the rest", () => {
    const old = realFile().replaceAll(REAL.pre_tool_use, "sha256:0000");
    const plan = planCodexTrust({ projectRoot: ROOT, platform: "win32", userConfig: old });
    expect(plan.ok && plan.entries.filter((e) => e.change === "update")).toHaveLength(2);
    expect(plan.ok && plan.text).toBe(realFile());
  });

  it("writes nothing when the file names one of the keys in a form it does not know", () => {
    const double = `[hooks.state."${ROOT}\\.codex\\config.toml:pre_tool_use:0:0"]\ntrusted_hash = "sha256:1"\n`;
    expect(planCodexTrust({ projectRoot: ROOT, platform: "win32", userConfig: double })).toEqual({
      ok: false,
      reason: "unreadable_file",
    });
    const dotted = `[hooks.state]\n'${ROOT}\\.codex\\config.toml:post_tool_use:0:0'.trusted_hash = "sha256:1"\n`;
    expect(planCodexTrust({ projectRoot: ROOT, platform: "win32", userConfig: dotted })).toEqual({
      ok: false,
      reason: "unreadable_file",
    });
    const noValue = `[hooks.state.'${ROOT}\\.codex\\config.toml:pre_tool_use:0:0']\ntrusted_hash = 3\n`;
    expect(
      planCodexTrust({ projectRoot: ROOT, platform: "win32", userConfig: noValue }),
    ).toMatchObject({ ok: false });
  });

  it("proposes nothing where the hash was not checked, nor for a path a literal key cannot hold", () => {
    expect(
      planCodexTrust({ projectRoot: "/home/ada/demo", platform: "linux", userConfig: "" }),
    ).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(
      planCodexTrust({ projectRoot: "C:\\Users\\O'Neil\\demo", platform: "win32", userConfig: "" }),
    ).toEqual({ ok: false, reason: "unsafe_path" });
  });
});
