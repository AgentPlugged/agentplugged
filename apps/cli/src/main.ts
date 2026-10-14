import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ForgeCiReader,
  GitCodeSource,
  GitDocsBase,
  GitForge,
  GitMainBranchReader,
  GitMergeProbe,
  type GitRunner,
  GitStateStore,
  GitStoryDiff,
  GitStoryWorkspace,
  GitTestReferences,
  NodeChatLog,
  NodeCodexUserConfig,
  NodeCommonMemory,
  NodeDecisionLog,
  NodeEnvironmentProbe,
  NodeFolderReader,
  NodeKeyStore,
  NodePresenceAuthenticator,
  NodeRootPinStore,
  NodeWorkspaceFiles,
  type ToolRunner,
} from "@agentplugged/adapters-git";
import {
  NodeEngineUpdates,
  NodeMutationLab,
  NodeProofRunner,
  NodeToolProbe,
  NodeUsageTraces,
} from "@agentplugged/adapters-tools";
import {
  AGENT_ACTIONS,
  type AgentCommandResult,
  AgentPluggedError,
  AgentSession,
  ANTIGRAVITY_UNCHECKED_REASON,
  byOpening,
  type CheckpointState,
  type CiCheckResult,
  type CiSetupResult,
  type CiWaiveResult,
  CODEX_FLAVOR,
  type CodexUserConfig,
  type CommandContext,
  type CostsFound,
  CURSOR_FLAVOR,
  callOf,
  checkCreate,
  checkEngine,
  codexCallOf,
  codexSessionOf,
  createCommandRegistry,
  cursorCallOf,
  cursorSessionOf,
  DEFAULT_PRESET,
  type DeckDrawn,
  type DeferredResult,
  type DetectedTool,
  type DocsCheckResult,
  type DoctorReport,
  type DoctorResult,
  detectGitWorkflow,
  detectTools,
  type EngineCheck,
  type EngineUpdates,
  type EnvironmentProbe,
  type EvalAgent,
  elicitationHookIn,
  guardToolCall,
  type HistoryResult,
  type HistoryRewrittenWarning,
  type HumanAccess,
  type InitAction,
  type InitEntry,
  type InitHumanKey,
  type InitResult,
  type InstallChannel,
  inactiveAgents,
  isPresetId,
  JournalBackup,
  type JournalSyncResult,
  type KeyResult,
  METHOD_CONFIG_PATH,
  type MethodSource,
  type MigrateResult,
  maybeAutoUpdate,
  methodNotInstalled,
  type NextResult,
  PROFILE_PRESET_IDS,
  type PresenceAuthenticator,
  type ProfilePresetId,
  type ProfileResult,
  type ProjectStateResult,
  type PublicationResult,
  questionToolHookIn,
  type ResearchFound,
  type ResearchPlanned,
  type RootPinStore,
  type RulesResult,
  readProfile,
  recordCodexRead,
  recordGitWorkflow,
  recordToolRead,
  resolveEngineCommand,
  resolveProfile,
  reviewNotInteractive,
  type SpecGrowResult,
  type SpecPathResult,
  STATE_CACHE_PATH,
  type StateFileStatus,
  type StoryPullRequestResult,
  type StoryStartResult,
  type SyncAction,
  type SyncResult,
  type SyncWarning,
  statusAt,
  type TargetGroup,
  type TestsSetupResult,
  TOOL_CATALOG,
  type ToolFallback,
  type ToolSource,
  type TraceResult,
  toolName,
  toolsFromDetection,
  type UsageReport,
  unavailablePresence,
  type ValidationEntry,
  validateInstallChannel,
  type WorkspaceFiles,
  writeInstallChannel,
} from "@agentplugged/core";
import {
  createTranslator,
  fallbackReason,
  isMessageKey,
  type Locale,
  type MessageKey,
  resolveLocale,
  type Translate,
} from "@agentplugged/i18n";
import { MCP_SERVER_NAME, runAgentServer } from "@agentplugged/mcp";
import {
  DeferredIdInputSchema,
  DeviationIdInputSchema,
  DeviationReasonSchema,
  ErrorCode,
  type GitWorkflow,
  type IgnoredReason,
  type Profile,
  type ProjectionWarning,
  QUESTION_TOOL_NAME,
  TracedRequirementInputSchema,
} from "@agentplugged/protocol";
import { askCreateAnswers, type CreateAnswers, formatAgentResult } from "./agent-flow.js";
import { runBridgeLauncher } from "./bridge-launcher.js";
import { formatCiSetup, formatStoryCi } from "./ci-text.js";
import { offerCodexTrust } from "./codex-trust-flow.js";
import { deferredJson, formatDeferred } from "./deferred-text.js";
import {
  formatCostsResult,
  formatDeckDrawn,
  formatDocsProblems,
  formatDocsSummary,
  formatResearchResult,
  formatSpecResult,
} from "./docs-text.js";
import { machineStep, runDoctorCommand } from "./environment-flow.js";
import { errorMessage } from "./error-text.js";
import { runEval } from "./eval-flow.js";
import { NO_KEYCHAIN, resolveExportTarget } from "./export-target.js";
import { formatValidationHistory, localDateTime } from "./history-text.js";
import {
  choosePermissionMode,
  chooseTools,
  formatNextStep,
  formatPermissionMode,
} from "./init-flow.js";
import {
  checkExportTarget,
  confirmationAsker,
  formatInitProductKey,
  formatLocalKeyWarning,
  formatProductKey,
  passphraseAsker,
  readExportFile,
  writeExportFile,
} from "./key-flow.js";
import { ENGINE_CHILD_ENV, SESSION_INSTANCE_ENV, SESSION_KEY_ENV } from "./launcher-env.js";
import { canDrawMenus, createMenu, GoBack } from "./menu.js";
import { formatMigrate } from "./migrate-text.js";
import { formatNext, nextJson, nextJsonError } from "./next-text.js";
import { productRootOf } from "./product-root.js";
import {
  chooseInstallMode,
  choosePoints,
  chooseProfile,
  chooseValidationMode,
  formatInstallMode,
  formatPoints,
  formatProfile,
  formatValidationMode,
} from "./profile-flow.js";
import { askYesNo, createPrompter, type Prompter } from "./prompt.js";
import { formatPublicationExported, formatPublicationShown } from "./publication-text.js";
import {
  formatKey,
  formatPresencePrompt,
  presenceUnavailableText,
  runReview,
  UNDO_MS,
} from "./review-flow.js";
import { formatRules, formatSyncRules } from "./rules-text.js";
import { formatStoryPullRequest, formatStoryStart } from "./story-text.js";
import { formatTestsSetup } from "./tests-text.js";
import { formatTrace, traceJson } from "./trace-text.js";
import { runTrustDismiss } from "./trust-flow.js";
import { runUpdate } from "./update-flow.js";
import { formatUsage, usageJson } from "./usage-text.js";
import {
  chooseGitWorkflow,
  formatWorkflowResult,
  hasWorkflowOptions,
  type WorkflowOptions,
  workflowFromOptions,
} from "./workflow-flow.js";

export interface CliEnvironment {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly engineVersion: string;
  /** The installed package's version, read again at each call. */
  readonly installedEngineVersion?: () => Promise<string | undefined>;
  readonly systemLocale?: string;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** Where answers are read from. */
  readonly stdin?: NodeJS.ReadableStream;
  /** True when someone can answer questions (the input is a terminal). */
  readonly interactive?: boolean;
  /** The output stream itself: `mcp` writes the protocol's messages to it. */
  readonly stdoutStream?: NodeJS.WritableStream;
  /** The operating system (`process.platform`): `sync` declares `cmd /c npx` on Windows. */
  readonly platform?: string;
  /**
   * The platform authenticator (Windows Hello) for the `presence` assurance; by default the
   * Windows one, or none when `AGENTPLUGGED_PRESENCE=none`. Tests give a software one.
   */
  readonly presence?: PresenceAuthenticator;
  /** How long `review` waits for `a` before writing (10 s; tests shorten it). */
  readonly undoMs?: number;
  /** The clock (milliseconds). */
  readonly now?: () => number;
  /** Argon2id limits of `key export` (`moderate`; tests shorten it with `min`). */
  readonly passphraseLimits?: "moderate" | "min";
  /**
   * Runs the forge's tool (`gh`, `glab`) for `story pr` and `open_pull_request`;
   * tests give a fake one: never the real tools, never the network.
   */
  readonly forgeTool?: ToolRunner;
  /** Runs the Git commands of `story pr`; tests wrap the real one. */
  readonly forgeGit?: GitRunner;
  /**
   * The engine's updates for `mcp`: by default the registry, the settings and the
   * folders of this machine; tests give a fake one: never the network.
   */
  readonly engineUpdates?: EngineUpdates;
  /**
   * The machine `doctor` and the first step of `init` look at and repair; by default
   * the real one, unless `AGENTPLUGGED_ENVIRONMENT=none`. Tests give a simulated one.
   */
  readonly environmentProbe?: EnvironmentProbe;
  /** Where the root of trust of a product is pinned; `~/.agentplugged/trust` by default. */
  readonly rootPins?: RootPinStore;
  /**
   * Codex's own `config.toml`, where its approval of the project's hooks is recorded;
   * `$CODEX_HOME/config.toml` or `~/.codex/config.toml` by default. Tests give a fake one.
   */
  readonly codexUserConfig?: CodexUserConfig;
  /** The agent `eval run` uses; Claude Code by default. Tests give a fake one: never a real run. */
  readonly evalAgent?: EvalAgent;
}

/** The warning of `--engine-any` when `method.yaml` pins another engine version. */
function engineAnyWarning(environment: CliEnvironment, t: Translate, engine: EngineCheck): string {
  return `${t(engine.older ? "cli.warning.engine_any.older" : "cli.warning.engine_any", {
    path: METHOD_CONFIG_PATH,
    pinned: engine.pinned ?? "",
    engine_version: environment.engineVersion,
  })}\n`;
}

/**
 * Keychain service of the machine key: `agentplugged` (the machine's real entry), unless
 * `AGENTPLUGGED_KEYCHAIN_SERVICE` names another one (tests use a service of their own, deleted
 * afterwards, and never touch the real entry).
 */
function keyStoreOf(env: CliEnvironment["env"]): NodeKeyStore {
  const service = env.AGENTPLUGGED_KEYCHAIN_SERVICE?.trim();
  return new NodeKeyStore(service ? { service } : {});
}

/**
 * The machine-wide lock of key creation, in the home folder of the environment given
 * (`~/.agentplugged/machine-key.lock`): the store's default when it names none.
 */
function keyLockOf(environment: CliEnvironment): { machineLockPath?: string } {
  const home = environment.env.USERPROFILE?.trim() || environment.env.HOME?.trim();
  return home ? { machineLockPath: join(home, ".agentplugged", "machine-key.lock") } : {};
}

/**
 * True when Claude Code's settings (the user's, the project's or the local ones) hold an
 * `Elicitation` or `ElicitationResult` hook that may apply to the `agentplugged` server (story
 * 3.16): such a hook could answer the engine's forms in the creator's place, so the engine asks in
 * the chat instead. A file that cannot be parsed counts as such a hook (caution); a missing file
 * holds none.
 */
function elicitationHookedOf(environment: CliEnvironment): () => Promise<boolean> {
  return settingsHookedOf(environment, (settings) => elicitationHookIn(settings, MCP_SERVER_NAME));
}

/**
 * True when Claude Code's settings (the user's, the project's or the local ones) hold a hook of
 * another maker that could answer the question tool in the creator's place: the engine
 * then does not dictate its questions there. Same reading as `elicitationHookedOf`.
 */
function questionToolHookedOf(environment: CliEnvironment): () => Promise<boolean> {
  return settingsHookedOf(environment, (settings) =>
    questionToolHookIn(settings, QUESTION_TOOL_NAME),
  );
}

