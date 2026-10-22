import { z } from "zod";
import { BriefingDataSchema, BriefingRequestFields } from "./briefing-read.js";
import {
  CODE_ERROR_CODES,
  CodeDiffDataSchema,
  CodeDiffRequestFields,
  CodeEditorDataSchema,
  CodeEditorRequestFields,
  CodePullDataSchema,
  CodePullRequestFields,
  CodePullsDataSchema,
  CodePullsRequestFields,
} from "./code-read.js";
import { CostsDataSchema, CostsRequestFields } from "./costs-read.js";
import {
  DocsListDataSchema,
  DocsListRequestFields,
  DocsRetrosDataSchema,
  DocsRetrosRequestFields,
  DocsTraceDataSchema,
  DocsTraceRequestFields,
} from "./docs-read.js";
import { ULID_PATTERN } from "./event-envelope.js";
import { FindDataSchema, FindRequestFields } from "./find-read.js";
import { ForgeHostSchema } from "./forge-link.js";
import {
  KbAskDataSchema,
  KbAskRequestFields,
  KbListDataSchema,
  KbListRequestFields,
} from "./kb-read.js";
import { LiveContextSchema } from "./noah-context.js";
import { ThreadDataSchema, ThreadRequestFields } from "./noah-thread.js";
import { LiveNoticesSchema } from "./notice.js";
import { FoldersDataSchema, FoldersRequestFields } from "./product-browse.js";
import { readTolerant } from "./tolerant-reader.js";
import { TranscribeDataSchema, TranscribeRequestFields } from "./voice-read.js";

/**
 * Reading the files of a product through its machine's bridge: a device the journal trusts asks
 * for the tree of a folder, the text of a file, a list of branches or the files a branch changed,
 * and the bridge answers on the same end-to-end encrypted channel. The relay only carries bytes.
 *
 * Everything here is pure data and pure rules. What may be read, and what is masked first, is
 * decided by the bridge, never by the asking device.
 *
 * Reading rule: a device ignores the optional fields of an answer it does not know and validates
 * those it knows (`FilesResponseReader`); a request a bridge receives stays strict.
 */

/** The message types of the file reading, carried by peer messages. */
export const FILES_MESSAGE_TYPES = {
  /** A device asks for a tree, a file, a list of branches or a list of changes. */
  request: "files.request",
  /** One part of the answer (an answer is cut into parts when it is larger than one envelope). */
  part: "files.part",
} as const;

/** The version of the request and the answer; a bridge that does not know it ignores the request. */
export const FILES_SCHEMA_VERSION = 1;

/** The longest path, in characters, and the longest one name of a branch. */
export const FILES_PATH_MAX = 1024;
export const FILES_REF_MAX = 200;

/**
 * Where a file is read: the working copy of the product as it is now (uncommitted work included),
 * a branch or a commit of its repository, or the working copy of the story that works on a branch.
 */
export const FilesRefSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("worktree") }),
  z.strictObject({ kind: z.literal("branch"), name: z.string().min(1).max(FILES_REF_MAX) }),
  z.strictObject({ kind: z.literal("commit"), sha: z.string().regex(/^[0-9a-f]{40,64}$/) }),
  z.strictObject({ kind: z.literal("workspace"), branch: z.string().min(1).max(FILES_REF_MAX) }),
]);
export type FilesRef = z.infer<typeof FilesRefSchema>;

const RequestBase = {
  v: z.literal(FILES_SCHEMA_VERSION),
  /** Chosen by the asking device: the answer repeats it. */
  id: z.string().regex(ULID_PATTERN),
  product: z.string().regex(ULID_PATTERN),
};

