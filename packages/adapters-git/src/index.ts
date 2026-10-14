export const packageName = "@agentplugged/adapters-git";

export { NodeEnvironmentProbe, type NodeEnvironmentProbeOptions } from "./environment-probe.js";
export {
  CI_TOOL_TIMEOUT_MS,
  type CiToolRun,
  type CiToolRunner,
  type CiToolRunnerOptions,
  createCiToolRunner,
  ForgeCiReader,
  type ForgeCiReaderOptions,
  forgeOfRemote,
  resolveCiTool,
  runCiTool,
} from "./forge-ci-reader.js";
export { GitCodeSource, type GitCodeSourceOptions } from "./git-code-source.js";
export { GitDocsBase, type GitDocsBaseOptions, type GitRunner } from "./git-docs-base.js";
export {
  cmdArgument,
  createdPullRequest,
  GitForge,
  type GitForgeOptions,
  resolveCommand,
  runTool,
  type ToolRun,
  type ToolRunner,
  toolEnv,
} from "./git-forge.js";
export { GitMainBranchReader, type GitMainBranchReaderOptions } from "./git-main-branch.js";
export { GitMergeProbe, type GitMergeProbeOptions } from "./git-merge-probe.js";
export { type GitRun, runGit } from "./git-process.js";
export {
  anonymousUrlOf,
  classifyAnonymousRead,
  EXPOSURE_TIMEOUT_MS,
  probeExposure,
} from "./git-remote-exposure.js";
export {
  eventFile,
  eventPath,
  GitStateStore,
  type GitStateStoreOptions,
  type GitStateStoreStats,
  isObjectUnavailable,
  JOURNAL_AUTHOR,
  JOURNAL_HEADS_CACHE,
  journalRemoteKey,
  MACHINE_KEY_LOCK,
  REMOTE_TIMEOUT_MS,
} from "./git-state-store.js";
export { GitStoryDiff, type GitStoryDiffOptions } from "./git-story-diff.js";
export { GitStoryWorkspace, type GitStoryWorkspaceOptions } from "./git-story-workspace.js";
export {
  GitTestReferences,
  type GitTestReferencesOptions,
  parseGrepOutput,
} from "./git-test-references.js";
export {
  acquireJournalLock,
  type HeldLock,
  JOURNAL_LOCK_NAME,
  LOCK_HEARTBEAT_MS,
  LOCK_TIMEOUT_MS,
  type LockOptions,
  STALE_LOCK_MS,
} from "./journal-lock.js";
export { NodeChatLog } from "./node-chat-log.js";
export { NodeCodexUserConfig } from "./node-codex-user-config.js";
export { NodeCommonMemory } from "./node-common-memory.js";
export { NodeDecisionLog } from "./node-decision-log.js";
export { NodeFolderReader } from "./node-folder-reader.js";
export {
  KEYCHAIN_ACCOUNT,
  KEYCHAIN_HUMAN_ACCOUNT,
  KEYCHAIN_PRESENCE_ACCOUNT,
  KEYCHAIN_SERVICE,
  KEYCHAIN_SETTLE_DELAYS_MS,
  NodeKeyStore,
} from "./node-key-store.js";
export { NodePresenceAuthenticator } from "./node-presence-authenticator.js";
export { NodeRootPinStore } from "./node-root-pin.js";
export { NodeWorkspaceFiles } from "./node-workspace-files.js";