/** The settings files of Claude Code, read for a hook `detect` finds; one that cannot be read is one. */
function settingsHookedOf(
  environment: CliEnvironment,
  detect: (settings: unknown) => boolean,
): () => Promise<boolean> {
  const home = environment.env.USERPROFILE?.trim() || environment.env.HOME?.trim() || homedir();
  const paths = [
    join(home, ".claude", "settings.json"),
    join(environment.cwd, ".claude", "settings.json"),
    join(environment.cwd, ".claude", "settings.local.json"),
  ];
  return async () => {
    for (const path of paths) {
      let text: string;
      try {
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
      try {
        if (detect(JSON.parse(text))) return true;
      } catch {
        return true;
      }
    }
    return false;
  };
}

/**
 * The platform authenticator: the one given, none when `AGENTPLUGGED_PRESENCE=none` (tests and
 * CI: never a system prompt), else Windows Hello (unavailable on other systems).
 */
function presenceOf(environment: CliEnvironment): PresenceAuthenticator {
  if (environment.presence !== undefined) return environment.presence;
  if (environment.env.AGENTPLUGGED_PRESENCE?.trim() === "none")
    return unavailablePresence("disabled");
  return new NodePresenceAuthenticator(
    environment.platform === undefined ? {} : { platform: environment.platform },
  );
}

/**
 * The machine `doctor` looks at: the real one, with this run's keychain and Windows
 * Hello; none when `AGENTPLUGGED_ENVIRONMENT=none` (a script that knows its machine, the tests).
 */
function environmentProbeOf(environment: CliEnvironment): EnvironmentProbe | undefined {
  if (environment.environmentProbe !== undefined) return environment.environmentProbe;
  if (environment.env.AGENTPLUGGED_ENVIRONMENT?.trim() === "none") return undefined;
  return new NodeEnvironmentProbe({
    cwd: environment.cwd,
    keys: keyStoreOf(environment.env),
    presence: presenceOf(environment),
    ...(environment.platform === undefined
      ? {}
      : { platform: environment.platform as NodeJS.Platform }),
  });
}

/** The Git side of `story start` and `start_story`, in the current folder. */
function storyWorkspaceOf(environment: CliEnvironment): GitStoryWorkspace {
  return new GitStoryWorkspace({
    cwd: environment.cwd,
    ...(environment.platform === undefined ? {} : { platform: environment.platform }),
  });
}

/** The Git and forge side of `story pr` and `open_pull_request`. */
function storyForgeOf(environment: CliEnvironment): GitForge {
  return new GitForge({
    cwd: environment.cwd,
    ...(environment.forgeTool === undefined ? {} : { tool: environment.forgeTool }),
    ...(environment.forgeGit === undefined ? {} : { run: environment.forgeGit }),
  });
}

/**
 * What `init` and `profile` read of the repository to propose a Git workflow that fits it (story
 * 3.36): its branches, its CI files, its forge. Reads only.
 */
function workflowContext(
  environment: CliEnvironment,
  files: WorkspaceFiles,
): Pick<CommandContext, "files" | "storyWorkspace" | "ciReader" | "storyForge"> {
  return {
    files,
    storyWorkspace: storyWorkspaceOf(environment),
    ciReader: ciReaderOf(environment),
    storyForge: storyForgeOf(environment),
  };
}

/** The CI of `story ci`, `check_ci` and `ci setup`, through `gh` or `glab`. */
function ciReaderOf(environment: CliEnvironment): ForgeCiReader {
  return new ForgeCiReader({ cwd: environment.cwd });
}

/** One prompter for the whole run, created on first use: answers are read once from stdin. */
interface Prompts {
  get(): Prompter;
  close(): void;
}

/**
 * After `init` or `sync` wrote Codex's hooks, offers to approve them for the creator
 * (one question, default no, nothing written without a yes). The text to print, or "".
 */
async function codexTrustNote(
  environment: CliEnvironment,
  t: Translate,
  prompts: Prompts,
  files: WorkspaceFiles,
): Promise<string> {
  const note = await offerCodexTrust({
    t,
    interactive: environment.interactive === true && environment.stdin !== undefined,
    platform: environment.platform ?? process.platform,
    projectRoot: environment.cwd,
    files,
    userConfig:
      environment.codexUserConfig ??
      new NodeCodexUserConfig({
        ...(environment.env.CODEX_HOME === undefined
          ? {}
          : { codexHome: environment.env.CODEX_HOME }),
      }),
    prompter: () => prompts.get(),
  });
  return note === undefined ? "" : `\n${note}\n`;
}

function promptsOf(environment: CliEnvironment): Prompts {
  let prompter: Prompter | undefined;
  return {
    get() {
      if (environment.stdin === undefined) throw new Error("no standard input");
      // Arrows, space and Enter in a real terminal; the numbered questions elsewhere.
      const menu =
        environment.stdoutStream !== undefined &&
        canDrawMenus(environment.stdin, environment.stdoutStream, environment.env)
          ? createMenu(environment.stdin, environment.stdoutStream)
          : undefined;
      prompter ??= createPrompter(environment.stdin, environment.stdout, menu);
      return prompter;
    },
    close() {
      prompter?.close();
      prompter = undefined;
    },
  };
}

/**
 * What the launcher of the MCP server gave this engine: the session's name and the
 * secret of its forms, when they are well formed.
 */
function launcherGiftsOf(env: Readonly<Record<string, string | undefined>>): {
  readonly instance?: string;
  readonly key?: Uint8Array;
} {
  const instance = env[SESSION_INSTANCE_ENV];
  const key = env[SESSION_KEY_ENV];
  return {
    ...(instance === undefined ? {} : { instance }),
    ...(key !== undefined && /^[0-9a-f]{64}$/.test(key) ? { key: Buffer.from(key, "hex") } : {}),
  };
}

/** How long `init` waits for the remote's journal (a clone), and a command for its backup. */
const INIT_PULL_MS = 15_000;
const BACKUP_FLUSH_MS = 5_000;

/**
 * `agentplugged mcp`: the MCP server the agents report through, over stdio only (no network
 * port). It serves until the client closes stdin, waits for the calls in flight, then releases
 * the journal's `git` processes. Nothing but the protocol is written to stdout.
 */
async function runMcp(
  environment: CliEnvironment,
  t: Translate,
  files: WorkspaceFiles,
  engineAny: boolean,
): Promise<number> {
  const stdin = environment.stdin;
  const stdout = environment.stdoutStream;
  if (stdin === undefined || stdout === undefined) {
    environment.stderr(formatError(t, invalidArguments("mcp: no standard input or output")));
    return 1;
  }
  const engine = await checkEngine(files, {
    engineVersion: environment.engineVersion,
    engineAny,
    upgrade: false,
    command: "mcp",
  });
  if (engine instanceof AgentPluggedError) {
    environment.stderr(formatError(t, engine));
    return 1;
  }
  if (engine.overridden) environment.stderr(engineAnyWarning(environment, t, engine));
  // Agents read English: an error carries the message of the `en` catalog.
  const english = createTranslator("en");
  const engineLaunch = await resolveEngineCommand(files);
  const keys = keyStoreOf(environment.env);
  // The journal is saved and shared by the engine itself, in the background: sent
  // after the writes, fetched before the state is read, caught up when this server starts.
  let backup: JournalBackup | undefined;
  const journal = new GitStateStore({
    cwd: environment.cwd,
    keys,
    ...keyLockOf(environment),
    onWrite: () => backup?.noteWrite(),
  });
  const saving = new JournalBackup({ port: journal });
  backup = saving;
  // What the launcher gave this engine: the session's name and the secret of its forms,
  // the same for every engine of the session. Taken out of the environment, with the mark that says
  // this process is an engine: nothing this process starts inherits them (a server it started would
  // be a launcher of its own).
  const given = launcherGiftsOf(environment.env);
  // The server's own process, not a test's environment object.
  if (environment.env === process.env) {
    delete process.env[SESSION_INSTANCE_ENV];
    delete process.env[SESSION_KEY_ENV];
    delete process.env[ENGINE_CHILD_ENV];
  }
  let automatic: (() => void) | undefined;
  const engineUpdates =
    environment.engineUpdates ??
    new NodeEngineUpdates({
      engineVersion: environment.engineVersion,
      cwd: environment.cwd,
      env: environment.env,
      ...(environment.now === undefined ? {} : { now: environment.now }),
      onChecked: () => automatic?.(),
    });
  try {
    // The automatic update (settings `auto`) reads the product's files and the engine's updates only.
    automatic = () => {
      void maybeAutoUpdate({
        files,
        engineVersion: environment.engineVersion,
        engineUpdates,
        actor: "agent",
        ...(environment.now === undefined ? {} : { now: environment.now }),
      } as CommandContext);
    };
    // The registry is asked in the background (at most twice a day): nothing waits for it.
    void engineUpdates.refresh();
    void saving.start();
    await runAgentServer({
      ...(given.key === undefined ? {} : { formStateKey: given.key }),
      registry: createCommandRegistry(),
      context: {
        files,
        journal,
        projectRoot: environment.cwd,
        // `get_state` and `next` say when the journal cannot be saved.
        journalBackup: saving,
        tools: new NodeToolProbe({ env: environment.env }),
        // `check_environment` and the repairs the creator approves in the chat.
        ...(environmentProbeOf(environment) === undefined
          ? {}
          : { environment: environmentProbeOf(environment) as EnvironmentProbe }),
        // The shipped method: a creator's action on agents and the `sync` after it read it.
        method: shippedMethodOrUnavailable(),
        engineVersion: environment.engineVersion,
        ...(environment.installedEngineVersion === undefined
          ? {}
          : { installedEngineVersion: environment.installedEngineVersion }),
        // The engine's updates, and the session's name the launcher keeps across engines.
        engineUpdates,
        session: new AgentSession(Date.now(), given.instance),
        engineAny,
        commandLine: "mcp",
        // The product key: `get_state` and the sensitive files read it.
        keys,
        // The rules in force and the installs mode are read on the main branch.
        mainBranch: new GitMainBranchReader({ cwd: environment.cwd }),
        // `open_checkpoint`: the documents the end of a phase cites are committed.
        docsBase: new GitDocsBase({ cwd: environment.cwd }),
        // `start_story`: the story's branch, worktree and commit hook.
        storyWorkspace: storyWorkspaceOf(environment),
        // `open_pull_request`: the push and the forge's tool.
        storyForge: storyForgeOf(environment),
        // The chat's proof: the creator's messages the Claude Code hook recorded,
        // and whether Claude Code started this server (it sets `CLAUDECODE=1`).
        chat: {
          log: new NodeChatLog(),
          // The creator's answers to Claude Code's question tool, recorded by its hook.
          decisions: new NodeDecisionLog(),
          hooked: environment.env.CLAUDECODE?.trim() === "1",
          project: environment.cwd,
        },
        // The working copies of the stories: an installation written
        // `cd <working copy> && …` is read in that copy's own files, a real folder only.
        folders: new NodeFolderReader(),
        // `read_memory`, `promote_lesson`: the common memory of this machine.
        commonMemory: new NodeCommonMemory(),
        // `measure_usage` and the end of an agent run: what the AI tool traces say.
        usageTraces: new NodeUsageTraces({ root: environment.cwd }),
        // `check_ci`: the CI of a story's pull request, through the forge's tool.
        ciReader: ciReaderOf(environment),
        // `get_trace`: the tests that cite a requirement, through Git.
        testReferences: new GitTestReferences({ cwd: environment.cwd }),
        // `run_proof_command`: the project's commands the creator accepted.
        proofRunner: new NodeProofRunner({ root: environment.cwd }),
        // `review_tests`: the throwaway copy in which the mutation check breaks the code.
        mutationLab: new NodeMutationLab({ root: environment.cwd }),
        // `start_review` and `submit_review`: the diff of a story's branch, through Git.
        storyDiff: new GitStoryDiff({ cwd: environment.cwd }),
        // `start_review` and `submit_review`: the code of the repository at a commit, to prove a duplicate.
        codeSource: new GitCodeSource({ cwd: environment.cwd }),
        // `get_merge_order`, `qualify_merge_conflict` and the merge's checks: what a
        // merge conflicts on and the branch's merges, through Git.
        mergeProbe: new GitMergeProbe({ cwd: environment.cwd }),
        // The `sync` after an approved creator's action adapts the server's launch.
        ...(environment.platform === undefined ? {} : { platform: environment.platform }),
      },
      engineVersion: environment.engineVersion,
      // The journal other machines wrote is fetched before a call, within a short time.
      beforeCall: () => saving.beforeRead(),
      errorText: (error) => errorMessage(english, error),
      // The forms the engine asks in the AI tool are read by the creator, in their
      // language.
      formText: t,
      // A hook of Claude Code that could answer those forms in the creator's place stops them.
      elicitationHooked: elicitationHookedOf(environment),
      questionToolHooked: questionToolHookedOf(environment),
      // A headless run (`sdk-…`) has no person to answer the question tool.
      ...(environment.env.CLAUDE_CODE_ENTRYPOINT === undefined
        ? {}
        : { entrypoint: environment.env.CLAUDE_CODE_ENTRYPOINT }),
      // The launcher of this machine, in the texts the agents read.
      ...(engineLaunch === undefined ? {} : { engineCommand: engineLaunch }),
      stdin: stdin as Readable,
      stdout: stdout as Writable,
      onerror: (error) => environment.stderr(`${error.message}\n`),
    });
  } finally {
    // What was written in the last seconds is sent before the server stops (at most 5 s).
    await saving.close().catch(() => {});
    journal.close();
  }
  return 0;
}

/**
 * A path as the file system names it: Windows short names (`AGENTP~1`), junctions and
 * links settled, through the longest part that exists (a file about to be written does not yet).
 * The rules are tried on this form too: `AGENTP~1\\METHOD~1.YAM` is `method.yaml`.
 */
export function canonicalPath(root: string, home: string): (path: string) => string {
  return (path) => {
    let text = path.trim();
    if (/^file:/i.test(text)) text = fileURLToPath(text);
    if (text === "~" || text.startsWith("~/") || text.startsWith("~\\"))
      text = join(home, text.slice(1));
    let head = isAbsolute(text) ? text : join(root, text);
    let tail = "";
    for (let level = 0; level < 64; level++) {
      try {
        return join(realpathSync.native(head), tail);
      } catch {
        const parent = dirname(head);
        if (parent === head) break;
        tail = join(basename(head), tail);
        head = parent;
      }
    }
    return path;
  };
}

/** Everything that arrives on standard input, as text. */
async function readAll(stream: NodeJS.ReadableStream | undefined): Promise<string> {
  if (stream === undefined) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

/** The conversation id of Antigravity's hook input (or its environment): what the journal keeps reads under. */
function conversationOf(input: unknown, env: CliEnvironment["env"]): string | undefined {
  const given = (input as { conversationId?: unknown } | null)?.conversationId;
  const id =
    typeof given === "string" ? given.trim() : (env.ANTIGRAVITY_CONVERSATION_ID ?? "").trim();
  return /^[0-9a-f-]{8,64}$/i.test(id) ? id : undefined;
}

/**
 * `agentplugged hook antigravity|codex|cursor pre-tool|post-tool`: the handlers of Antigravity CLI's
 * plugin hooks and of the project hooks of Codex and of Cursor that need the
 * engine. The tool, or its script (Codex's and Cursor's: `tool_name` or `command`, `session_id`),
 * sends the hook's input as JSON on standard input and reads a JSON answer on standard output.
 * `pre-tool` answers a decision (`allow`, `ask` or `deny`)
 * for the tool call, from the product's rules; `post-tool` records a read of external content and
 * answers `{}`. Always exits 0 with a JSON answer: a call the engine cannot check is denied, never
 * let through. Nothing but the answer is written to standard output.
 */
async function runHook(
  environment: CliEnvironment,
  t: Translate,
  rest: readonly string[],
): Promise<number> {
  const [tool, event, ...extra] = rest;
  const pre = event === "pre-tool";
  if (
    (tool !== "antigravity" && tool !== "codex" && tool !== "cursor") ||
    (!pre && event !== "post-tool") ||
    extra.length > 0
  ) {
    environment.stderr(formatError(t, invalidArguments(`hook: ${rest.join(" ") || "(nothing)"}`)));
    return 1;
  }
  const answer = (value: unknown) => environment.stdout(`${JSON.stringify(value)}\n`);
  const unchecked = () => answer({ decision: "deny", reason: ANTIGRAVITY_UNCHECKED_REASON });
  const root = productRootOf(environment.cwd);
  const home = environment.env.USERPROFILE?.trim() || environment.env.HOME?.trim() || homedir();
  const keys = keyStoreOf(environment.env);
  const journal = new GitStateStore({ cwd: root, keys, ...keyLockOf(environment) });
  try {
    const input: unknown = JSON.parse(await readAll(environment.stdin));
    const codex = tool === "codex";
    const cursor = tool === "cursor";
    const call = cursor ? cursorCallOf(input) : codex ? codexCallOf(input) : callOf(input);
    const conversation = cursor
      ? cursorSessionOf(input)
      : codex
        ? codexSessionOf(input)
        : conversationOf(input, environment.env);
    if (call === undefined) {
      if (pre) unchecked();
      else answer({});
      return 0;
    }
    const context = {
      files: new NodeWorkspaceFiles(root),
      journal,
      tools: new NodeToolProbe({ env: environment.env }),
      method: shippedMethodOrUnavailable(),
      engineVersion: environment.engineVersion,
      engineAny: true,
      commandLine: "hook",
      keys,
      mainBranch: new GitMainBranchReader({ cwd: root }),
      docsBase: new GitDocsBase({ cwd: root }),
      // Where an installation is read from: the product's folder.
      chat: { project: root },
      actor: "agent" as const,
      ...(environment.platform === undefined ? {} : { platform: environment.platform }),
    };
    if (pre) {
      const place = { root, home, resolve: canonicalPath(root, home) };
      const decision = await guardToolCall(context, call, {
        place,
        conversation,
        ...(codex ? { flavor: CODEX_FLAVOR } : cursor ? { flavor: CURSOR_FLAVOR } : {}),
      });
      // A rule that asks must ask: `ask` honours a permission the creator once gave for good, and
      // `force_ask` never does (Codex's and Cursor's scripts answer `ask` themselves: Codex's lets it
      // through, Cursor's asks for a command only).
      answer(
        decision.decision === "ask" && !codex && !cursor
          ? { ...decision, decision: "force_ask" }
          : decision,
      );
    } else {
      if (codex) await recordCodexRead(context, input, conversation);
      else await recordToolRead(context, call, conversation);
      answer({});
    }
  } catch {
    if (pre) unchecked();
    else answer({});
  } finally {
    journal.close();
  }
  return 0;
}

const ACTION_KEYS = {
  created: "init.action.created",
  updated: "init.action.updated",
  unchanged: "init.action.unchanged",
} as const satisfies Record<InitAction, string>;

const SYNC_ACTION_KEYS = {
  created: "sync.action.created",
  updated: "sync.action.updated",
  unchanged: "sync.action.unchanged",
  deleted: "sync.action.deleted",
} as const satisfies Record<SyncAction, string>;

const SYNC_WARNING_KEYS = {
  overwritten: "sync.warning.overwritten",
  conflict: "sync.warning.conflict",
  kept: "sync.warning.kept",
  description_too_long: "sync.warning.description_too_long",
  unknown_setting: "sync.warning.unknown_setting",
  local_engine: "sync.warning.local_engine",
} as const satisfies Record<SyncWarning["kind"], string>;

/** Stands for the shipped method in commands that never read it. */
const METHOD_UNAVAILABLE: MethodSource = {
  listFiles: () => Promise.reject(new Error("the shipped method is not available here")),
  readText: () => Promise.reject(new Error("the shipped method is not available here")),
  readBytes: () => Promise.reject(new Error("the shipped method is not available here")),
};

/**
 * Folder of the method shipped with the engine: `dist/method/`, copied there by the build of the
 * published package, or else the `@agentplugged/method` package of the monorepo (development).
 */
export function methodRoot(): string {
  const bundled = fileURLToPath(new URL("method/", import.meta.url));
  if (existsSync(bundled)) return bundled;
  return dirname(createRequire(import.meta.url).resolve("@agentplugged/method/package.json"));
}

/** The shipped method when it can be located, else `METHOD_UNAVAILABLE`. */
function shippedMethodOrUnavailable(): MethodSource {
  try {
    return new NodeWorkspaceFiles(methodRoot());
  } catch {
    return METHOD_UNAVAILABLE;
  }
}

/** Options that only change how the engine version is checked: left out of the quoted command. */
const ENGINE_FLAGS = new Set(["--engine-any", "--upgrade-engine"]);

/**
 * The command as typed, for `npx agentplugged@<version> <command>`. An argument with other
 * characters is single-quoted: no `$` or backtick is expanded by bash, zsh or PowerShell.
 */
export function commandLine(argv: readonly string[]): string {
  return argv
    .filter((arg) => !ENGINE_FLAGS.has(arg))
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", "'\\''")}'`))
    .join(" ");
}

/** Language: AGENTPLUGGED_LANG, then the system language, then English. */
export function localeOf(env: CliEnvironment["env"], systemLocale?: string) {
  return resolveLocale([
    env.AGENTPLUGGED_LANG,
    env.LC_ALL,
    env.LC_MESSAGES,
    env.LANG,
    systemLocale,
  ]);
}

/** One line per path, its label padded so the paths line up. */
function formatLines(labels: readonly string[], paths: readonly string[]): string[] {
  const width = Math.max(0, ...labels.map((label) => label.length));
  return paths.map((path, i) => `  ${(labels[i] ?? "").padEnd(width)}  ${path}`);
}

function formatSummary(t: Translate, root: string, entries: readonly InitEntry[]): string {
  const labels = entries.map((entry) => t(ACTION_KEYS[entry.action]));
  const lines = formatLines(
    labels,
    entries.map((entry) => entry.path),
  );
  return `${t("init.summary.title", { root })}\n${lines.join("\n")}\n`;
}

/** Order and title of the summary's groups. Product names are never translated. */
const SYNC_GROUPS: readonly TargetGroup[] = [
  "shared",
  "claude-code",
  "codex",
  "antigravity",
  "cursor",
];

function groupTitle(t: Translate, group: TargetGroup): string {
  if (group === "shared") return t("sync.group.shared");
  if (group === "antigravity") return "Antigravity CLI + Gemini CLI";
  return TOOL_CATALOG.find((spec) => spec.id === group)?.name ?? group;
}

/**
 * A fallback in the creator's language. In English, the matrix reason is shown as is: it is the
 * single English text, also copied into the constitution.
 */
function formatFallback(t: Translate, locale: Locale, fallback: ToolFallback): string {
  const capabilityKey = `sync.capability.${fallback.capability}`;
  return t("sync.fallback.line", {
    name: fallback.name,
    capability: isMessageKey(capabilityKey) ? t(capabilityKey) : fallback.capability,
    reason: fallbackReason(locale, fallback.id, fallback.reason, fallback.params),
  });
}

/**
 * What `sync` did, tool by tool and file by file, then its warnings, the fallbacks of the
 * targeted tools and, when Codex is targeted, the trust reminder.
 */
export function formatSync(
  t: Translate,
  root: string,
  result: SyncResult,
  locale: Locale = "en",
): string {
  const labels = result.entries.map((entry) => t(SYNC_ACTION_KEYS[entry.action]));
  const width = Math.max(0, ...labels.map((label) => label.length));
  const lines: string[] = [];
  for (const group of SYNC_GROUPS) {
    const indexes = result.entries.flatMap((entry, i) => (entry.group === group ? [i] : []));
    if (indexes.length === 0) continue;
    lines.push(groupTitle(t, group));
    for (const i of indexes) {
      lines.push(`  ${(labels[i] ?? "").padEnd(width)}  ${result.entries[i]?.path ?? ""}`);
    }
  }
  let text = `${t("sync.summary.title", { root })}\n${lines.join("\n")}\n`;
  if (result.preferredTools.length > 0) {
    const preferred = result.preferredTools.map(
      (entry) => `  ${t("sync.preferred.line", { name: entry.name, tool: toolName(entry.tool) })}`,
    );
    text += `\n${t("sync.preferred.title")}\n${preferred.join("\n")}\n`;
  }
  // A preferred tool outside `tools`: the agent is generated for the other tools only.
  const untargeted = result.preferredTools.filter((entry) => !entry.targeted);
  if (result.warnings.length > 0 || untargeted.length > 0) {
    const warnings = [
      ...result.warnings.map(
        (warning) =>
          `  ${t(SYNC_WARNING_KEYS[warning.kind], { path: warning.path, id: warning.id ?? "" })}`,
      ),
      ...untargeted.map(
        (entry) =>
          `  ${t("sync.warning.preferred_untargeted", {
            id: entry.id,
            name: entry.name,
            tool: toolName(entry.tool),
          })}`,
      ),
    ];
    text += `\n${t("sync.warnings.title")}\n${warnings.join("\n")}\n`;
  }
  if (result.fallbacks.length > 0) {
    const fallbacks = result.fallbacks.map(
      (fallback) => `  ${formatFallback(t, locale, fallback)}`,
    );
    text += `\n${t("sync.fallbacks.title")}\n${fallbacks.join("\n")}\n`;
  }
  text += formatSyncRules(t, result.rules);
  if (result.codexTrustReminder) text += `\n${t("sync.codex_trust")}\n`;
  if (result.cursorHooksReminder) text += `\n${t("sync.cursor_hooks")}\n`;
  return text;
}

/** What `sync` did when `init` ran it: a line, then what needs the creator's eye. */
function formatSyncCompact(t: Translate, result: SyncResult): string {
  const written = result.entries.filter((entry) => entry.action !== "unchanged").length;
  const lines = [t("init.sync.done", { count: written })];
  for (const warning of result.warnings) {
    lines.push(
      `  ${t(SYNC_WARNING_KEYS[warning.kind], { path: warning.path, id: warning.id ?? "" })}`,
    );
  }
  if (result.codexTrustReminder) lines.push("", t("sync.codex_trust"));
  if (result.cursorHooksReminder) lines.push("", t("sync.cursor_hooks"));
  return `${lines.join("\n")}\n`;
}

function formatSource(t: Translate, source: ToolSource): string {
  switch (source.kind) {
    case "command":
      return t("tools.source.command", { command: source.command });
    case "extension":
      return t(`tools.source.extension.${source.editor}`);
    case "editor":
      return t("tools.source.editor", { command: source.command });
  }
}

/** The "AI tools" section: one line per tool, then how the method drives it. */
export function formatTools(t: Translate, tools: readonly DetectedTool[]): string {
  const lines = [t("tools.title")];
  for (const tool of tools) {
    if (!tool.found) {
      lines.push(`  ${t("tools.not_found", { name: tool.name })}`);
      continue;
    }
    const sources = tool.sources.map((source) => formatSource(t, source)).join(", ");
    lines.push(
      `  ${
        tool.version === undefined
          ? t("tools.line.unknown_version", { name: tool.name, sources })
          : t("tools.line", { name: tool.name, version: tool.version, sources })
      }`,
    );
    const drive = t("tools.drive", { files: tool.driveFiles.join(" + ") });
    const command = TOOL_CATALOG.find((spec) => spec.id === tool.id)?.commands[0] ?? tool.id;
    const note = t("tools.bridge_note", { command });
    lines.push(`    ${tool.cliMissingForBridge ? `${drive} ${note}` : drive}`);
  }
  if (!tools.some((tool) => tool.found)) lines.push("", t("tools.none"));
  return `${lines.join("\n")}\n`;
}

/**
 * What `journal sync` did: already up to date, or the events received (fast-forward or merge)
 * and sent (and the remote branch created by the first push).
 */
export function formatJournalSync(t: Translate, result: JournalSyncResult): string {
  const { remote, integration, received, sent, created } = result;
  if (result.empty) return `${t("journal.sync.empty", { remote })}\n`;
  if (integration === "none" && received === 0 && sent === 0) {
    return `${t("journal.sync.up_to_date", { remote })}\n`;
  }
  const how =
    integration === "none"
      ? ""
      : ` (${t(integration === "merge" ? "journal.sync.merge" : "journal.sync.fast_forward")})`;
  const createdNote = created ? ` (${t("journal.sync.created", { remote })})` : "";
  return [
    t("journal.sync.title", { remote }),
    `  ${t("journal.sync.received", { count: received })}${how}`,
    `  ${t("journal.sync.sent", { count: sent })}${createdNote}`,
    "",
  ].join("\n");
}

const IGNORED_KEYS = {
  unknown_signer: "journal.ignored.unknown_signer",
  bad_signature: "journal.ignored.bad_signature",
  broken_chain: "journal.ignored.broken_chain",
  wrong_product: "journal.ignored.wrong_product",
  invalid: "journal.ignored.invalid",
  key_conflict: "journal.ignored.key_conflict",
  product_conflict: "journal.ignored.product_conflict",
  test_type: "journal.ignored.test_type",
  checkpoint_id_collision: "journal.ignored.checkpoint_id_collision",
  not_human: "journal.ignored.not_human",
  already_resolved: "journal.ignored.already_resolved",
  unendorsed_human: "journal.ignored.unendorsed_human",
  checkpoint_unknown: "journal.ignored.checkpoint_unknown",
  decrypt_failed: "journal.ignored.decrypt_failed",
  key_proof_invalid: "journal.ignored.key_proof_invalid",
  sensitive_in_clear: "journal.ignored.sensitive_in_clear",
  unexpected_encryption: "journal.ignored.unexpected_encryption",
  unsupported_alg: "journal.ignored.unsupported_alg",
  not_reopenable: "journal.ignored.not_reopenable",
  untrusted_authorization: "journal.ignored.untrusted_authorization",
  device_revoked: "journal.ignored.device_revoked",
  dismissed: "journal.ignored.dismissed",
} as const satisfies Record<IgnoredReason, string>;

/** A warning of `state.json`, in the creator's language. */
function formatProjectionWarning(t: Translate, warning: ProjectionWarning): string {
  switch (warning.code) {
    case "chain_fork":
      return t("journal.warning.chain_fork", {
        device: warning.device,
        ids: warning.ids.join(", "),
      });
    case "checkpoint_id_collision":
      return t("journal.warning.checkpoint_id_collision", {
        checkpoint: warning.checkpoint,
        ids: warning.ids.join(", "),
      });
    case "locale_on_high_risk":
      return t("journal.warning.locale_on_high_risk", {
        checkpoint: warning.checkpoint,
        id: warning.id,
      });
    default:
      return t("journal.warning.checkpoint_weak_payload", {
        checkpoint: warning.checkpoint,
        id: warning.id,
        fields: warning.fields.join(", "),
      });
  }
}

/**
 * The open checkpoints, in opening order: id and title, then type, risk, story, recipient and
 * verdict, so the creator sees what waits for them.
 */
function formatOpenCheckpoints(
  t: Translate,
  state: Readonly<Record<string, unknown>>,
  now: number,
): string[] {
  const all = Object.values((state.checkpoints ?? {}) as Record<string, CheckpointState>);
  // A waiver past its deadline by the clock: open again (state.json only records the deadline).
  const open = all.filter((checkpoint) => statusAt(checkpoint, now) === "open").sort(byOpening);
  if (open.length === 0) return [];
  const label = (key: string) => (isMessageKey(key) ? t(key) : key);
  const lines = ["", t("journal.status.checkpoints", { count: open.length })];
  for (const checkpoint of open) {
    lines.push(
      `  ${t("journal.status.checkpoint_line", { id: checkpoint.id, title: checkpoint.title })}`,
    );
    const details = [
      label(`checkpoint.type.${checkpoint.type}`),
      label(`checkpoint.risk.${checkpoint.risk}`),
      ...(checkpoint.story === null
        ? []
        : [t("journal.status.checkpoint_story", { story: checkpoint.story })]),
      t("journal.status.checkpoint_recipient", {
        recipient: label(`checkpoint.role.${checkpoint.recipient_role}`),
      }),
      ...(checkpoint.verdict === null
        ? []
        : [
            t("journal.status.checkpoint_verdict", {
              verdict: label(`checkpoint.verdict.${checkpoint.verdict.result}`),
            }),
          ]),
      ...(checkpoint.status === "waived"
        ? [
            t("journal.status.checkpoint_waiver_expired", {
              date: localDateTime(checkpoint.resolution?.waiver_until ?? ""),
            }),
          ]
        : []),
    ];
    lines.push(`    ${details.join(", ")}`);
  }
  return lines;
}

/**
 * The creator's answers, in projection order: checkpoint, decision, assurance (`locale` said as
 * such), author and date.
 */
function formatValidations(t: Translate, state: Readonly<Record<string, unknown>>): string[] {
  const validations = (state.validations ?? []) as ValidationEntry[];
  if (validations.length === 0) return [];
  const lines = ["", t("journal.status.validations", { count: validations.length })];
  for (const validation of validations) {
    lines.push(
      `  ${t("journal.status.validation_line", {
        checkpoint: validation.checkpoint,
        decision: t(`review.decision.${validation.decision}` as MessageKey),
        assurance: t(`assurance.${validation.assurance}` as MessageKey),
        author: validation.author,
        at: localDateTime(validation.at),
      })}`,
    );
  }
  return lines;
}

const FILE_KEYS = {
  written: "journal.status.file.written",
  unchanged: "journal.status.file.unchanged",
  not_installed: "journal.status.file.not_installed",
} as const satisfies Record<StateFileStatus, string>;

/** A history rewritten: without a count when nothing is known of what was lost, or nothing was. */
function formatHistory(t: Translate, warning: HistoryRewrittenWarning): string {
  const { missing } = warning;
  if (warning.unknown || missing === 0) return t("journal.warning.history_rewritten");
  if (missing === 1) return t("journal.warning.history_rewritten.one");
  return t("journal.warning.history_rewritten.other", { missing });
}

/**
 * What `journal status` shows: the product, the number of devices and of events applied, then
 * the events ignored with their reason, the warnings (this machine's first), and what became of
 * `state.json`.
 */
export function formatJournalStatus(
  t: Translate,
  result: ProjectStateResult,
  now: number = Date.now(),
): string {
  const { state } = result;
  const lines = [
    t("journal.status.title"),
    `  ${
      state.product === null
        ? t("journal.status.no_product")
        : t("journal.status.product", { product: state.product })
    }`,
    `  ${t("journal.status.devices", { count: state.devices.length })}`,
    `  ${t("journal.status.humans", { count: Object.keys((state.state.humans ?? {}) as object).length })}`,
    `  ${t("journal.status.applied", { count: state.applied })}`,
  ];
  if (state.ignored.length > 0) {
    lines.push("", t("journal.status.ignored", { count: state.ignored.length }));
    for (const entry of state.ignored) {
      const reason = t(IGNORED_KEYS[entry.reason]);
      lines.push(`  ${t("journal.status.ignored_line", { id: entry.id, reason })}`);
    }
  }
  const warnings = [
    ...result.warnings.map((warning) =>
      warning.code === "history_rewritten"
        ? formatHistory(t, warning)
        : formatLocalKeyWarning(t, warning),
    ),
    ...state.warnings.map((warning) => formatProjectionWarning(t, warning)),
  ];
  if (warnings.length > 0) {
    lines.push("", t("journal.status.warnings"));
    for (const warning of warnings) lines.push(`  ${warning}`);
  }
  lines.push(...formatOpenCheckpoints(t, state.state, now));
  lines.push(...formatValidations(t, state.state));
  lines.push("", t(FILE_KEYS[result.file], { path: STATE_CACHE_PATH }));
  return `${lines.join("\n")}\n`;
}

function formatError(t: Translate, error: AgentPluggedError): string {
  const message = errorMessage(t, error);
  return `${t("cli.error", { code: error.code, message })}\n`;
}

interface ProfileDecision {
  /** Profile to record; undefined when init keeps the recorded one. */
  readonly profile: Profile | undefined;
  /** Lines printed above the profile section. */
  readonly notes: readonly string[];
}

/**
 * Decides the profile before anything is written: `--profile`, or the questions when someone can
 * answer them. When nobody can, `init` applies the default preset (announced) and `profile`
 * fails: it needs `--profile`.
 */
async function decideProfile(
  environment: CliEnvironment,
  t: Translate,
  prompts: Prompts,
  command: "init" | "profile",
  recorded: Profile | undefined,
  option: ProfilePresetId | undefined,
): Promise<ProfileDecision> {
  if (command === "init" && recorded !== undefined) {
    const told = option !== undefined || environment.interactive === true;
    return { profile: undefined, notes: told ? [t("profile.already_set")] : [] };
  }
  if (option !== undefined) return { profile: resolveProfile(option), notes: [] };
  if (environment.interactive && environment.stdin) {
    const profile = await chooseProfile(t, prompts.get(), recorded);
    environment.stdout("\n");
    return { profile, notes: [] };
  }
  // `profile` exists to change the profile: without anyone to ask, the preset must be given.
  if (command === "profile") {
    throw new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.profile_required", {
      presets: PROFILE_PRESET_IDS.join(", "),
    });
  }
  const profile = resolveProfile(DEFAULT_PRESET);
  const preset = t(`profile.preset.${profile.preset}`);
  return { profile, notes: [t("profile.default_applied", { preset })] };
}

/** What `init` and `profile` take besides the profile's own options. */
interface WizardExtras {
  /** `--tools a,b`: the AI tools to target (init only), checked by core. */
  readonly tools: string | undefined;
  /** `--permissions protected|free`, checked by core. */
  readonly permissions: string | undefined;
  /** The AI tools on the machine, looked for only when a question needs them. */
  readonly detect: () => Promise<readonly DetectedTool[]>;
}

/**
 * Runs the questions in order; Escape in a menu goes back to the question before (the first one
 * leaves, before anything is written).
 */
async function runSteps(steps: ReadonlyArray<() => Promise<void>>): Promise<void> {
  let index = 0;
  while (index < steps.length) {
    try {
      await (steps[index] as () => Promise<void>)();
      index += 1;
    } catch (error) {
      if (!(error instanceof GoBack)) throw error;
      if (index === 0) throw new AgentPluggedError(ErrorCode.CANCELLED, "error.cancelled");
      index -= 1;
    }
  }
}

async function runWithProfile(
  environment: CliEnvironment,
  t: Translate,
  prompts: Prompts,
  command: "init" | "profile",
  files: WorkspaceFiles,
  option: ProfilePresetId | undefined,
  /** `--validation <level>`, checked by core. */
  validation: string | undefined,
  /** `--installs <mode>`, checked by core. */
  installs: string | undefined,
  /** `--points <list>`: the points that wait for the creator, checked by core. */
  points: string | undefined,
  /** `--workflow`, `--branches`, `--story-branches`, `--ci`, `--merge`, `--review`. */
  workflowOptions: WorkflowOptions,
  extras: WizardExtras,
): Promise<{ input: Record<string, unknown>; notes: readonly string[] } | AgentPluggedError> {
  const state = await readProfile(files);
  if (state instanceof AgentPluggedError) return state;
  if (command === "profile" && !state.installed) return methodNotInstalled();
  // `profile --validation <level>`, `--installs <mode>`, `--points <list>`, `--permissions <mode>` or
  // an option of the Git workflow alone changes that setting only: no question on the profile.
  const workflowGiven = hasWorkflowOptions(workflowOptions);
  const levelOnly =
    command === "profile" &&
    (validation !== undefined ||
      installs !== undefined ||
      points !== undefined ||
      workflowGiven ||
      extras.permissions !== undefined) &&
    option === undefined;
  const someoneAnswers = environment.interactive === true && environment.stdin !== undefined;
  let decision: ProfileDecision = { profile: undefined, notes: [] };
  // The validation level: given, or asked when someone answers and the questions
  // are asked (`profile`, or a first `init`), `chat` by default; never asked again by `init`.
  let level = validation;
  // The installs mode: given, or asked in the same cases as the level. Without a
  // terminal nothing is recorded: `validate`, the safe default, applies until the creator chooses
  // (`profile --installs <mode>`, or in the chat).
  let installsMode = installs;
  // The points that wait for the creator: given (`--points framing,architecture`,
  // `--points none`), or asked in the same cases, the defaults proposed. Without a terminal nothing is
  // recorded: every point waits for the creator until they choose (`profile --points`, or in the chat).
  let chosenPoints: string[] | undefined =
    points === undefined
      ? undefined
      : points.trim().toLowerCase() === "none"
        ? []
        : points
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry !== "");
  // The Git workflow: given by its options, or asked in the same cases (a first `init`
  // not yet answered, a bare `profile`), what the product already does proposed as the default.
  // Without a terminal nothing is recorded: the recommendation applies until the creator chooses
  // (`profile --workflow recommended`, or in the chat).
  let workflow: GitWorkflow | undefined;
  let workflowError: AgentPluggedError | undefined;
  // The AI tools (a first `init` only: afterwards the list is the creator's), and what
  // their tool asks before it acts (only when Claude Code is one of them).
  let tools: string[] | undefined =
    extras.tools === undefined
      ? undefined
      : extras.tools
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "");
  let permissionsMode = extras.permissions;

  // A setting given by an option is never asked again, nor replaced by the answer: `profile
  // --installs visible` alone changes that setting only.
  const asked = () =>
    option === undefined &&
    someoneAnswers &&
    (command === "profile"
      ? validation === undefined &&
        installs === undefined &&
        points === undefined &&
        !workflowGiven &&
        extras.permissions === undefined
      : decision.profile !== undefined && state.validation === undefined);

  const steps: Array<() => Promise<void>> = [];
  if (
    command === "init" &&
    someoneAnswers &&
    option === undefined &&
    !state.installed &&
    tools === undefined
  ) {
    steps.push(async () => {
      tools = await chooseTools(t, prompts.get(), await extras.detect());
      environment.stdout("\n");
    });
  }
  steps.push(async () => {
    decision = levelOnly
      ? { profile: undefined, notes: [] }
      : await decideProfile(environment, t, prompts, command, state.profile, option);
  });
  steps.push(async () => {
    if (asked() && validation === undefined) {
      level = await chooseValidationMode(t, prompts.get(), state.validation);
      environment.stdout("\n");
    }
  });
  steps.push(async () => {
    if (asked() && installs === undefined) {
      installsMode = await chooseInstallMode(t, prompts.get(), state.installs);
      environment.stdout("\n");
    }
  });
  steps.push(async () => {
    if (asked() && points === undefined) {
      chosenPoints = await choosePoints(t, prompts.get(), state.points);
      environment.stdout("\n");
    }
  });
  steps.push(async () => {
    if (workflowGiven || (asked() && (command === "profile" || state.git === undefined))) {
      const detected = await detectGitWorkflow(workflowContext(environment, files));
      if (workflowGiven) {
        const given = workflowFromOptions(workflowOptions, {
          current: state.git,
          forge: detected.facts.forge,
          main: detected.facts.main ?? "main",
        });
        if (typeof given === "string") workflowError = invalidArguments(given);
        else workflow = given;
      } else {
        workflow = await chooseGitWorkflow(t, prompts.get(), detected, state.git);
        environment.stdout("\n");
      }
    }
  });
  if (command === "init") {
    steps.push(async () => {
      if (
        asked() &&
        extras.permissions === undefined &&
        state.permissions === undefined &&
        !state.installed
      ) {
        const targeted = tools ?? toolsFromDetection(await extras.detect());
        if (targeted.includes("claude-code")) {
          permissionsMode = await choosePermissionMode(t, prompts.get(), undefined);
          environment.stdout("\n");
        }
      }
    });
  }
  await runSteps(steps);
  if (workflowError !== undefined) return workflowError;
  return {
    input: {
      ...(decision.profile === undefined ? {} : { profile: decision.profile }),
      ...(level === undefined ? {} : { validation: level }),
      ...(installsMode === undefined ? {} : { installs: installsMode }),
      ...(chosenPoints === undefined ? {} : { points: chosenPoints }),
      ...(workflow === undefined ? {} : { workflow }),
      ...(tools === undefined ? {} : { tools }),
      ...(permissionsMode === undefined ? {} : { permissions: permissionsMode }),
    },
    notes: decision.notes,
  };
}

/** Options of `agent create`: the answers given without questions. */
const CREATE_OPTIONS = ["name", "title", "description", "domain", "phase", "icon", "role"] as const;

/** Options of `agent edit`: the agent's model tier and preferred tool, checked by core. */
const SETTINGS_OPTIONS = ["tier", "tool"] as const;
type SettingsOptions = { [key in (typeof SETTINGS_OPTIONS)[number]]?: string | undefined };

/** Options of `history`: its filters, `--all`, and the export. Values are checked by core. */
const HISTORY_OPTIONS = ["story", "since", "decision", "all", "export", "force"] as const;
type HistoryOptions = {
  [key in (typeof HISTORY_OPTIONS)[number]]?: string | boolean | undefined;
};

function invalidArguments(reason: string): AgentPluggedError {
  return new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", { reason });
}

/**
 * The input of `agent`: the sub-command, the id, and for `create` the answers, asked in the
 * terminal for what the options did not give. The id is checked before any question.
 */
async function prepareAgent(
  environment: CliEnvironment,
  t: Translate,
  prompts: Prompts,
  files: WorkspaceFiles,
  method: MethodSource,
  rest: readonly string[],
  skill: boolean,
  given: CreateAnswers,
  settings: SettingsOptions,
  personal: boolean,
): Promise<Record<string, unknown> | AgentPluggedError> {
  const [action, id, ...extra] = rest;
  if (action === undefined || !(AGENT_ACTIONS as readonly string[]).includes(action)) {
    return invalidArguments(`agent ${action ?? ""} (${AGENT_ACTIONS.join(", ")})`.trimEnd());
  }
  if (extra.length > 0) return invalidArguments(extra.join(" "));
  const answersGiven = CREATE_OPTIONS.some((key) => given[key] !== undefined);
  if (action !== "create" && (skill || answersGiven)) {
    return invalidArguments(`agent ${action}: ${skill ? "--skill" : "--title, --description…"}`);
  }
  const settingsGiven = SETTINGS_OPTIONS.filter((key) => settings[key] !== undefined);
  if (action !== "edit" && settingsGiven.length > 0) {
    return invalidArguments(`agent ${action}: ${settingsGiven.map((key) => `--${key}`).join(" ")}`);
  }
  if (personal && action !== "edit") return invalidArguments(`agent ${action}: --personal`);
  if (action === "edit") {
    const values = Object.fromEntries(settingsGiven.map((key) => [key, settings[key]]));
    return { action, id, ...values, ...(personal ? { layer: "personal" } : {}) };
  }
  if (action !== "create") return { action, id };

  const kind = skill ? "skill" : "agent";
  let answers = given;
  if (environment.interactive && environment.stdin) {
    // The id and the options given are checked before the first question.
    const problem = await checkCreate({ files, method }, { id, kind, ...given });
    if (problem !== undefined) return problem;
    answers = await askCreateAnswers(t, prompts.get(), kind, String(id ?? ""), given);
    environment.stdout("\n");
  }
  return { action, id, kind, ...answers };
}

/** Runs the CLI and returns its exit code. */
export async function main(rawEnvironment: CliEnvironment): Promise<number> {
  // `init --yes` asks nothing: it runs as a script does, with the recommended answers.
  let environment = rawEnvironment;
  const locale = localeOf(environment.env, environment.systemLocale);
  const t = createTranslator(locale);

  // `bridge …` only launches the bridge, which is distributed apart: its
  // arguments are its own, so they are not parsed here.
  if (environment.argv[0] === "bridge" || environment.argv[0] === "pair") {
    return await runBridgeLauncher(
      {
        argv: environment.argv,
        cwd: environment.cwd,
        env: environment.env,
        ...(environment.platform === undefined ? {} : { platform: environment.platform }),
        stdout: environment.stdout,
        stderr: environment.stderr,
      },
      t,
    );
  }

  // `update` has its own two options, `--check` and `--auto`, which take a value.
  // Like `review`, it is the creator's own gesture: at a terminal, never from an agent's shell.
  if (environment.argv[0] === "update") {
    if (environment.interactive !== true) {
      environment.stderr(formatError(t, reviewNotInteractive("update")));
      return 1;
    }
    const root = productRootOf(environment.cwd);
    return await runUpdate(
      {
        args: environment.argv.slice(1),
        cwd: root,
        engineVersion: environment.engineVersion,
        files: new NodeWorkspaceFiles(root),
        updates:
          environment.engineUpdates ??
          new NodeEngineUpdates({
            engineVersion: environment.engineVersion,
            cwd: root,
            env: environment.env,
            ...(environment.now === undefined ? {} : { now: environment.now }),
          }),
        stdout: environment.stdout,
        stderr: environment.stderr,
      },
      t,
    );
  }

  // `eval …`: how the skills behave, measured. Its options are its own; `run` uses a
  // real agent and tokens, so it is never part of the tests and says its plan first.
  if (environment.argv[0] === "eval") {
    let methodDir: string | undefined;
    try {
      methodDir = methodRoot();
    } catch {
      methodDir = undefined;
    }
    return await runEval(
      {
        args: environment.argv.slice(1),
        root: productRootOf(environment.cwd),
        env: environment.env,
        ...(methodDir === undefined ? {} : { methodDir }),
        stdout: environment.stdout,
        stderr: environment.stderr,
        ...(environment.evalAgent === undefined ? {} : { agent: environment.evalAgent }),
      },
      t,
    );
  }

  let positionals: string[];
  let help: boolean | undefined;
  let version = false;
  let engineAny = false;
  let upgradeEngine = false;
  let profileOption: string | undefined;
  let validationOption: string | undefined;
  let installsOption: string | undefined;
  let pointsOption: string | undefined;
  let workflowOptions: WorkflowOptions = {};
  let skillOption = false;
  let personalOption = false;
  let createAnswers: CreateAnswers = {};
  let settingsOptions: SettingsOptions = {};
  let remoteOption: string | undefined;
  let recreateRemote = false;
  let resetOption = false;
  let baseOption: string | undefined;
  let historyOptions: HistoryOptions = {};
  let jsonOption = false;
  let usageOptions: Record<string, string | undefined> = {};
  let outOption: string | undefined;
  let inOption: string | undefined;
  let checkOption = false;
  let forgeOption: string | undefined;
  let runnerOption: string | undefined;
  let e2eOption: string | undefined;
  let waiveOption: string | undefined;
  let fileOption: string | undefined;
  let rawOption = false;
  let unverifiedOption = false;
  let yesOption = false;
  let toolsOption: string | undefined;
  let permissionsOption: string | undefined;
  let noSyncOption = false;
  let channelOption: string | undefined;
  let errorOption: string | undefined;
  let exitCodeOption: string | undefined;
  let reportOption = false;
  try {
    const parsed = parseArgs({
      args: [...environment.argv],
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        "engine-any": { type: "boolean" },
        "upgrade-engine": { type: "boolean" },
        profile: { type: "string" },
        validation: { type: "string" },
        installs: { type: "string" },
        channel: { type: "string" },
        points: { type: "string" },
        workflow: { type: "string" },
        branches: { type: "string" },
        "story-branches": { type: "string" },
        ci: { type: "string" },
        merge: { type: "string" },
        review: { type: "string" },
        skill: { type: "boolean" },
        personal: { type: "boolean" },
        name: { type: "string" },
        title: { type: "string" },
        description: { type: "string" },
        domain: { type: "string" },
        phase: { type: "string" },
        icon: { type: "string" },
        role: { type: "string" },
        tier: { type: "string" },
        tool: { type: "string" },
        remote: { type: "string" },
        "recreate-remote": { type: "boolean" },
        reset: { type: "boolean" },
        base: { type: "string" },
        story: { type: "string" },
        since: { type: "string" },
        decision: { type: "string" },
        all: { type: "boolean" },
        export: { type: "string" },
        force: { type: "boolean" },
        json: { type: "boolean" },
        out: { type: "string" },
        in: { type: "string" },
        check: { type: "boolean" },
        forge: { type: "string" },
        runner: { type: "string" },
        e2e: { type: "string" },
        waive: { type: "string" },
        file: { type: "string" },
        raw: { type: "boolean" },
        unverified: { type: "boolean" },
        yes: { type: "boolean", short: "y" },
        tools: { type: "string" },
        permissions: { type: "string" },
        "no-sync": { type: "boolean" },
        error: { type: "string" },
        "exit-code": { type: "string" },
        report: { type: "boolean" },
        by: { type: "string" },
        until: { type: "string" },
        session: { type: "string" },
      },
    });
    positionals = parsed.positionals;
    help = parsed.values.help;
    version = parsed.values.version === true;
    engineAny = parsed.values["engine-any"] === true;
    upgradeEngine = parsed.values["upgrade-engine"] === true;
    profileOption = parsed.values.profile;
    validationOption = parsed.values.validation;
    installsOption = parsed.values.installs;
    pointsOption = parsed.values.points;
    workflowOptions = {
      workflow: parsed.values.workflow,
      branches: parsed.values.branches,
      storyBranches: parsed.values["story-branches"],
      ci: parsed.values.ci,
      merge: parsed.values.merge,
      review: parsed.values.review,
    };
    skillOption = parsed.values.skill === true;
    personalOption = parsed.values.personal === true;
    // A blank option counts as absent: the question is asked, or the option reported missing.
    const blankless = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
    createAnswers = Object.fromEntries(
      CREATE_OPTIONS.map((key) => [key, blankless(parsed.values[key])]),
    ) as CreateAnswers;
    // Given as typed: a blank value is refused by core, never taken for "not given".
    settingsOptions = { tier: parsed.values.tier, tool: parsed.values.tool };
    remoteOption = parsed.values.remote;
    recreateRemote = parsed.values["recreate-remote"] === true;
    resetOption = parsed.values.reset === true;
    baseOption = parsed.values.base;
    historyOptions = {
      story: parsed.values.story,
      since: parsed.values.since,
      decision: parsed.values.decision,
      all: parsed.values.all,
      export: parsed.values.export,
      force: parsed.values.force,
    };
    jsonOption = parsed.values.json === true;
    outOption = parsed.values.out;
    inOption = parsed.values.in;
    checkOption = parsed.values.check === true;
    forgeOption = parsed.values.forge;
    runnerOption = parsed.values.runner;
    e2eOption = parsed.values.e2e;
    waiveOption = parsed.values.waive;
    fileOption = parsed.values.file;
    rawOption = parsed.values.raw === true;
    unverifiedOption = parsed.values.unverified === true;
    yesOption = parsed.values.yes === true;
    toolsOption = parsed.values.tools;
    permissionsOption = parsed.values.permissions;
    noSyncOption = parsed.values["no-sync"] === true;
    channelOption = parsed.values.channel;
    errorOption = parsed.values.error;
    exitCodeOption = parsed.values["exit-code"];
    reportOption = parsed.values.report === true;
    usageOptions = {
      axis: parsed.values.by,
      until: parsed.values.until,
      session: parsed.values.session,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const invalid = new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      reason,
    });
    environment.stderr(formatError(t, invalid));
    environment.stderr(`${t("cli.usage")}\n`);
    return environment.argv.find((arg) => !arg.startsWith("-")) === "docs" ? 2 : 1;
  }

  const [command, ...rest] = positionals;
  if (yesOption && command === "init") environment = { ...environment, interactive: false };
  // `docs check` exits with 2 when the check could not run, and with 1 only on problems found.
  const failCode = command === "docs" ? 2 : 1;
  // `next --json` answers in JSON on standard output, its errors too.
  // `deferred --json` too, and `trace --json`.
  const jsonErrors =
    jsonOption && (command === "next" || command === "deferred" || command === "trace");
  const reportError = (error: AgentPluggedError) => {
    if (jsonErrors) environment.stdout(nextJsonError(error));
    else environment.stderr(formatError(t, error));
  };
  if (help) {
    environment.stdout(`${t("cli.usage")}\n`);
    return 0;
  }
  if (version) {
    environment.stdout(`${environment.engineVersion}\n`);
    return 0;
  }
  if (command === undefined) {
    environment.stderr(`${t("cli.usage")}\n`);
    return 1;
  }
  // The options of `history` belong to it alone: refused for any other command, known or not.
  // `--all` is shared with `deferred list`.
  const historyGiven = HISTORY_OPTIONS.filter(
    (key) =>
      historyOptions[key] !== undefined &&
      !(key === "all" && command === "deferred") &&
      !((key === "story" || key === "since") && command === "usage") &&
      !(key === "force" && command === "publication"),
  );
  if (historyGiven.length > 0 && command !== "history") {
    const options = historyGiven.map((key) => `--${key}`).join(" ");
    // With `--json`, the error is JSON on standard output.
    if (jsonErrors) {
      reportError(invalidArguments(`${command}: ${options}`));
      return failCode;
    }
    environment.stderr(formatError(t, invalidArguments(`${command}: ${options}`)));
    environment.stderr(`${t("cli.usage")}\n`);
    return failCode;
  }
  // `--by`, `--until` and `--session` belong to `usage` alone.
  const usageGiven = Object.entries(usageOptions).filter(([, value]) => value !== undefined);
  if (usageGiven.length > 0 && command !== "usage") {
    const options = usageGiven.map(([key]) => `--${key === "axis" ? "by" : key}`).join(" ");
    environment.stderr(formatError(t, invalidArguments(`${command}: ${options}`)));
    environment.stderr(`${t("cli.usage")}\n`);
    return failCode;
  }
  // `--check` belongs to `migrate` alone.
  if (checkOption && command !== "migrate") {
    environment.stderr(formatError(t, invalidArguments(`${command}: --check`)));
    environment.stderr(`${t("cli.usage")}\n`);
    return failCode;
  }
  // `--json` belongs to `next`, `deferred` and `trace` alone.
  if (
    jsonOption &&
    command !== "next" &&
    command !== "deferred" &&
    command !== "trace" &&
    command !== "usage" &&
    command !== "doctor"
  ) {
    environment.stderr(formatError(t, invalidArguments(`${command}: --json`)));
    environment.stderr(`${t("cli.usage")}\n`);
    return failCode;
  }
  // `--error` and `--exit-code` belong to `doctor` alone.
  for (const [given, name] of [
    [errorOption !== undefined, "--error"],
    [exitCodeOption !== undefined, "--exit-code"],
    [reportOption, "--report"],
  ] as const) {
    if (given && command !== "doctor") {
      environment.stderr(formatError(t, invalidArguments(`${command}: ${name}`)));
      environment.stderr(`${t("cli.usage")}\n`);
      return failCode;
    }
  }
  // `--report` is the report alone: no failure to explain, no JSON, no repair.
  if (
    reportOption &&
    (errorOption !== undefined || exitCodeOption !== undefined || jsonOption || rest.length > 0)
  ) {
    environment.stderr(formatError(t, invalidArguments("doctor: --report")));
    environment.stderr(`${t("cli.usage")}\n`);
    return failCode;
  }
  // The hooks of Antigravity CLI's plugin.
  if (command === "hook") return await runHook(environment, t, rest);
  if (command === "mcp") {
    // The agents' server takes no argument and no option but --engine-any.
    const options = environment.argv.filter((arg) => arg.startsWith("-") && arg !== "--engine-any");
    if (rest.length > 0 || options.length > 0 || upgradeEngine) {
      const extra = [...rest, ...options].join(" ") || "--upgrade-engine";
      environment.stderr(formatError(t, invalidArguments(`mcp: ${extra}`)));
      return 1;
    }
    try {
      // Antigravity starts the server from its plugin's folder, inside the product.
      const root = productRootOf(environment.cwd);
      return await runMcp(
        { ...environment, cwd: root },
        t,
        new NodeWorkspaceFiles(root),
        engineAny,
      );
    } catch (error) {
      const failure =
        error instanceof AgentPluggedError
          ? error
          : new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
              reason: error instanceof Error ? error.message : String(error),
            });
      environment.stderr(formatError(t, failure));
      return 1;
    }
  }
  const registry = createCommandRegistry();
  // An unknown command is reported as such, whatever arguments follow it.
  const withArguments =
    command === "agent" ||
    command === "journal" ||
    command === "review" ||
    command === "key" ||
    command === "trust" ||
    command === "docs" ||
    command === "rules" ||
    command === "deferred" ||
    command === "story" ||
    command === "ci" ||
    command === "tests" ||
    command === "trace" ||
    command === "publication";
  if (rest.length > 0 && registry.names().includes(command) && !withArguments) {
    const invalid = new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      reason: rest.join(" "),
    });
    reportError(invalid);
    return failCode;
  }
  if (upgradeEngine && command !== "init" && registry.names().includes(command)) {
    reportError(invalidArguments(`${command}: --upgrade-engine`));
    return failCode;
  }
  if (
    profileOption !== undefined &&
    (command === "sync" ||
      command === "agent" ||
      command === "journal" ||
      command === "review" ||
      command === "key" ||
      command === "docs" ||
      command === "history" ||
      command === "next" ||
      command === "rules" ||
      command === "migrate" ||
      command === "deferred" ||
      command === "story" ||
      command === "ci" ||
      command === "tests" ||
      command === "trace" ||
      command === "publication")
  ) {
    reportError(invalidArguments("--profile"));
    return failCode;
  }
  // `--validation` belongs to `init` and `profile`.
  if (
    validationOption !== undefined &&
    command !== "init" &&
    command !== "profile" &&
    registry.names().includes(command)
  ) {
    reportError(invalidArguments(`${command}: --validation`));
    return failCode;
  }
  // `--installs` belongs to `init` and `profile`.
  if (
    installsOption !== undefined &&
    command !== "init" &&
    command !== "profile" &&
    registry.names().includes(command)
  ) {
    reportError(invalidArguments(`${command}: --installs`));
    return failCode;
  }
  // `--points` belongs to `init` and `profile`.
  if (
    pointsOption !== undefined &&
    command !== "init" &&
    command !== "profile" &&
    registry.names().includes(command)
  ) {
    reportError(invalidArguments(`${command}: --points`));
    return failCode;
  }
  // `--yes`, `--tools` and `--no-sync` belong to `init`, `--permissions` to `init` and `profile`.
  const initOnly = [
    ...(yesOption ? ["--yes"] : []),
    ...(toolsOption === undefined ? [] : ["--tools"]),
    ...(noSyncOption ? ["--no-sync"] : []),
  ];
  if (initOnly.length > 0 && command !== "init" && registry.names().includes(command)) {
    reportError(invalidArguments(`${command}: ${initOnly.join(" ")}`));
    return failCode;
  }
  // `--channel` belongs to `init` alone: the store the creator installed the method from.
  if (channelOption !== undefined && command !== "init" && registry.names().includes(command)) {
    reportError(invalidArguments(`${command}: --channel`));
    return failCode;
  }
  if (channelOption !== undefined && command === "init") {
    const checked = validateInstallChannel(channelOption);
    if (checked instanceof AgentPluggedError) {
      reportError(checked);
      return failCode;
    }
  }
  if (
    permissionsOption !== undefined &&
    command !== "init" &&
    command !== "profile" &&
    registry.names().includes(command)
  ) {
    reportError(invalidArguments(`${command}: --permissions`));
    return failCode;
  }
  // The options of the Git workflow belong to `init` and `profile`.
  if (
    hasWorkflowOptions(workflowOptions) &&
    command !== "init" &&
    command !== "profile" &&
    registry.names().includes(command)
  ) {
    reportError(
      invalidArguments(
        `${command}: --workflow, --branches, --story-branches, --ci, --merge, --review`,
      ),
    );
    return failCode;
  }
  const journalOptions = [
    ...(remoteOption === undefined ? [] : ["--remote"]),
    ...(recreateRemote ? ["--recreate-remote"] : []),
  ];
  if (journalOptions.length > 0 && command !== "journal" && registry.names().includes(command)) {
    reportError(invalidArguments(journalOptions.join(" ")));
    return failCode;
  }
  if (baseOption !== undefined && command !== "docs") {
    reportError(invalidArguments("--base"));
    return failCode;
  }
  // `--file` and `--raw` belong to `publication`.
  if ((fileOption !== undefined || rawOption || unverifiedOption) && command !== "publication") {
    const given = fileOption !== undefined ? "--file" : rawOption ? "--raw" : "--unverified";
    reportError(invalidArguments(`${command}: ${given}`));
    return failCode;
  }
  // `--forge` belongs to `ci setup` and `story ci`, `--waive` to `story ci`.
  const storyCiCommand = command === "story" && rest[0] === "ci";
  if (
    forgeOption !== undefined &&
    command !== "ci" &&
    !storyCiCommand &&
    registry.names().includes(command)
  ) {
    reportError(invalidArguments("--forge"));
    return failCode;
  }
  // `--runner` and `--e2e` belong to `tests setup`.
  if (
    (runnerOption !== undefined || e2eOption !== undefined) &&
    command !== "tests" &&
    registry.names().includes(command)
  ) {
    reportError(invalidArguments(runnerOption !== undefined ? "--runner" : "--e2e"));
    return failCode;
  }
  if (waiveOption !== undefined && !storyCiCommand && registry.names().includes(command)) {
    reportError(invalidArguments("--waive"));
    return failCode;
  }
  const agentOptions = [
    ...(skillOption ? ["--skill"] : []),
    ...(personalOption ? ["--personal"] : []),
    ...CREATE_OPTIONS.filter((key) => createAnswers[key] !== undefined).map((key) => `--${key}`),
    ...SETTINGS_OPTIONS.filter((key) => settingsOptions[key] !== undefined).map(
      (key) => `--${key}`,
    ),
  ];
  if (agentOptions.length > 0 && command !== "agent" && registry.names().includes(command)) {
    reportError(invalidArguments(agentOptions.join(" ")));
    return failCode;
  }
  if (
    profileOption !== undefined &&
    !isPresetId(profileOption) &&
    registry.names().includes(command)
  ) {
    const invalid = new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
      reason: `--profile ${profileOption} (${PROFILE_PRESET_IDS.join(", ")})`,
    });
    reportError(invalid);
    return failCode;
  }

  if (resetOption && !(command === "key" && rest[0] === "presence")) {
    if (registry.names().includes(command)) {
      reportError(invalidArguments(`${command}: --reset`));
      return failCode;
    }
  }
  // `--out` belongs to `key export`, `--in` to `key import`.
  const keyFileOptions = [
    ...(outOption !== undefined && !(command === "key" && rest[0] === "export") ? ["--out"] : []),
    ...(inOption !== undefined && !(command === "key" && rest[0] === "import") ? ["--in"] : []),
  ];
  // Refused for every other command, known or not.
  if (keyFileOptions.length > 0) {
    reportError(invalidArguments(`${command}: ${keyFileOptions.join(" ")}`));
    return failCode;
  }
  if (command === "review" || command === "key") {
    // `review [<G-id>]`, `key presence [--reset]`, `key endorse [<human:…>]`,
    // `key export [--out <file>]`, `key import [--in <file>]`, `key seal`.
    const [action, ...more] = rest;
    // The exported key never goes on the command line: it would stay in the shell's history.
    if (command === "key" && action === "import" && more.length > 0) {
      const refused = new AgentPluggedError(
        ErrorCode.INVALID_ARGUMENTS,
        "error.invalid_arguments",
        {
          reason: "key import: the exported key never goes on the command line",
          reason_key: "key.import.positional",
        },
      );
      reportError(refused);
      return 1;
    }
    const valid =
      command === "review"
        ? rest.length <= 1
        : (action === "presence" && more.length === 0) ||
          (action === "endorse" && more.length <= 1) ||
          (action === "export" && more.length === 0) ||
          (action === "import" && more.length === 0) ||
          (action === "seal" && more.length === 0);
    if (!valid) {
      const typed = [command, ...rest].join(" ");
      reportError(
        invalidArguments(
          command === "key" ? `${typed} (presence, endorse, export, import, seal)` : typed,
        ),
      );
      return 1;
    }
    // Only the creator, at a terminal, answers, links or endorses: refused before anything.
    if (environment.interactive !== true || environment.stdin === undefined) {
      reportError(reviewNotInteractive(command));
      return 1;
    }
  }
  if (command === "trust") {
    // `trust dismiss`: the way out of `SECURITY_ROOT_CHANGED`, at a terminal only.
    if (rest.length !== 1 || rest[0] !== "dismiss") {
      reportError(invalidArguments(`${["trust", ...rest].join(" ")} (trust dismiss)`));
      return 1;
    }
    if (environment.interactive !== true || environment.stdin === undefined) {
      reportError(reviewNotInteractive("trust"));
      return 1;
    }
  }
  if (command === "rules") {
    // `rules [show]`, `rules set <action> <allow|ask|deny>`, `rules reset`.
    const [action, ...more] = rest;
    const valid =
      action === undefined ||
      (action === "show" && more.length === 0) ||
      (action === "set" && more.length === 2) ||
      (action === "reset" && more.length === 0);
    if (!valid) {
      const typed = ["rules", ...rest].join(" ");
      const expected = "rules [show] | rules set <action> <allow|ask|deny> | rules reset";
      reportError(invalidArguments(`"${typed}" (${expected})`));
      return 1;
    }
    // Core refuses a locked rule (`RULE_LOCKED`), then any change outside a terminal
    // (`REVIEW_NOT_INTERACTIVE`), before reading or writing anything.
  }
  // `deferred [list] [<e-s>] [--all] [--json]`, `deferred <e-s>`, `deferred show <D-id> [--json]`,
  // `deferred resolve|drop <D-id> <reason…>`.
  const deferredArgs =
    command === "deferred" && rest[0] !== undefined && /^\d+-\d+$/.test(rest[0])
      ? ["list", ...rest]
      : rest;
  const deferredAction = command === "deferred" ? (deferredArgs[0] ?? "list") : undefined;
  const closing = deferredAction === "resolve" || deferredAction === "drop";
  if (command === "deferred") {
    const valid =
      (deferredAction === "list" && deferredArgs.length <= 2) ||
      (deferredAction === "show" &&
        deferredArgs.length === 2 &&
        historyOptions.all === undefined) ||
      (closing && deferredArgs.length >= 3 && historyOptions.all === undefined && !jsonOption);
    if (!valid) {
      const typed = ["deferred", ...rest, ...(historyOptions.all ? ["--all"] : [])].join(" ");
      const expected =
        "deferred [list] [<e-s>] [--all] [--json] | deferred show <D-id> [--json] | deferred resolve|drop <D-id> <reason>";
      reportError(invalidArguments(`"${typed}" (${expected})`));
      return 1;
    }
    // The id is checked before anything else: a typo never reaches the creator's key.
    if (deferredAction !== "list" && !DeferredIdInputSchema.safeParse(deferredArgs[1]).success) {
      reportError(invalidArguments(`deferred ${deferredAction}: ${deferredArgs[1]} (D-…)`));
      return 1;
    }
    // Only the creator, at a terminal, closes an item: refused before anything.
    if (closing && (environment.interactive !== true || environment.stdin === undefined)) {
      reportError(reviewNotInteractive("deferred"));
      return 1;
    }
  }
  // `trace [<EF-n>] [--json]`, `trace resolve <V-id> <reason…>`.
  const traceResolving = command === "trace" && rest[0] === "resolve";
  if (command === "trace") {
    const valid = traceResolving ? rest.length >= 3 && !jsonOption : rest.length <= 1;
    if (!valid) {
      const typed = ["trace", ...rest].join(" ");
      const expected = "trace [<EF-n>] [--json] | trace resolve <V-id> <reason>";
      reportError(invalidArguments(`"${typed}" (${expected})`));
      return 1;
    }
    // The ids are checked before anything else: a typo never reaches the creator's key.
    if (traceResolving && !DeviationIdInputSchema.safeParse(rest[1]).success) {
      reportError(invalidArguments(`trace resolve: ${rest[1]} (V-…)`));
      return 1;
    }
    if (traceResolving && !DeviationReasonSchema.safeParse(rest.slice(2).join(" ")).success) {
      reportError(
        invalidArguments("trace resolve: <reason> (1 to 1000 characters, no control characters)"),
      );
      return 1;
    }
    if (
      !traceResolving &&
      rest[0] !== undefined &&
      !TracedRequirementInputSchema.safeParse(rest[0]).success
    ) {
      reportError(invalidArguments(`trace: ${rest[0]} (EF-n or ENF-n)`));
      return 1;
    }
    // Only the creator, at a terminal, lifts a deviation: refused before anything.
    if (traceResolving && (environment.interactive !== true || environment.stdin === undefined)) {
      reportError(reviewNotInteractive("trace"));
      return 1;
    }
  }
  const files = new NodeWorkspaceFiles(environment.cwd);
  // The shipped method is located only for the commands that read it.
  let method: MethodSource = METHOD_UNAVAILABLE;
  // `migrate` copies the method again when a format step renames its agents.
  // `review` too: an approved creator's action on agents runs `agent` and `sync`.
  if (
    command === "init" ||
    command === "sync" ||
    command === "agent" ||
    command === "ci" ||
    command === "migrate" ||
    command === "review" ||
    command === "doctor"
  ) {
    try {
      method = new NodeWorkspaceFiles(methodRoot());
    } catch (error) {
      const failure = new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
        reason: error instanceof Error ? error.message : String(error),
      });
      reportError(failure);
      return failCode;
    }
  }
  const prompts = promptsOf(environment);
  // The journal's long-running `git` processes: closed once, whatever the command and its end.
  let journal: GitStateStore | undefined;
  // What a command writes is sent before it ends (a few seconds at most).
  let backup: JournalBackup | undefined;
  try {
    // The pinned engine version is checked before any question and any write. Core checks it
    // again for every command; here it also gives the warning of `--engine-any`.
    const typed = commandLine(environment.argv);
    if (registry.names().includes(command)) {
      const engine = await checkEngine(files, {
        engineVersion: environment.engineVersion,
        engineAny,
        // `migrate` replaces an older pin and brings an older format forward.
        upgrade: (command === "init" && upgradeEngine) || command === "migrate",
        migrate: command === "migrate",
        command: typed,
      });
      if (engine instanceof AgentPluggedError) {
        reportError(engine);
        return failCode;
      }
      if (engine.overridden) environment.stderr(engineAnyWarning(environment, t, engine));
    }
    let exitCode = 0;
    let input: Record<string, unknown> = {};
    // `doctor --error "<message>"` explains a failure with what the machine shows.
    if (command === "doctor" && (errorOption !== undefined || exitCodeOption !== undefined)) {
      const failedWith = exitCodeOption === undefined ? undefined : Number(exitCodeOption);
      if (
        failedWith !== undefined &&
        (!/^\d{1,3}$/.test(exitCodeOption ?? "") || (failedWith as number) > 255)
      ) {
        environment.stderr(formatError(t, invalidArguments("doctor: --exit-code")));
        environment.stderr(`${t("cli.usage")}\n`);
        return failCode;
      }
      // `--error -` reads the message from the standard input (piped), never from a terminal.
      if (errorOption === "-" && environment.interactive === true) {
        environment.stderr(formatError(t, invalidArguments("doctor: --error -")));
        environment.stderr(`${t("cli.usage")}\n`);
        return failCode;
      }
      const output =
        errorOption === "-"
          ? (await readAll(environment.stdin)).slice(-20_000)
          : errorOption?.slice(-20_000);
      input = {
        failure: {
          ...(failedWith === undefined ? {} : { exit_code: failedWith }),
          ...(output === undefined || output === "" ? {} : { output }),
        },
      };
    }
    // `doctor --report` is the report to attach to a request for help.
    if (command === "doctor" && reportOption) input = { report: true };
    let exportTarget: { files: WorkspaceFiles; name: string } | undefined;
    let notes: readonly string[] = [];
    // What the first step of `init` found on the machine.
    let machineReport: DoctorReport | undefined;
    if (command === "init" || command === "profile") {
      const option = profileOption as ProfilePresetId | undefined; // checked above
      if (command === "init") {
        machineReport = await machineStep(
          environment,
          t,
          locale,
          registry,
          files,
          method,
          environmentProbeOf(environment),
          { yes: yesOption, prompts, onError: reportError },
        );
      }
      let detection: Promise<readonly DetectedTool[]> | undefined;
      const prepared = await runWithProfile(
        environment,
        t,
        prompts,
        command,
        files,
        option,
        validationOption,
        installsOption,
        pointsOption,
        workflowOptions,
        {
          tools: toolsOption,
          permissions: permissionsOption,
          detect: () => {
            detection ??= detectTools(new NodeToolProbe({ env: environment.env }));
            return detection;
          },
        },
      );
      if (prepared instanceof AgentPluggedError) {
        reportError(prepared);
        return failCode;
      }
      ({ input, notes } = prepared);
      if (upgradeEngine) input = { ...input, upgrade_engine: true };
    } else if (command === "agent") {
      const prepared = await prepareAgent(
        environment,
        t,
        prompts,
        files,
        method,
        rest,
        skillOption,
        createAnswers,
        settingsOptions,
        personalOption,
      );
      if (prepared instanceof AgentPluggedError) {
        reportError(prepared);
        return failCode;
      }
      input = prepared;
    } else if (command === "journal") {
      const [action, ...extra] = rest;
      if ((action !== "sync" && action !== "status") || extra.length > 0) {
        const typed = ["journal", ...rest].join(" ");
        reportError(invalidArguments(`${typed} (sync, status)`));
        return failCode;
      }
      input = {
        action,
        ...(remoteOption === undefined ? {} : { remote: remoteOption }),
        ...(recreateRemote ? { recreate_remote: true } : {}),
      };
    } else if (command === "docs") {
      const [action, ...extra] = rest;
      // `docs path <criteria>` proposes the short or the full path, `docs grow` carries
      // the spec over to the full path.
      if (action === "slides" && extra.length === 0) {
        input = { action };
      } else if (action === "path" || action === "research" || action === "costs") {
        input = { action, words: extra };
      } else if ((action !== "check" && action !== "grow") || extra.length > 0) {
        const typed = ["docs", ...rest].join(" ");
        reportError(invalidArguments(`${typed} (check, path, grow, research, slides, costs)`));
        return failCode;
      } else {
        input = { action, ...(baseOption === undefined ? {} : { base: baseOption }) };
      }
    } else if (command === "rules") {
      const [action = "show", rule, value] = rest;
      input = { action, ...(action === "set" ? { rule, value } : {}) };
    } else if (command === "migrate") {
      input = checkOption ? { check: true } : {};
    } else if (command === "deferred") {
      const [, target] = deferredArgs;
      input = closing
        ? { action: deferredAction, item: target, reason: deferredArgs.slice(2).join(" ") }
        : deferredAction === "show"
          ? { action: "show", item: target }
          : {
              action: "list",
              ...(target === undefined ? {} : { story: target }),
              ...(historyOptions.all === true ? { all: true } : {}),
            };
    } else if (command === "trace") {
      input = traceResolving
        ? { action: "resolve", deviation: rest[1], reason: rest.slice(2).join(" ") }
        : rest[0] === undefined
          ? { action: "overview" }
          : { action: "requirement", requirement: rest[0] };
    } else if (command === "story") {
      // `story start <epic>-<story>`, `story pr <epic>-<story>`,
      // `story ci <epic>-<story>`; core checks the id.
      const [action, story, ...extra] = rest;
      if (
        (action !== "start" && action !== "pr" && action !== "ci") ||
        story === undefined ||
        extra.length > 0
      ) {
        const typed = ["story", ...rest].join(" ");
        reportError(
          invalidArguments(
            `${typed} (story start <epic>-<story>, story pr <epic>-<story>, story ci <epic>-<story>)`,
          ),
        );
        return failCode;
      }
      input = {
        action,
        story,
        ...(forgeOption === undefined ? {} : { forge: forgeOption }),
        ...(waiveOption === undefined ? {} : { waive: waiveOption }),
      };
    } else if (command === "publication") {
      // `publication <G-id> [--file <path>] [--raw]` and `publication export <G-id> [--force]`
      //; core checks the id.
      const exporting = rest[0] === "export";
      const [target, ...extra] = exporting ? rest.slice(1) : rest;
      if (target === undefined || extra.length > 0) {
        const typed = ["publication", ...rest].join(" ");
        reportError(
          invalidArguments(
            `${typed} (publication <G-id> [--file <path>] [--raw], publication export <G-id> [--force])`,
          ),
        );
        return failCode;
      }
      input = {
        action: exporting ? "export" : "show",
        checkpoint: target,
        ...(fileOption === undefined ? {} : { file: fileOption }),
        ...(rawOption ? { raw: true } : {}),
        ...(unverifiedOption ? { unverified: true } : {}),
        ...(historyOptions.force === true ? { force: true } : {}),
      };
    } else if (command === "ci") {
      // `ci setup [--forge github|gitlab]`; core checks the forge.
      const [action, ...extra] = rest;
      if (action !== "setup" || extra.length > 0) {
        const typed = ["ci", ...rest].join(" ");
        reportError(invalidArguments(`${typed} (ci setup [--forge github|gitlab])`));
        return failCode;
      }
      input = { action, ...(forgeOption === undefined ? {} : { forge: forgeOption }) };
    } else if (command === "tests") {
      // `tests setup [--runner <name>] [--e2e <name>|none]`; core checks the names.
      const [action, ...extra] = rest;
      if (action !== "setup" || extra.length > 0) {
        const typed = ["tests", ...rest].join(" ");
        reportError(
          invalidArguments(`${typed} (tests setup [--runner <name>] [--e2e <name>|none])`),
        );
        return failCode;
      }
      input = {
        action,
        ...(runnerOption === undefined ? {} : { runner: runnerOption }),
        ...(e2eOption === undefined ? {} : { e2e: e2eOption }),
      };
    } else if (command === "usage") {
      // What the AI tools consumed, read from the measures in the journal.
      input = Object.fromEntries(
        Object.entries({
          ...usageOptions,
          story: historyOptions.story,
          since: historyOptions.since,
        }).filter(([, value]) => value !== undefined),
      );
    } else if (command === "history") {
      input = Object.fromEntries(
        HISTORY_OPTIONS.flatMap((key) =>
          historyOptions[key] === undefined ? [] : [[key, historyOptions[key]]],
        ),
      );
      // The export's path is resolved (and checked) here only: core writes where it is told.
      const path = historyOptions.export;
      if (typeof path === "string" && path.trim() !== "") {
        const target = await resolveExportTarget(environment.cwd, path);
        if (target instanceof AgentPluggedError) {
          reportError(target);
          return failCode;
        }
        exportTarget = target;
      }
    }
    // init adopts the product id the journal holds, creates the creator's key and publishes it.
    // `journal sync` moves the journal's commits only, and `journal status` reads them: neither
    // signs. `review` and `key` sign with the creator's key.
    const keys = keyStoreOf(environment.env);
    // `story ci --waive` is the creator's answer, signed by their key.
    const signing =
      command === "init" ||
      command === "review" ||
      command === "key" ||
      command === "trust" ||
      closing ||
      traceResolving ||
      (storyCiCommand && waiveOption !== undefined);
    // `history` and `next` only read: their journal never reaches the keychain (none is needed).
    // `migrate --check` only reads too, and `docs check` the approved stories.
    const reading =
      command === "history" ||
      command === "next" ||
      command === "publication" ||
      command === "docs" ||
      command === "usage" ||
      (command === "migrate" && checkOption) ||
      (command === "deferred" && !closing) ||
      (command === "trace" && !traceResolving);
    // `migrate` records its event signed by the machine's key, `story start` too
    //.
    journal =
      signing || command === "journal" || reading || command === "migrate" || command === "story"
        ? new GitStateStore({
            cwd: environment.cwd,
            keys: reading ? NO_KEYCHAIN : keys,
            ...keyLockOf(environment),
            onWrite: () => backup?.noteWrite(),
          })
        : undefined;
    // `journal sync` is the manual gesture itself; a command that only reads writes nothing.
    if (journal !== undefined && !reading && command !== "journal") {
      backup = new JournalBackup({ port: journal });
      // A cloned repository receives the journal of the remote before `init` looks for it.
      if (command === "init") await backup.pull(INIT_PULL_MS);
    }
    const human: HumanAccess | undefined =
      signing && journal !== undefined
        ? {
            keys,
            lock: journal.keyCreationLock(),
            presence: presenceOf(environment),
            onPresencePrompt: (prompt) => environment.stdout(formatPresencePrompt(t, prompt)),
            askPassphrase: passphraseAsker(t, () => prompts.get()),
            askConfirmation: confirmationAsker(t, () => prompts.get()),
            ...(environment.passphraseLimits === undefined
              ? {}
              : { passphraseLimits: environment.passphraseLimits }),
          }
        : undefined;
    // `doctor`, `init` and `review` (an approved repair) look at and repair the machine.
    const machine =
      command === "doctor" || command === "init" || command === "review"
        ? environmentProbeOf(environment)
        : undefined;
    const context = {
      files,
      journal,
      // `sync` lists the folder of the stories' working copies for Codex.
      projectRoot: environment.cwd,
      journalSync: command === "journal" ? journal : undefined,
      tools: new NodeToolProbe({ env: environment.env }),
      ...(machine === undefined ? {} : { environment: machine }),
      method,
      actor: "human" as const,
      engineVersion: environment.engineVersion,
      engineAny,
      commandLine: typed,
      interactive: environment.interactive === true,
      // `trust dismiss` reads the root of trust pinned on this machine.
      ...(command === "trust" ? { rootPins: environment.rootPins ?? new NodeRootPinStore() } : {}),
      // The product key: `journal status` and `init` read it from the keychain;
      // `history` and `next` never do (they decrypt nothing).
      ...(reading && !(command === "docs" && rest[0] === "costs") && command !== "usage"
        ? {}
        : { keys }),
      // `usage --session` reads that session's trace for its habits.
      ...(command === "usage"
        ? { usageTraces: new NodeUsageTraces({ root: environment.cwd }) }
        : {}),
      ...(environment.now === undefined ? {} : { now: environment.now }),
      ...(human === undefined ? {} : { human }),
      ...(environment.platform === undefined ? {} : { platform: environment.platform }),
      // `review` reads the stories a `document` checkpoint would freeze.
      ...(command === "docs" || command === "review" || command === "publication"
        ? { docsBase: new GitDocsBase({ cwd: environment.cwd }) }
        : {}),
      ...(exportTarget === undefined ? {} : { exportTarget }),
      // `next` looks for the knowledge base on the main branch too.
      ...(command === "sync" || command === "rules" || command === "next" || command === "review"
        ? { mainBranch: new GitMainBranchReader({ cwd: environment.cwd }) }
        : {}),
      // `story start` creates the story's branch, worktree and commit hook.
      // `review` too: an approved CI waiver reads the branch's head again.
      // `next` too: the late notices of the knowledge base are committed by the engine.
      ...(command === "story" ||
      command === "review" ||
      command === "init" ||
      command === "profile" ||
      command === "next"
        ? { storyWorkspace: storyWorkspaceOf(environment) }
        : {}),
      // `story pr` pushes the story's branch and runs the forge's tool; `review` merges
      // an approved story with it, after the order and the conflicts are read through Git
      //.
      ...(command === "story" || command === "review" || command === "profile"
        ? { storyForge: storyForgeOf(environment) }
        : {}),
      // `story pr` and `story ci` read the changes of a story in the fast track;
      // `review` reads the changes of the stories to order.
      ...(command === "story" || command === "review"
        ? {
            storyDiff: new GitStoryDiff({ cwd: environment.cwd }),
            codeSource: new GitCodeSource({ cwd: environment.cwd }),
          }
        : {}),
      ...(command === "review" ? { mergeProbe: new GitMergeProbe({ cwd: environment.cwd }) } : {}),
      // `story merge` reads `pr.merge_method` on the main branch, like the rules.
      ...(command === "story"
        ? { mainBranch: new GitMainBranchReader({ cwd: environment.cwd }) }
        : {}),
      // `story ci` reads the CI of a story's pull request, `ci setup` the forge.
      // `next` reads the CI at the repository's top.
      ...(command === "story" ||
      command === "ci" ||
      command === "next" ||
      command === "init" ||
      command === "profile"
        ? { ciReader: ciReaderOf(environment) }
        : {}),
      // `trace` reads the tests that cite a requirement, through Git.
      ...(command === "trace"
        ? { testReferences: new GitTestReferences({ cwd: environment.cwd }) }
        : {}),
    };
    if (command === "doctor" && machine === undefined) {
      environment.stdout(`${t("doctor.off")}\n`);
      return 0;
    }
    if (command === "trust") {
      return await runTrustDismiss(t, prompts.get(), registry, context, {
        stdout: (text) => environment.stdout(text),
        reportError,
      });
    }
    if (command === "review") {
      const store = journal as GitStateStore;
      const remote = await store.resolveRemote(undefined).catch(() => null);
      const text = await runReview(t, prompts.get(), registry, context, rest[0], {
        undoMs: environment.undoMs ?? UNDO_MS,
        now: environment.now ?? Date.now,
        remote,
      });
      environment.stdout(text);
      return 0;
    }
    if (command === "key") {
      if (rest[0] === "presence") {
        input = { action: "presence", ...(resetOption ? { reset: true } : {}) };
      } else if (rest[0] === "export") {
        // Checked before the passphrase is asked: a new file, outside the repository.
        if (outOption !== undefined) await checkExportTarget(environment.cwd, outOption);
        input = { action: "export" };
      } else if (rest[0] === "import") {
        // Without --in, core asks the exported key without echoing it.
        input =
          inOption === undefined
            ? { action: "import" }
            : { action: "import", text: await readExportFile(environment.cwd, inOption) };
      } else if (rest[0] === "seal") input = { action: "seal" };
      else input = { action: "endorse", ...(rest[1] === undefined ? {} : { device: rest[1] }) };
    }
    const result = await registry.run(command, context, input);
    if (!result.ok) {
      reportError(result.error);
      if (result.error.code === ErrorCode.UNKNOWN_COMMAND) {
        environment.stderr(`${t("cli.usage")}\n`);
      }
      return failCode;
    }
    const notesText = notes.map((note) => `${note}\n`).join("");
    if (command === "init") {
      const {
        entries,
        tools,
        profile,
        targetedTools,
        engineUpgrade,
        nothingPinned,
        productIdAdded,
      } = result.value as InitResult;
      environment.stdout(formatSummary(t, files.root, entries));
      // noted after the install, outside what `init` plans, so that the result is the
      // same whichever way the creator came.
      if (channelOption !== undefined) {
        await writeInstallChannel(files, validateInstallChannel(channelOption) as InstallChannel);
      }
      if (productIdAdded !== undefined) {
        const path = METHOD_CONFIG_PATH;
        environment.stdout(
          `\n${t("init.product_id_added", { path, product_id: productIdAdded })}\n`,
        );
      }
      if (engineUpgrade) environment.stdout(`\n${t("init.engine_upgraded", engineUpgrade)}\n`);
      if (nothingPinned) {
        const version = environment.engineVersion;
        environment.stdout(`\n${t("init.engine_nothing_pinned", { version })}\n`);
      }
      if (profile) environment.stdout(`\n${notesText}${formatProfile(t, profile)}`);
      const level = (result.value as InitResult).validation;
      if (level !== undefined) environment.stdout(formatValidationMode(t, level));
      const installsMode = (result.value as InitResult).installs;
      if (installsMode !== undefined) environment.stdout(formatInstallMode(t, installsMode));
      const keptPoints = (result.value as InitResult).points;
      if (keptPoints !== undefined) environment.stdout(formatPoints(t, keptPoints));
      const permissionMode = (result.value as InitResult).permissions;
      if (permissionMode !== undefined) {
        environment.stdout(formatPermissionMode(t, permissionMode));
      }
      const flow = (result.value as InitResult).workflow;
      if (flow !== undefined) {
        environment.stdout(
          formatWorkflowResult(t, flow, (result.value as InitResult).workflow_recorded),
        );
      }
      environment.stdout(`\n${formatTools(t, tools)}`);
      const names = targetedTools.map(
        (id) => TOOL_CATALOG.find((spec) => spec.id === id)?.name ?? id,
      );
      environment.stdout(`\n${t("init.targeted_tools", { list: names.join(", ") })}\n`);
      // A script without `--yes` is told the next step; a creator at a terminal (or `--yes`) is
      // taken through it below.
      const scripted = environment.interactive !== true || environment.stdin === undefined;
      if (scripted && !yesOption) environment.stdout(`${t("sync.next_step")}\n`);
      // A product that existed before the method: Zoé writes its knowledge base first.
      if ((result.value as InitResult).knowledgeBase === true) {
        environment.stdout(`\n${t("init.existing_product", { path: METHOD_CONFIG_PATH })}\n`);
      }
      const { humanKey } = result.value as InitResult;
      if (humanKey !== undefined) {
        await reportHumanKey(environment, t, prompts, registry, context, humanKey);
      }
      const { productKey } = result.value as InitResult;
      if (productKey !== undefined) {
        environment.stdout(`\n${formatInitProductKey(t, productKey).join("\n")}\n`);
      }
      // The files of the AI tools, proposed (recommended) or made with `--yes`; then
      // the one sentence that says what to do next.
      if (!scripted || yesOption) {
        let synced = false;
        let wanted = yesOption && !noSyncOption;
        if (!yesOption && !noSyncOption) {
          try {
            wanted = await askYesNo(t, prompts.get(), t("init.sync.ask"), true);
          } catch (error) {
            // Escape or the end of the input: the installation is done, only the sync is left out.
            const left =
              error instanceof GoBack ||
              (error instanceof AgentPluggedError && error.code === ErrorCode.CANCELLED);
            if (!left) throw error;
            wanted = false;
          }
        }
        if (wanted) {
          const generated = await registry.run(
            "sync",
            { ...context, mainBranch: new GitMainBranchReader({ cwd: environment.cwd }) },
            {},
          );
          if (generated.ok) {
            environment.stdout(`\n${formatSyncCompact(t, generated.value as SyncResult)}`);
            environment.stdout(await codexTrustNote(environment, t, prompts, files));
            synced = true;
          } else {
            environment.stderr(formatError(t, generated.error));
          }
        } else {
          environment.stdout(`\n${t("init.sync.skipped")}\n`);
        }
        environment.stdout(
          `\n${formatNextStep(t, (result.value as InitResult).targetedTools, synced)}`,
        );
      }
      // A script learns from the exit code that a blocking point remains.
      if (scripted && machineReport?.blocking === true) {
        environment.stderr(
          `${t("doctor.blocking", {
            list: machineReport.items
              .filter((item) => item.status === "fail")
              .map((item) => (locale === "fr" ? item.text.fr : item.text.en))
              .join(" ; "),
          })}\n`,
        );
        exitCode = 1;
      }
    } else if (command === "doctor") {
      return await runDoctorCommand(
        environment,
        t,
        locale,
        registry,
        context,
        result.value as DoctorResult,
        { json: jsonOption, prompts },
      );
    } else if (command === "key") {
      const value = result.value as KeyResult;
      if (value.action === "export" && outOption !== undefined) {
        const file = await writeExportFile(environment.cwd, outOption, value.exported);
        environment.stdout(formatProductKey(t, value, file));
      } else environment.stdout(formatKey(t, value));
    } else if (command === "sync") {
      environment.stdout(formatSync(t, files.root, result.value as SyncResult, locale));
      environment.stdout(await codexTrustNote(environment, t, prompts, files));
    } else if (command === "agent") {
      environment.stdout(formatAgentResult(t, result.value as AgentCommandResult));
    } else if (command === "journal") {
      environment.stdout(
        input.action === "status"
          ? formatJournalStatus(
              t,
              result.value as ProjectStateResult,
              (environment.now ?? Date.now)(),
            )
          : formatJournalSync(t, result.value as JournalSyncResult),
      );
    } else if (command === "history") {
      environment.stdout(formatValidationHistory(t, result.value as HistoryResult));
    } else if (command === "next") {
      const step = result.value as NextResult;
      environment.stdout(jsonOption ? nextJson(step) : formatNext(t, step));
    } else if (command === "rules") {
      environment.stdout(formatRules(t, result.value as RulesResult));
    } else if (command === "deferred") {
      const value = result.value as DeferredResult;
      environment.stdout(jsonOption ? deferredJson(value) : formatDeferred(t, value));
    } else if (command === "usage") {
      const report = result.value as UsageReport;
      environment.stdout(jsonOption ? usageJson(report) : formatUsage(t, report));
    } else if (command === "trace") {
      const value = result.value as TraceResult;
      environment.stdout(jsonOption ? traceJson(value) : formatTrace(t, value));
    } else if (command === "migrate") {
      environment.stdout(formatMigrate(t, result.value as MigrateResult, METHOD_CONFIG_PATH));
    } else if (command === "story") {
      if (input.action === "ci") {
        environment.stdout(formatStoryCi(t, result.value as CiCheckResult | CiWaiveResult));
      } else {
        const value = result.value as StoryStartResult | StoryPullRequestResult;
        environment.stdout(
          "url" in value ? formatStoryPullRequest(t, value) : formatStoryStart(t, value),
        );
      }
    } else if (command === "publication") {
      const value = result.value as PublicationResult;
      if (value.action === "export") {
        environment.stdout(formatPublicationExported(t, value));
      } else {
        const shown = formatPublicationShown(t, value);
        environment.stderr(shown.err);
        environment.stdout(shown.out);
      }
    } else if (command === "ci") {
      environment.stdout(formatCiSetup(t, result.value as CiSetupResult));
    } else if (command === "tests") {
      environment.stdout(formatTestsSetup(t, result.value as TestsSetupResult));
    } else if (command === "docs") {
      // Writes nothing (but `docs slides`, the page next to the deck): the summary on stdout, each problem on stderr, and 1 when there is one.
      const answered = result.value as
        | DocsCheckResult
        | SpecPathResult
        | SpecGrowResult
        | ResearchFound
        | ResearchPlanned
        | DeckDrawn
        | CostsFound;
      if ("page" in answered) {
        environment.stdout(formatDeckDrawn(answered));
        return 0;
      }
      if ("costs" in answered) {
        environment.stdout(formatCostsResult(answered));
        return 0;
      }
      if ("research" in answered) {
        environment.stdout(formatResearchResult(answered));
        return 0;
      }
      if ("spec" in answered) {
        environment.stdout(formatSpecResult(answered));
        return 0;
      }
      const checked = answered;
      environment.stdout(formatDocsSummary(t, files.root, checked));
      if (checked.problems.length > 0) {
        environment.stderr(formatDocsProblems(t, checked));
        return 1;
      }
    } else if (command === "profile") {
      const { profile, previous, action, validation, installs, points, workflow, permissions } =
        result.value as ProfileResult;
      // A workflow given now is recorded in the journal, and the work in progress follows.
      let workflowText = "";
      if (workflow?.given === true) {
        const recorded = await recordGitWorkflow(
          context,
          { workflow: workflow.workflow, previous: workflow.previous },
          "terminal",
        ).catch(() => undefined);
        workflowText = formatWorkflowResult(
          t,
          workflow.workflow,
          recorded instanceof AgentPluggedError ? undefined : recorded,
        );
      }
      const done = action === "updated" ? "profile.recorded" : "profile.unchanged";
      const level = validation === undefined ? "" : formatValidationMode(t, validation.mode);
      const installed = installs === undefined ? "" : formatInstallMode(t, installs.mode);
      const kept = points === undefined ? "" : formatPoints(t, points.points);
      const shown = profile === undefined ? "" : formatProfile(t, profile);
      const permitted = permissions === undefined ? "" : formatPermissionMode(t, permissions.mode);
      environment.stdout(
        `${notesText}${shown}${level}${installed}${kept}${permitted}${workflowText}\n${t(done, { path: METHOD_CONFIG_PATH })}\n`,
      );
      // The agents to generate changed: the AI tools need a new sync.
      const before = previous === undefined ? [] : inactiveAgents(previous);
      if (profile !== undefined && inactiveAgents(profile).join(",") !== before.join(",")) {
        environment.stdout(`${t("sync.next_step")}\n`);
      }
    }
    return exitCode;
  } catch (error) {
    const failure =
      error instanceof AgentPluggedError
        ? error
        : new AgentPluggedError(ErrorCode.UNEXPECTED, "error.unexpected", {
            reason: error instanceof Error ? error.message : String(error),
          });
    reportError(failure);
    return failCode;
  } finally {
    // What the command wrote is sent (at most 5 s), then nothing starts again.
    await backup?.close(BACKUP_FLUSH_MS).catch(() => {});
    journal?.close();
    prompts.close();
  }
}

