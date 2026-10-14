import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import {
  COMMIT_HOOK_LINE,
  cursorDenyRules,
  denyRules,
  renderConstitutionReference,
  type StoryStartResult,
} from "@agentplugged/core";
import { createTranslator, isMessageKey } from "@agentplugged/i18n";
import { FAST_TRACK_REASONS, FAST_TRACK_REFUSALS } from "@agentplugged/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./main.js";
import { fastTrackLines, formatStoryStart } from "./story-text.js";

vi.setConfig({ testTimeout: 120_000 });

const fr = createTranslator("fr");
const en = createTranslator("en");
const flat = (text: string) => text.replace(/\s+/g, " ");
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);
const read = (path: string) => readFileSync(join(methodDir, path), "utf8").replace(/\r\n/g, "\n");

const STARTED: StoryStartResult = {
  status: "started",
  story: "1-1",
  agent: "sam",
  branch: "feat/1-1-sign-up",
  base: "0123456789abcdef0123456789abcdef01234567",
  base_ref: "main",
  worktree: "/repos/shop.worktrees/1-1",
  workdir: "/repos/shop.worktrees/1-1",
  track: "full",
  event: { id: "01JZ0000000000000000000000", type: "story.started", at: "2026-10-03T12:00:00Z" },
  hook: { status: "installed", path: "/repos/shop/.git/hooks/commit-msg" },
};

describe("story start's text", () => {
  it("says the branch, the working copy, the hook and where to work", () => {
    expect(formatStoryStart(fr, STARTED)).toBe(
      [
        "Story 1-1 démarrée : branche feat/1-1-sign-up, depuis main (0123456).",
        "  Copie de travail : /repos/shop.worktrees/1-1",
        "  Hook de commit : actif (/repos/shop/.git/hooks/commit-msg). Chaque commit de la branche cite la story et une de ses exigences, par exemple « feat(1-1): … (EF-1) ».",
        "Ouvre l'outil IA de sam dans ce dossier : il n'écrit que dans cette copie de travail.",
        "",
      ].join("\n"),
    );
    const resumed = formatStoryStart(en, {
      ...STARTED,
      status: "resumed",
      agent: "creator",
      hook: { status: "chained", path: "/repos/shop/.git/hooks/commit-msg" },
    });
    expect(resumed).toContain("Story 1-1 resumed: branch feat/1-1-sign-up");
    expect(resumed).toContain("your previous hook is kept as commit-msg.pre-agentplugged");
    expect(resumed).toContain("Work in this folder");
  });

  it("says the story is in the fast track, what the engine reads and what stays", () => {
    const fast = formatStoryStart(fr, { ...STARTED, track: "fast" });
    expect(fast).toContain(
      "Voie rapide : un petit changement, sans cadrage ni conception. À chaque pull request et lecture de la CI, le moteur lit les changements de ta branche ; la revue et ta validation avant la fusion restent celles de la voie complète.",
    );
    expect(formatStoryStart(en, { ...STARTED, track: "fast" })).toContain(
      "Fast track: a small change, without framing nor design.",
    );
    expect(formatStoryStart(fr, STARTED)).not.toContain("Voie rapide");
  });

  it("tells what the engine read of a pull request and of a CI in the fast track", () => {
    const ok = { ok: true, count: 3, reasons: [], left: false } as const;
    const out = {
      ok: false,
      count: 6,
      reasons: ["too_many_files", "migration"],
      left: true,
    } as const;
    expect(fastTrackLines(fr, ok)).toEqual([
      "  Voie rapide : 3 fichier(s) touché(s), c'est encore un petit changement (moins de 5, ni dépendance, ni migration, ni contrat d'interface).",
    ]);
    expect(fastTrackLines(fr, out)).toEqual([
      "  Voie rapide quittée (5 fichiers ou plus sont touchés, un fichier de migration ou de schéma de données est touché ; 6 fichier(s) touché(s)) : la story continue par la voie complète et reste bloquée tant que tu n'as pas répondu au point qui l'explique.",
    ]);
    expect(fastTrackLines(en, out)[0]).toContain("Fast track left (5 files or more are touched");
    expect(fastTrackLines(fr, undefined)).toEqual([]);
  });

  it("has a message in both languages for every reason and every hold of the fast track", () => {
    for (const reason of FAST_TRACK_REASONS) {
      expect(isMessageKey(`fast_track.reason.${reason}`), reason).toBe(true);
    }
    for (const hold of ["unverified", "exceeded", "left_open", "stopped"]) {
      expect(isMessageKey(`error.merge_not_ready.${hold}`), hold).toBe(true);
    }
    for (const refusal of FAST_TRACK_REFUSALS) {
      expect(isMessageKey(`error.fast_track_not_possible.${refusal}`), refusal).toBe(true);
    }
  });

  it("gives the line to add when the hook could not be installed", () => {
    const text = formatStoryStart(fr, {
      ...STARTED,
      hook: { status: "manual", path: "/home/ada/hooks", reason: "hooks_path" },
    });
    expect(text).toContain("hors du dossier Git (core.hooksPath)");
    expect(text).toContain(COMMIT_HOOK_LINE);
  });
});