export const FilesRequestSchema = z.discriminatedUnion("op", [
  /** The entries of a folder; an empty path is the root of the product. */
  z.strictObject({
    ...RequestBase,
    op: z.literal("tree"),
    ref: FilesRefSchema,
    path: z.string().max(FILES_PATH_MAX),
  }),
  /** The text of a file (a binary file is told as such, never shown). */
  z.strictObject({
    ...RequestBase,
    op: z.literal("file"),
    ref: FilesRefSchema,
    path: z.string().min(1).max(FILES_PATH_MAX),
  }),
  /** The bytes of a file, to save: for what is not shown as text. */
  z.strictObject({
    ...RequestBase,
    op: z.literal("download"),
    ref: FilesRefSchema,
    path: z.string().min(1).max(FILES_PATH_MAX),
  }),
  /** The branches of the repository and the working copies of the stories. */
  z.strictObject({ ...RequestBase, op: z.literal("refs") }),
  /** The files `head` changed since its merge base with `base`. */
  z.strictObject({
    ...RequestBase,
    op: z.literal("changes"),
    base: FilesRefSchema,
    head: FilesRefSchema,
  }),
  /**
   * What the agent that works on the product does now, read only: the lines after `after` of the
   * activity the bridge keeps in memory. `epoch` is the one the last answer gave; a bridge that
   * started since, or a cursor it does not know, is answered from the start (`reset`).
   */
  z.strictObject({
    ...RequestBase,
    op: z.literal("live"),
    after: z.number().int().min(0).optional(),
    epoch: z.string().min(1).max(64).optional(),
  }),
  /** The pull requests of the product's repository at its code platform (read only). */
  z.strictObject({ ...RequestBase, ...CodePullsRequestFields }),
  /** One pull request: its checks, its reviews and the remarks anchored in its difference. */
  z.strictObject({ ...RequestBase, ...CodePullRequestFields }),
  /** The difference of a pull request, file by file. */
  z.strictObject({ ...RequestBase, ...CodeDiffRequestFields }),
  /** Where a working copy is on the machine and which editors are there, to open it in one. */
  z.strictObject({ ...RequestBase, ...CodeEditorRequestFields }),
  /** The documents of the product, the status of each requirement, its breakdown and coverage. */
  z.strictObject({ ...RequestBase, ...DocsListRequestFields }),
  /** Everything linked to one requirement: its stories, tests, pull requests and deviations. */
  z.strictObject({ ...RequestBase, ...DocsTraceRequestFields }),
  /** The retrospectives of the product and the lessons in force. */
  z.strictObject({ ...RequestBase, ...DocsRetrosRequestFields }),
  /** The pages of the knowledge base. */
  z.strictObject({ ...RequestBase, ...KbListRequestFields }),
  /** A question put to the knowledge base, answered by the AI tool of the machine with citations. */
  z.strictObject({ ...RequestBase, ...KbAskRequestFields }),
  /** What the product cost: measured, by phase, work, agent, story and sprint. */
  z.strictObject({ ...RequestBase, ...CostsRequestFields }),
  /** The morning briefing, composed by the machine: what waits, in which order, what moved. */
  z.strictObject({ ...RequestBase, ...BriefingRequestFields }),
  /** The creator's voice, transcribed by their own machine: a probe, or one piece of a phrase. */
  z.strictObject({ ...RequestBase, ...TranscribeRequestFields }),
  /** The places of the documents and of the knowledge base that hold the words typed. */
  z.strictObject({ ...RequestBase, ...FindRequestFields }),
  /** The creator's single conversation with Noah, as the tool kept it. */
  z.strictObject({ ...RequestBase, ...ThreadRequestFields }),
  /** The folders inside a place the machine allows products in, to choose where one is made. */
  z.strictObject({ ...RequestBase, ...FoldersRequestFields }),
]);
export type FilesRequest = z.infer<typeof FilesRequestSchema>;

/** Why a request was not answered with data; stable codes the views translate. */
export const FilesErrorCodeSchema = z.enum([
  /** The path, the branch or the commit does not exist. */
  "NOT_FOUND",
  /** The path leaves the product (a `..`, a link, a drive, a network share). */
  "OUTSIDE_PRODUCT",
  /** The file is protected (secrets): it is never sent, only the fact that it is protected. */
  "PROTECTED",
  /** The file is larger than the bridge shows or sends: `size` and `max` say by how much. */
  "TOO_LARGE",
  /** The path is a folder where a file is wanted, or the other way round. */
  "WRONG_KIND",
  /** The request does not mean anything (bad shape, a name git would take for an option). */
  "BAD_REQUEST",
  /** The product is not served by this machine, or its folder cannot be read. */
  "UNAVAILABLE",
  /** Too many requests at once: asked again later. */
  "BUSY",
  /** The code platform could not be read: not linked, no address, refused, unreachable, busy. */
  ...CODE_ERROR_CODES,
]);
export type FilesErrorCode = z.infer<typeof FilesErrorCodeSchema>;