/**
 * What `init` did with the creator's key, then Windows Hello: linked, proposed at a terminal
 * (« Protéger tes validations avec Windows Hello ? (O/n) », then `key presence`), left for
 * `npx agentplugged key presence` without one, or out of reach (`locale`, said so).
 */
async function reportHumanKey(
  environment: CliEnvironment,
  t: Translate,
  prompts: Prompts,
  registry: ReturnType<typeof createCommandRegistry>,
  context: Parameters<ReturnType<typeof createCommandRegistry>["run"]>[1],
  humanKey: InitHumanKey,
): Promise<void> {
  const say = (text: string) => environment.stdout(`${text}\n`);
  environment.stdout("\n");
  if (humanKey.status === "keychain_unavailable") {
    say(t("init.human.keychain_unavailable", { reason: humanKey.reason ?? "" }));
    return;
  }
  if (humanKey.status === "keychain_full") {
    say(t("init.human.keychain_full"));
    say(t("error.keychain_full", { reason: humanKey.reason ?? "" }));
    return;
  }
  const device = humanKey.device ?? "";
  say(t(humanKey.created === true ? "init.human.created" : "init.human.existing", { device }));
  if (humanKey.published === "written") say(t("init.human.published"));
  else if (humanKey.published === "no_repo") say(t("init.human.no_repo"));
  else if (humanKey.published === "failed") {
    say(t("init.human.publish_failed", { reason: humanKey.publishReason ?? "" }));
  }
  if (humanKey.trust === "pending") say(t("init.human.pending", { device }));
  const presence = humanKey.presence;
  if (presence === undefined) return;
  if (presence.status === "linked") {
    say(t("init.human.presence.linked"));
    return;
  }
  if (presence.status === "unavailable") {
    say(presenceUnavailableText(t, presence.reason));
    return;
  }
  // Windows Hello is there: proposed at a terminal, else left for `key presence`.
  if (environment.interactive !== true || environment.stdin === undefined) {
    say(t("init.human.presence.later"));
    return;
  }
  if (humanKey.published !== "written" && humanKey.published !== "already") {
    say(t("init.human.presence.later"));
    return;
  }
  if (humanKey.trust === "pending") {
    say(t("init.human.presence.later"));
    return;
  }
  // init never fails for Windows Hello: a refusal, a cancelled prompt or a system error (the
  // FFI or `IsUVPAA` throwing) leaves the validations in `locale`, said so.
  try {
    const wanted = await askYesNo(t, prompts.get(), t("init.human.presence.ask"), true);
    if (!wanted) {
      say(t("init.human.presence.declined"));
      return;
    }
    say(t("key.presence.creating"));
    const linked = await registry.run("key", context, { action: "presence" });
    if (!linked.ok) {
      environment.stderr(formatError(t, linked.error));
      say(t("init.human.presence.declined"));
      return;
    }
    environment.stdout(formatKey(t, linked.value as KeyResult));
  } catch (error) {
    if (
      error instanceof GoBack ||
      (error instanceof AgentPluggedError && error.code === ErrorCode.CANCELLED)
    ) {
      say(t("init.human.presence.declined"));
      return;
    }
    say(presenceUnavailableText(t, error instanceof Error ? error.message : String(error)));
  }
}
