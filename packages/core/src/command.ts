import type { PassphraseLimits } from "@agentplugged/crypto";
import { ErrorCode } from "@agentplugged/protocol";
import type { z } from "zod";
import { agentRoleProblem } from "./agents/noah-role.js";
import type { ChatAccess } from "./chat/chat-proof.js";
import type { CreatorPrompt } from "./chat/decision-prompt.js";
import type { QuestionToolAccess } from "./chat/question-tool.js";
import type { CiReader } from "./ci/ci-reader.js";
import type { DocsBase } from "./docs/docs-base.js";
import type { EnvironmentProbe } from "./doctor/environment-probe.js";
import type { EngineUpdates } from "./engine-update.js";
import { AgentPluggedError } from "./errors.js";
import type { PresencePrompt } from "./human/human-events.js";
import type { PresenceAuthenticator } from "./human/presence.js";
import { checkEngine, type EngineCheck } from "./init/engine-check.js";
import type { JournalBackup } from "./journal/journal-backup.js";
import type { JournalSync } from "./journal/journal-sync.js";
import type { KeyStore, MachineLock } from "./journal/key-store.js";
import type { StateStore } from "./journal/state-store.js";
import type { Clock, UlidFactory } from "./journal/ulid.js";
import type { CommonMemory } from "./memory/common-memory.js";
import type { MergeProbe } from "./merge/merge-probe.js";
import type { MethodSource } from "./method/method-source.js";
import type { FormatMigration } from "./migrate/migrations.js";
import { withUpgradeTarget } from "./migrate/upgrade-target.js";
import type { ProofRunner } from "./proofs/proof-runner.js";
import type { MutationLab } from "./quality/mutation-run.js";
import type { CodeSource } from "./reuse/reuse.js";
import type { StoryDiff } from "./review/review-diff.js";
import type { MainBranchReader } from "./rules/main-branch.js";
import type { StoryForge } from "./stories/story-forge.js";
import type { StoryWorkspace } from "./stories/story-workspace.js";
import type { ExtensionMcpServer } from "./sync/mcp.js";
import type { ToolProbe } from "./tools/tool-probe.js";
import type { TestReferenceSource } from "./trace/test-references.js";
import type { FolderReader } from "./trust/install-folders.js";
import type { AgentSession } from "./trust/session.js";
import type { RootPinStore } from "./trust-devices/root-pin.js";
import type { CostSource } from "./usage/product-costs.js";
import type { UsageTraces } from "./usage/usage-traces.js";
import type { WorkspaceFiles } from "./workspace-files.js";

/**
 * Who triggers a command: the creator (the CLI), or an agent acting for them (the MCP server).
 * The surface sets it; it is never read from the input.
 */
export type Actor = "human" | "agent";

