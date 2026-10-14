import { GENERATED_HEADER_HASH } from "../init/generated.js";
import { isSkipped, skippedList } from "../journey/journey-rules.js";
import type { CommitHookFiles } from "./story-workspace.js";

/**
 * The commit hook of story branches. `commit-msg` is a `sh` script that runs the hook
 * it replaced first (`commit-msg.pre-agentplugged`, when there is one), then, on `feat/*` only,
 * the check: a Node module without dependency kept in the Git folder
 * (`agentplugged/commit-msg.mjs`). On `feat/<id>` or `feat/<id>-…`, the message cites the story
 * and at least one of its requirements, read from `agentplugged/stories/<id>.json`, which
 * `story start` writes from the approved version the branch starts from (never from the working
 * tree an agent edits). Merges, cherry-picks, reverts and rebases pass. The creator skips it with
 * `git commit --no-verify`, which `sync` denies to agents.
 */

/** The hook's name in the hooks folder, and the name a creator's own hook is moved to. */
export const COMMIT_HOOK_NAME = "commit-msg";
export const CHAINED_HOOK_NAME = "commit-msg.pre-agentplugged";

/** Where the check lives, relative to the Git common folder. */
export const COMMIT_CHECK_PATH = "agentplugged/commit-msg.mjs";

/** Where the requirements of each started story live, relative to the Git common folder. */
export const COMMIT_STORIES_DIR = "agentplugged/stories";

/**
 * Where the engine records what the creator skipped that the check reads, relative to
 * the Git common folder: `{ "story_trace": true | ["<id>", …] }`, the stories whose commits need cite
 * no requirement (no PRD, no traceability: nothing to cite). Written by `story start` and when the
 * creator skips or takes up the step.
 */
export const COMMIT_SKIPS_PATH = "agentplugged/skips.json";

/** The line a creator adds to their own `commit-msg` when `story start` cannot chain it (`manual`). */
export const COMMIT_HOOK_LINE = `node "$(git rev-parse --git-common-dir)/${COMMIT_CHECK_PATH}" "$1" || exit 1`;

/**
 * The `commit-msg` hook: the replaced hook first; then, on a `feat/*` branch with a message file,
 * the check (without Node, a warning and the commit goes on: the check cannot run).
 */
export function renderCommitHook(): string {
  return [
    "#!/bin/sh",
    GENERATED_HEADER_HASH,
    "# Story branches (feat/<id>-...): each commit cites its story and one of its requirements.",
    `# The hook this one replaced, if any, runs first (${CHAINED_HOOK_NAME}).`,
    'hooks=$(dirname "$0")',
    `if [ -f "$hooks/${CHAINED_HOOK_NAME}" ]; then`,
    `  "$hooks/${CHAINED_HOOK_NAME}" "$@" || exit $?`,
    "fi",
    '[ -n "$1" ] || exit 0',
    'case "$(git symbolic-ref --short -q HEAD)" in',
    "  feat/*) ;;",
    "  *) exit 0 ;;",
    "esac",
    "if ! command -v node >/dev/null 2>&1; then",
    '  echo "agentplugged: node not found, the story commit check did not run." >&2',
    "  exit 0",
    "fi",
    `exec node "$(git rev-parse --git-common-dir)/${COMMIT_CHECK_PATH}" "$@"`,
    "",
  ].join("\n");
}