describe("story start's arguments", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await realpath(await mkdtemp(join(tmpdir(), "agentplugged-story-cli-")));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function run(args: string[]) {
    let stdout = "";
    let stderr = "";
    const status = await main({
      argv: args,
      cwd,
      env: {
        AGENTPLUGGED_LANG: "fr",
        AGENTPLUGGED_PRESENCE: "none",
        AGENTPLUGGED_ENVIRONMENT: "none",
        AGENTPLUGGED_KEYCHAIN_SERVICE:
          process.env.AGENTPLUGGED_KEYCHAIN_SERVICE ?? "agentplugged-test-story-cli",
        GIT_CEILING_DIRECTORIES: cwd,
        PATH: process.env.PATH ?? "",
      },
      engineVersion: "1.0.0",
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      stdin: Readable.from([]),
      interactive: false,
    });
    return { status, stdout, stderr };
  }

  it("refuses anything but story start <epic>-<story>", async () => {
    for (const args of [["story"], ["story", "start"], ["story", "stop", "1-1"]]) {
      const result = await run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toContain("story start <epic>-<story>");
    }
    expect((await run(["story", "start", "1-1", "--json"])).status).toBe(1);
  });

  it("needs the method installed", async () => {
    const result = await run(["story", "start", "1-1"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("METHOD_NOT_INSTALLED");
  });
});

describe("the method and the rules", () => {
  it("tells agents to start a story and work only in its worktree", () => {
    const constitution = flat(renderConstitutionReference());
    expect(constitution).toContain("Start a story with `story.start`");
    expect(constitution).toContain("`STORY_NOT_STARTABLE`");
    expect(constitution).toContain("Never skip it (`--no-verify`, `-n`)");
    // The developers' steps are the develop-story skill's, called from their menu.
    expect(flat(read("skills/develop-story/SKILL.md"))).toContain("`story.start`");
    for (const agent of ["sam", "ethan"]) {
      expect(flat(read(`agents/${agent}/agent.yaml`))).toContain("skill: develop-story");
    }
    expect(flat(read("README.md"))).toContain("git commit --no-verify");
  });

  it("keeps the journal's store out of reach, and no longer lists the hook's escape hatch", () => {
    const deny = denyRules({ rootAgentsGenerated: true, claudeMdGenerated: false });
    // The constitution forbids `--no-verify`; no rule does (a barrier, not a guard).
    expect(deny).not.toContain("Bash(git commit*--no-verify*)");
    expect(deny).not.toContain("Bash(git worktree remove*)");
    expect(deny).toContain("Edit(/.git/agentplugged/**)");
    const cursor = cursorDenyRules({ rootAgentsGenerated: true, claudeMdGenerated: false });
    expect(cursor).toContain("Write(.git/agentplugged/**)");
  });
});