export const FilesEntrySchema = z.strictObject({
  name: z.string().min(1).max(255),
  kind: z.enum(["file", "dir", "link"]),
  /** Bytes; absent for a folder. */
  size: z.number().int().min(0).optional(),
  /** True for a file the bridge never sends (secrets): the name is visible, the content is not. */
  protected: z.literal(true).optional(),
});
export type FilesEntry = z.infer<typeof FilesEntrySchema>;

export const FilesBranchSchema = z.strictObject({
  name: z.string().min(1).max(FILES_REF_MAX),
  sha: z.string().regex(/^[0-9a-f]{40,64}$/),
  /** True for the branch the product's folder is on now. */
  current: z.literal(true).optional(),
  /** True when a working copy of this branch exists on the machine (a story at work). */
  workspace: z.literal(true).optional(),
});
export type FilesBranch = z.infer<typeof FilesBranchSchema>;

export const FilesChangeSchema = z.strictObject({
  status: z.enum(["added", "modified", "deleted", "renamed"]),
  path: z.string().min(1).max(FILES_PATH_MAX),
  /** The old path of a renamed file. */
  from: z.string().min(1).max(FILES_PATH_MAX).optional(),
  protected: z.literal(true).optional(),
});
export type FilesChange = z.infer<typeof FilesChangeSchema>;

/** The most lines of activity one answer carries, the most the bridge keeps, and the longest line. */
export const LIVE_LINES_PER_ANSWER = 100;
export const LIVE_LINES_KEPT = 300;
export const LIVE_LINE_MAX_CHARS = 2000;
/** The most characters of a command that a line shows. */
export const LIVE_COMMAND_MAX_CHARS = 300;
/** The most lines of each kind of action (reads, changes, commands) one run keeps in memory. */
export const LIVE_ACTIONS_PER_RUN = 100;

/**
 * One line of what an agent does. `kind` is a stable code; `text` is plain text the view never
 * interprets: what the agent said (`say`), the name of a tool it called (`tool`, `tool_ok`,
 * `tool_failed`, `denied`) or the outcome code of the run (`end`).
 *
 * Three kinds tell what a call does to the machine: `read` and `edit` carry the path of the file,
 * relative to the agent's working folder, and `command` carries the command; a command's issue
 * (`command_ok`, `command_failed`) has no text and points to its command by `of`. A path that
 * leaves the working folder is never told: the line has `outside` and no text. `protected` marks
 * a file whose content the bridge never shows. `link` says where to read what an `edit` changed:
 * the same references and paths as the file reading (`file`, `changes`). The results of a tool,
 * and the content of files, are never in a line.
 *
 * In a conversation with Noah one more kind appears: `creator`, the creator's own message (plain
 * text, so that their other devices see it). What Noah says is a `say` of the agent `noah`:
 * untrusted text, like any agent's.
 */
export const LiveLineSchema = z.strictObject({
  seq: z.number().int().min(1),
  /** Milliseconds since the epoch, on the bridge's clock. */
  at: z.number().int().min(0),
  agent: z.string().min(1).max(64),
  kind: z.enum([
    "start",
    "say",
    "tool",
    "tool_ok",
    "tool_failed",
    "denied",
    "end",
    "read",
    "edit",
    "command",
    "command_ok",
    "command_failed",
    "creator",
  ]),
  text: z.string().max(LIVE_LINE_MAX_CHARS).optional(),
  /** For a command's issue: the `seq` of the line of the command. */
  of: z.number().int().min(1).optional(),
  /** The path leaves the agent's working folder: it is not told. */
  outside: z.literal(true).optional(),
  /** The file is a secret's: its name is told, its content is never shown. */
  protected: z.literal(true).optional(),
  /** The line comes from a session the creator opened in the tool's own terminal. */
  terminal: z.literal(true).optional(),
  /** For a refused command (`denied`): the command prefix the creator may allow in one gesture. */
  allow: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/ -]{0,98}[A-Za-z0-9]$|^[A-Za-z0-9]$/u)
    .optional(),
  /** For a refused command (`denied`) with nothing to allow: why, as a code a view tells in words. */
  why: z.enum(["runs_anything", "git_folder", "subcommand"]).optional(),
  /** For a change: where its content and its difference can be read. */
  link: z
    .strictObject({
      ref: FilesRefSchema,
      path: z.string().min(1).max(FILES_PATH_MAX),
    })
    .optional(),
});
export type LiveLine = z.infer<typeof LiveLineSchema>;