/** The check, the same for every story and every workspace of the repository. */
export function renderCommitCheck(): string {
  return String.raw`// ${GENERATED_HEADER_HASH.slice(2)}
// The commit-msg check of story branches (agentplugged): on feat/<id> or feat/<id>-...,
// the message cites the story id and at least one requirement of the story, as recorded in
// agentplugged/stories/<id>.json of the Git folder when the story started. Elsewhere, and during
// a merge, a cherry-pick, a revert or a rebase, every message passes. A story whose traceability the
// creator skipped (agentplugged/skips.json of the Git folder) needs to cite the story only.
// The creator skips it with: git commit --no-verify
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REQUIREMENT = /(?<![A-Za-z0-9_-])(?:EF|ENF|PU|MS|AD)-[1-9]\d*(?!\d)/g;
const AUTO_COMMENT = "#;@!$%^&|:";

const MESSAGES = {
  en: {
    refused: (branch, id, list) =>
      "agentplugged: commit refused on " + branch + ": the message must cite the story " + id +
      " and at least one of its requirements (" + list + ").",
    example: (id, requirement) => "For example: feat(" + id + "): <what changes> (" + requirement + ")",
    any: "EF-n, ENF-n, PU-n, MS-n or AD-n",
  },
  fr: {
    refused: (branch, id, list) =>
      "agentplugged : commit refusé sur " + branch + " : le message doit citer la story " + id +
      " et au moins une de ses exigences (" + list + ").",
    example: (id, requirement) => "Par exemple : feat(" + id + ") : <ce qui change> (" + requirement + ")",
    any: "EF-n, ENF-n, PU-n, MS-n ou AD-n",
  },
};

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function locale() {
  const env = process.env;
  for (const value of [env.AGENTPLUGGED_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const tag = (value ?? "").trim().toLowerCase();
    if (tag === "" || tag === "c" || tag === "posix" || tag.startsWith("c.")) continue;
    return tag.startsWith("fr") ? "fr" : "en";
  }
  return "en";
}

/** The message as Git keeps it: comment lines and what follows the scissors line removed. */
function messageText(raw) {
  const cleanup = (git(["config", "commit.cleanup"]) ?? "default").toLowerCase();
  const strip = cleanup !== "verbatim" && cleanup !== "whitespace";
  const configured = git(["config", "core.commentChar"]) ?? git(["config", "core.commentString"]);
  const comments =
    configured === "auto" ? [...AUTO_COMMENT] : configured ? [configured] : ["#"];
  const lines = [];
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const comment = comments.find((prefix) => line.startsWith(prefix));
    if (comment !== undefined && strip) {
      if (/^ -{24} >8 -{24}$/.test(line.slice(comment.length))) break;
      continue;
    }
    lines.push(line);
  }
  return lines.join("\n");
}

const message = process.argv[2];
if (message === undefined || !existsSync(message)) process.exit(0);
const branch = git(["symbolic-ref", "--short", "-q", "HEAD"]);
const match = branch === undefined ? null : /^feat\/([1-9]\d{0,5}-[1-9]\d{0,5})(?:-|$)/.exec(branch);
if (match === null) process.exit(0);
const id = match[1];
const gitDir = git(["rev-parse", "--absolute-git-dir"]);
for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"]) {
  if (gitDir !== undefined && existsSync(join(gitDir, marker))) process.exit(0);
}

let required;
const common = git(["rev-parse", "--git-common-dir"]);
if (common !== undefined) {
  try {
    const story = JSON.parse(readFileSync(join(resolve(common), "agentplugged", "stories", id + ".json"), "utf8"));
    if (Array.isArray(story.requirements) && story.requirements.length > 0) required = story.requirements;
  } catch {}
}

let traceSkipped = false;
if (common !== undefined) {
  try {
    const skips = JSON.parse(readFileSync(join(resolve(common), "agentplugged", "skips.json"), "utf8"));
    const trace = skips.story_trace;
    traceSkipped = trace === true || (Array.isArray(trace) && trace.includes(id));
  } catch {}
}

const text = messageText(readFileSync(message, "utf8"));
const citesStory = new RegExp("(?<![A-Za-z0-9_-])" + id.replace("-", "\\-") + "(?![A-Za-z0-9_]|-\\d)").test(text);
const cited = [...text.matchAll(REQUIREMENT)].map((m) => m[0]);
const citesRequirement =
  required === undefined ? cited.length > 0 : cited.some((requirement) => required.includes(requirement));
if (citesStory && (citesRequirement || traceSkipped)) process.exit(0);

const messages = MESSAGES[locale()];
const list = required === undefined ? messages.any : [...new Set(required)].join(", ");
process.stderr.write(messages.refused(branch, id, list) + "\n");
process.stderr.write(messages.example(id, required === undefined ? "EF-1" : required[0]) + "\n");
process.exit(1);
`;
}

/**
 * The hook's files, with the requirements of the story it starts (none when only what the creator
 * skipped is refreshed) and what the creator skipped (`skips`: the traceability of every story, or of
 * the stories listed).
 */
export function commitHookFiles(
  story: { readonly id: string; readonly requirements: readonly string[] } | undefined,
  skips?: TraceSkips,
): CommitHookFiles {
  return {
    check: renderCommitCheck(),
    hook: renderCommitHook(),
    marker: GENERATED_HEADER_HASH,
    ...(story === undefined
      ? {}
      : { story: { id: story.id, requirements: [...story.requirements] } }),
    ...(skips === undefined ? {} : { skips: `${JSON.stringify({ story_trace: skips })}\n` }),
  };
}

/** The stories whose commits need no requirement: every story (`true`), or those listed. */
export type TraceSkips = true | readonly string[];

/**
 * What the creator skipped of the commits' traceability: every story when they skipped
 * the PRD, the planning phase or the traceability, else the stories whose traceability they skipped;
 * undefined when nothing is skipped.
 */
export function traceSkipsOf(state: Readonly<Record<string, unknown>>): TraceSkips | undefined {
  if (
    isSkipped(state, "prd") ||
    isSkipped(state, "phase_planning") ||
    isSkipped(state, "story_trace")
  ) {
    return true;
  }
  const stories = skippedList(state)
    .filter((skip) => skip.step === "story_trace" && skip.story !== null)
    .map((skip) => skip.story as string);
  return stories.length === 0 ? undefined : stories;
}