export interface CommandContext {
  readonly files: WorkspaceFiles;
  /** Looks at the machine for AI tools. */
  readonly tools: ToolProbe;
  /**
   * Looks at the machine for `doctor` and repairs it: programs, the forge's tool,
   * ports, memory, the keychain. Given by the CLI and the MCP server; absent: nothing is checked.
   */
  readonly environment?: EnvironmentProbe;
  /** The method shipped with the engine (agents and skills copied by `init`). */
  readonly method: MethodSource;
  readonly actor: Actor;
  /** Version of the running engine, written to new `method.yaml` files. */
  readonly engineVersion: string;
  /**
   * The version of the engine package installed now, read again at each call: a
   * server started before an update sees it differ from `engineVersion`.
   */
  readonly installedEngineVersion?: () => Promise<string | undefined>;
  /**
   * The engine's updates on this machine: the registry's announcement, the settings,
   * the installation of a version in its own folder. Given by the MCP server; absent elsewhere.
   */
  readonly engineUpdates?: EngineUpdates;
  /** `--engine-any`: run even when `method.yaml` pins another engine version (a warning). */
  readonly engineAny?: boolean;
  /** The command as the creator typed it, quoted in the engine version messages. */
  readonly commandLine?: string;
  /** Makes new ULIDs (`product_id`); the system clock and random source when absent. */
  readonly newId?: UlidFactory;
  /** The product's journal: `init` adopts the product id it holds. */
  readonly journal?: StateStore;
  /** The Git operations of `journal sync`. */
  readonly journalSync?: JournalSync;
  /**
   * The automatic backup of the journal: given by the MCP server, which keeps it
   * running. `get_state` and `next` say when it is stuck; a gesture that fixes it asks it to try again.
   */
  readonly journalBackup?: Pick<JournalBackup, "report" | "kick">;
  /** Applies the event types reserved to tests (`test.*`): tests only, never the CLI. */
  readonly allowTestTypes?: boolean;
  /** The operating system (`process.platform`): `sync` adapts the MCP server launch to Windows. */
  readonly platform?: string;
  /** The clock (milliseconds): deadlines of waivers. The system clock when absent. */
  readonly now?: Clock;
  /**
   * True when someone answers at a terminal (standard input and output both terminals): `review`
   * and `key` refuse to run otherwise (`REVIEW_NOT_INTERACTIVE`).
   */
  readonly interactive?: boolean;
  /**
   * The creator's key: given by the CLI to its creator's commands only, never to the
   * MCP server. Without it, `init` installs no key, and `review` and `key` cannot sign.
   */
  readonly human?: HumanAccess;
  /**
   * The root of trust this machine pinned for a product, outside the repository:
   * given by the CLI, read by `trust dismiss` and by the surfaces that decide who is trusted.
   */
  readonly rootPins?: RootPinStore;
  /**
   * The product's folder on this machine, absolute: `sync` writes the folder of the
   * stories' working copies in Codex's `writable_roots`. Given by the CLI and the MCP server.
   */
  readonly projectRoot?: string;
  /** Reads the documents of a base version (`docs check`). */
  readonly docsBase?: DocsBase;
  /**
   * The optional extension point: gives the measured cost of the stories of
   * a plan, for a module that reads it. The engine never prints what it returns. Absent here.
   */
  readonly costSource?: CostSource;
  /**
   * MCP servers a program built on the engine asks `sync` to declare next to the engine's own in the
   * tools' MCP files (Claude Code and Cursor). The engine never knows what they serve. Absent:
   * none, and any entry `sync` recorded earlier is removed.
   */
  readonly extensionServers?: readonly ExtensionMcpServer[];
  /**
   * Where `history --export` writes, resolved once by the surface: the file's existing folder
   * (possibly outside the product's folder) and the file's name in it.
   */
  readonly exportTarget?: { readonly files: WorkspaceFiles; readonly name: string };
  /**
   * The system keychain, for the product key only: the CLI and the MCP server read
   * it to decrypt sensitive content (projection, `read_sensitive`) and encrypt it
   * (`write_sensitive`). The creator's commands fall back on `human.keys`.
   */
  readonly keys?: KeyStore;
  /**
   * Reads `method.yaml` on the main branch: `sync` and `rules` take the permission rules
   * from there. Without it, the working copy's rules apply.
   */
  readonly mainBranch?: MainBranchReader;
  /**
   * The AI tool's session the call belongs to: one per MCP server, which keeps what
   * made it untrusted. Absent for a call outside the server: untrusted, by caution.
   */
  readonly session?: AgentSession;
  /**
   * The format migrations `migrate` applies: tests only, with their own fixture
   * steps; the registry shipped with the engine (`METHOD_MIGRATIONS`) when absent.
   */
  readonly migrations?: readonly FormatMigration[];
  /**
   * The Git operations of `story start` and `start_story`: the story's branch, its
   * worktree and the commit hook.
   */
  readonly storyWorkspace?: StoryWorkspace;
  /**
   * The Git and forge operations of `story pr` and `open_pull_request`: the push of
   * the story's branch and the forge's command-line tool. Tests give a fake one.
   */
  readonly storyForge?: StoryForge;
  /**
   * Reads the CI of a story's pull request through the forge's tool (`story ci`,
   * `check_ci`), and the forge of the repository (`ci setup`).
   */
  readonly ciReader?: CiReader;
  /**
   * Reads the lines of the test files that may cite a requirement (`trace`,
   * `get_trace`), through Git. Without it, the tests are not read.
   */
  readonly testReferences?: TestReferenceSource;
  /**
   * The diff of a story's branch (`start_review`, `submit_review`), through Git; also what the engine reads of a
   * story in the fast track. Without it, no review starts and nothing is read.
   */
  readonly storyDiff?: StoryDiff;
  /**
   * Starts the commands the project declares for its proofs (`run_proof_command`),
   * once the creator accepted them. Given by the MCP server only. Without it, no command is run.
   */
  readonly proofRunner?: ProofRunner;
  /**
   * Makes the throwaway copy of a working copy in which the mutation check breaks the code and runs
   * the tests the creator accepted (`review_tests`). Given by the MCP server only.
   * Without it, no mutation check runs.
   */
  readonly mutationLab?: MutationLab;
  /**
   * The source files of the repository at a commit (`start_review`, `submit_review`):
   * what the engine compares the added code with to prove a duplicate. Without it, no duplicate is
   * looked for.
   */
  readonly codeSource?: CodeSource;
  /**
   * What `mergeStory` and `qualify_merge_conflict` read of Git to order the merges and read the
   * conflicts with the main branch: without it the forge alone judges a conflict.
   */
  readonly mergeProbe?: MergeProbe;
  /** How long the engine remembers what the forge showed before reading it again (next and get_state; check_ci always reads). Default 20 000 ms; tests give 0. */
  readonly forgeThrottleMs?: number;
  /**
   * The chat's proof: the creator's messages the AI tool's hook recorded on this
   * machine, read by `answer_checkpoint`, and whether the tool that started the MCP server has
   * that hook. Given by the MCP server only.
   */
  readonly chat?: ChatAccess;
  /**
   * Asks the creator in the AI tool's form (`ask_creator`): given by the MCP server
   * only, and only when its client announced that it shows forms (`elicitation.form`). Absent:
   * the engine cannot ask, and the agent asks in the chat.
   */
  /**
   * The call an engine's merge belongs to: set by `answer_checkpoint`, `ask_creator`
   * and `review` for one call, so a merge done by another call is never taken for its own.
   */
  readonly mergeToken?: symbol;
  /**
   * The Antigravity conversation the call comes from: the client names it in the
   * request's `_meta` (`antigravity.google/conversation_id`), which an agent cannot set. Given by
   * the MCP server only, for one call. An answer from the chat is proved by the messages of that
   * conversation alone (`proofSession`): never those of another conversation, a sub-agent's, or a
   * session an agent started itself.
   */
  readonly conversation?: string;
  readonly creatorPrompt?: CreatorPrompt;
  /**
   * The AI tool's question tool as a channel of the engine's decisions: given by the MCP
   * server only, and only when the tool is Claude Code. The engine dictates the questions, the agent
   * asks them, and a hook records the creator's answer (`chat.decisions`).
   */
  readonly questionTool?: QuestionToolAccess;
  /**
   * The common memory of the creator's products on this machine: the folder
   * `~/.agentplugged/memory/`, read by `read_memory` and written by `promote_lesson`. Given by the
   * MCP server only. Absent: no common memory here.
   */
  readonly commonMemory?: CommonMemory;
  /**
   * Opens the working copy of a story of this product: an installation written
   * `cd <working copy> && npm install …` is read in that copy's own files. Given by the MCP server
   * only. Absent: only the product's own folder is read.
   */
  readonly folders?: FolderReader;
  /**
   * The traces the AI tools keep on this machine: Claude Code's transcripts, Codex's
   * rollouts, read by `measure_usage` and at the end of an agent's result. Given by the MCP
   * server only. Absent: the engine measures nothing here.
   */
  readonly usageTraces?: UsageTraces;
  /**
   * How long the guard before a write (`check_write`) waits for the journal before it
   * lets the write through in doubt, in milliseconds. 400 when absent; tests give their own.
   */
  readonly writeGuardBudgetMs?: number;
  /**
   * How long the guard before every tool call (`check_call`) waits for the journal and the
   * traces before it lets the call through in doubt, in milliseconds. 1500 when absent.
   */
  readonly callGuardBudgetMs?: number;
}