/** The most sub-agents one answer carries (the bridge keeps the same number). */
export const LIVE_CREW_MAX = 12;
/** The longest task a sub-agent shows. */
export const LIVE_CREW_TASK_MAX_CHARS = 200;

/**
 * One sub-agent Noah launched, as the tool reports it while it works. `durationMs` is the time
 * since it started, on the bridge's clock, at the moment of the answer; a view that shows it keeps
 * counting by itself until the next answer. `tokens` is what the tool itself measured so far
 * (absent until its first measure); `tokenless` says the tool gives no token count for its
 * sub-agents, so a view says so instead of a zero. `costUsd` is worked out by the bridge from the
 * tool's own transcript at the public prices, and absent when the model has no known price.
 * `task` is the sub-agent's own words: untrusted plain text.
 */
export const LiveCrewMemberSchema = z.strictObject({
  id: z.string().min(1).max(128),
  agent: z.string().min(1).max(64).optional(),
  /** The agent of the team that launched this sub-agent, when a sub-agent did (a reader of an agent). */
  parent: z.string().min(1).max(64).optional(),
  /** The tool launched a generic sub-agent, not an agent of the team: it has no name to show. */
  unnamed: z.literal(true).optional(),
  /** It worked when the bridge restarted and its trace stopped: it is told as interrupted. */
  lost: z.literal(true).optional(),
  /**
   * It ended while this many sub-agents it launched still work: its report came before theirs, so
   * it holds none of their results.
   */
  left: z.number().int().min(1).max(LIVE_CREW_MAX).optional(),
  task: z.string().max(LIVE_CREW_TASK_MAX_CHARS).optional(),
  state: z.enum(["working", "done", "failed", "stopped"]),
  durationMs: z.number().int().min(0),
  tokens: z.number().int().min(0).optional(),
  tokenless: z.literal(true).optional(),
  costUsd: z.number().finite().min(0).optional(),
});
export type LiveCrewMember = z.infer<typeof LiveCrewMemberSchema>;

/**
 * Whether the sessions the creator opens in a tool's own terminal can be followed: `listening`
 * (the tool's hook is in the repository), `hook_missing` (it is not: `sync` writes it),
 * `unsupported` (the tool has no such hook yet). A stable code the views tell in the creator's language.
 */
export const LiveTerminalStateSchema = z.enum(["listening", "hook_missing", "unsupported"]);
export type LiveTerminalState = z.infer<typeof LiveTerminalStateSchema>;

/** Where the team of the product stands, as a code the views tell in the creator's language. */
export const LiveChainStateSchema = z.enum(["none", "running", "waiting", "paused", "stopped"]);
export type LiveChainState = z.infer<typeof LiveChainStateSchema>;

/** What an answer carries, by operation. */
export const FilesDataSchema = z.discriminatedUnion("op", [
  CodePullsDataSchema,
  CodePullDataSchema,
  CodeDiffDataSchema,
  CodeEditorDataSchema,
  DocsListDataSchema,
  DocsTraceDataSchema,
  DocsRetrosDataSchema,
  KbListDataSchema,
  KbAskDataSchema,
  FindDataSchema,
  CostsDataSchema,
  BriefingDataSchema,
  TranscribeDataSchema,
  FoldersDataSchema,
  ThreadDataSchema,
  z.strictObject({
    op: z.literal("tree"),
    path: z.string().max(FILES_PATH_MAX),
    entries: z.array(FilesEntrySchema).max(5000),
    /** True when the folder holds more than the bridge lists. */
    truncated: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("file"),
    path: z.string().min(1).max(FILES_PATH_MAX),
    size: z.number().int().min(0),
    /** `text`: shown; `binary`: only offered for download. */
    content: z.enum(["text", "binary"]),
    /** True when the file can be asked for as bytes to save (it is not larger than the bridge sends). */
    downloadable: z.boolean(),
    /** The text, with each line that looked like a secret replaced by `redacted:secret`. */
    text: z.string().optional(),
    /** How many lines were replaced. */
    masked: z.number().int().min(0),
  }),
  z.strictObject({
    op: z.literal("download"),
    path: z.string().min(1).max(FILES_PATH_MAX),
    size: z.number().int().min(0),
    /** The bytes, base64url. */
    bytes: z.string(),
  }),
  z.strictObject({
    op: z.literal("refs"),
    branches: z.array(FilesBranchSchema).max(500),
    truncated: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("changes"),
    files: z.array(FilesChangeSchema).max(5000),
    truncated: z.boolean(),
  }),
  z.strictObject({
    op: z.literal("live"),
    /** Tells one run of the bridge's memory from another: send it back with `next`. */
    epoch: z.string().min(1).max(64),
    /** True when the cursor asked with was not this bridge's: the lines start again from the oldest kept. */
    reset: z.boolean(),
    /** How many lines were lost between the cursor and the first line below (memory is bounded). */
    dropped: z.number().int().min(0),
    /** The cursor to ask with next time. */
    next: z.number().int().min(0),
    /** True when more lines wait: ask again at once. */
    more: z.boolean(),
    chain: LiveChainStateSchema,
    /**
     * Present while the creator holds the whole team: `paused` (the agents finish their step and
     * start nothing) or `stopped` (the emergency stop cut what the bridge started).
     */
    team: z.enum(["paused", "stopped"]).optional(),
    /** Present while notices wait for Noah (a validation he has not read yet) and why. */
    notices: LiveNoticesSchema.optional(),
    /** How heavy Noah's conversation is (tokens the tool reported) and whether a clean one is worth proposing. */
    context: LiveContextSchema.optional(),
    /** The agent that works now, or null. */
    working: z
      .strictObject({
        agent: z.string().min(1).max(64),
        story: z.string().min(1).max(32).optional(),
        tool: z.string().min(1).max(32),
      })
      .nullable(),
    lines: z.array(LiveLineSchema).max(LIVE_LINES_PER_ANSWER),
    /**
     * What Noah is writing now: the words of his unfinished message, secrets masked, cut to the
     * length of a line. Replaced at each answer; gone once the whole message is a line.
     */
    draft: z
      .strictObject({
        agent: z.string().min(1).max(64),
        text: z.string().max(LIVE_LINE_MAX_CHARS),
      })
      .optional(),
    /** True while Noah answers a message: a view that looks closely sees his words as they come. */
    answering: z.literal(true).optional(),
    /** The sub-agents Noah launched that work now, and the ones that just ended. */
    crew: z.array(LiveCrewMemberSchema).max(LIVE_CREW_MAX).optional(),
    /** For each tool, whether its sessions opened in the creator's own terminal can be followed. */
    terminal: z
      .array(
        z.strictObject({
          tool: z.enum(["claude-code", "codex", "antigravity", "cursor"]),
          state: LiveTerminalStateSchema,
        }),
      )
      .max(8)
      .optional(),
    /**
     * Where to go and what to type in a terminal to reopen the conversation of Noah, whose session
     * the machine keeps: present once the machine knows that session and the tool can reopen it.
     */
    handover: z
      .strictObject({
        tool: z.string().min(1).max(32),
        session: z.string().min(1).max(200),
        cwd: z.string().min(1).max(FILES_PATH_MAX),
        command: z.string().min(1).max(300),
      })
      .optional(),
  }),
]);
export type FilesData = z.infer<typeof FilesDataSchema>;

export const FilesResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({
    v: z.literal(FILES_SCHEMA_VERSION),
    id: z.string().regex(ULID_PATTERN),
    product: z.string().regex(ULID_PATTERN),
    ok: z.literal(true),
    /** The commit the answer was read at, or `worktree` for the working copy. */
    at: z.string().max(80),
    /** Milliseconds since the epoch, on the bridge's clock: when it was read. */
    read_at: z.number().int().min(0),
    data: FilesDataSchema,
  }),
  z.strictObject({
    v: z.literal(FILES_SCHEMA_VERSION),
    id: z.string().regex(ULID_PATTERN),
    product: z.string().regex(ULID_PATTERN),
    ok: z.literal(false),
    code: FilesErrorCodeSchema,
    /** For the platform codes: the host of the repository, so that the device can name it. */
    host: ForgeHostSchema.optional(),
    /** For `TOO_LARGE`: the size of the file and what the bridge shows at most. */
    size: z.number().int().min(0).optional(),
    max: z.number().int().min(0).optional(),
  }),
]);
export type FilesResponse = z.infer<typeof FilesResponseSchema>;

/** What a device reads of an answer: unknown optional fields dropped, known ones as strict as above. */
export const FilesDataReader = readTolerant(FilesDataSchema);
export const FilesResponseReader = readTolerant(FilesResponseSchema);