/** What the creator's commands need to sign: the keychain, its lock, the platform authenticator. */
export interface HumanAccess {
  readonly keys: KeyStore;
  /** The machine-wide lock of key creation. */
  readonly lock?: MachineLock;
  /** The platform WebAuthn authenticator (Windows Hello), for the `presence` assurance. */
  readonly presence?: PresenceAuthenticator;
  /** Shows what is signed and its fingerprint, just before the system's prompt. */
  readonly onPresencePrompt?: (prompt: PresencePrompt) => void | Promise<void>;
  /**
   * Reads a secret at the terminal, without echoing it (`key export` and
   * `key import`): `new` and `again` for a new passphrase, `enter` for the one of an export,
   * `export` for the exported key itself (never on the command line). The end of the input throws
   * `CANCELLED`. Tests give a simulated one.
   */
  readonly askPassphrase?: (prompt: PassphrasePrompt) => Promise<string>;
  /**
   * Asks a visible confirmation (replacing the product key held here); the answer is
   * checked by core (« je confirme »). The end of the input throws `CANCELLED`.
   */
  readonly askConfirmation?: (prompt: ConfirmationPrompt) => Promise<string>;
  /** Argon2id limits of `key export` and `key import`: `moderate` by default; tests give `min`. */
  readonly passphraseLimits?: PassphraseLimits;
}

/** Which secret is asked: a new passphrase, the same again, an export's one, or the export. */
export type PassphrasePrompt = "new" | "again" | "enter" | "export";

/** A confirmation `key import` asks before replacing the product key held on this machine. */
export interface ConfirmationPrompt {
  readonly kind: "replace_product_key";
  readonly held_key_id: string;
  readonly key_id: string;
}

export type CommandInput = Readonly<Record<string, unknown>>;

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgentPluggedError };

export interface Command<T = unknown> {
  readonly name: string;
  run(context: CommandContext, input: CommandInput): Promise<CommandResult<T>>;
  /** True when this run replaces the pinned engine version (`init --upgrade-engine`). */
  upgradesEngine?(input: CommandInput): boolean;
  /**
   * An agent's command that may run on an engine older than the one the product pins:
   * a session that could not move to the pinned version yet reads that it must (`next`,
   * `get_state`) and carries out the creator's « oui » to the update (`request_creator_action`,
   * `answer_checkpoint`, `ask_creator` on the point of that update). Every other command refuses, as
   * it always did, until the session runs the version the product pins.
   */
  allowsOlderEngine?(context: CommandContext, input: CommandInput): boolean | Promise<boolean>;
  /** True for `migrate`: runs on an older `format_version` and pins this engine. */
  readonly migratesFormat?: boolean;
  /**
   * Who may run it: the creator (`human`, the default) or agents only (`agent`). The registry
   * refuses a command to the other actor as unknown: the CLI never runs an agent's command, and
   * the MCP server exposes nothing else.
   */
  readonly audience?: Actor;
  /** An agent's command: what it does, in English (its MCP tool description). */
  readonly description?: string;
  /** An agent's command: the schema of its input (its MCP tool input schema). */
  readonly inputSchema?: z.ZodType;
}

export function defineCommand<T>(command: Command<T>): Command<T> {
  return command;
}

export function ok<T>(value: T): CommandResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(error: AgentPluggedError): CommandResult<T> {
  return { ok: false, error };
}

/** The registry's key of a command: its audience and its name (`next` exists for both). */
function keyOf(audience: Actor, name: string): string {
  return `${audience}:${name}`;
}

/** Single entry point shared by every surface: the CLI (the creator) and the MCP server (agents). */
export class CommandRegistry {
  /**
   * The commands by audience and name: the creator's command and the agents' command of the same
   * name (`next`) are two commands, each run by its own actor only.
   */
  readonly #commands = new Map<string, Command>();

  constructor(commands: ReadonlyArray<Command> = []) {
    for (const command of commands) this.register(command);
  }

  register(command: Command): this {
    const key = keyOf(command.audience ?? "human", command.name);
    if (this.#commands.has(key)) {
      throw new Error(`Command already registered: ${command.name}`);
    }
    this.#commands.set(key, command);
    return this;
  }

  /** Names of the creator's commands (those the CLI may run). */
  names(): string[] {
    return [...this.#commands.values()]
      .filter((command) => (command.audience ?? "human") === "human")
      .map((command) => command.name);
  }

  /** The commands reserved to agents, in registration order: what the MCP server exposes. */
  agentCommands(): Command[] {
    return [...this.#commands.values()].filter((command) => command.audience === "agent");
  }

  async run(
    name: string,
    context: CommandContext,
    input: CommandInput = {},
  ): Promise<CommandResult<unknown>> {
    const command = this.#commands.get(keyOf(context.actor, name));
    // A command of the other actor is unknown to this one: an agent never runs `init` or `sync`
    // through the registry, and the creator's CLI never writes an agent's event.
    if (!command || (command.audience ?? "human") !== context.actor) {
      return fail(
        new AgentPluggedError(ErrorCode.UNKNOWN_COMMAND, "error.unknown_command", {
          command: name,
        }),
      );
    }
    // Noah calls only the commands of his contract: checked here, at the
    // single entry point, before anything is read or written.
    if (context.actor === "agent") {
      const outside = await agentRoleProblem(name, input, context.files);
      if (outside !== undefined) return fail(outside);
    }
    // The pinned engine version is checked before the command reads or writes anything.
    const migrate = command.migratesFormat === true;
    const typed = context.commandLine ?? name;
    const engine: EngineCheck | AgentPluggedError = await checkEngine(context.files, {
      engineVersion: context.engineVersion,
      engineAny: context.engineAny === true,
      upgrade: migrate || command.upgradesEngine?.(input) === true,
      migrate,
      command: typed,
    });
    // A product that needs a newer engine, or a migration, says what to install or run, in words
    // for whoever asks.
    const refine = (error: AgentPluggedError, pinned: string | undefined) =>
      withUpgradeTarget(error, {
        engineVersion: context.engineVersion,
        pinned,
        command: typed,
        actor: context.actor,
      });
    let checked = engine;
    if (
      checked instanceof AgentPluggedError &&
      checked.message_key === "error.engine_version_too_old" &&
      context.actor === "agent" &&
      (await command.allowsOlderEngine?.(context, input)) === true
    ) {
      // The way out of that very state, through the creator's one « oui ».
      checked = { pinned: checked.details.pinned as string, overridden: true, older: true };
    }
    if (checked instanceof AgentPluggedError) return fail(refine(checked, undefined));
    const result = await command.run(context, input);
    if (!result.ok) return fail(refine(result.error, checked.pinned));
    return result;
  }
}
