import { agentActivityCommands, planSprintCommand } from "./agent-activity/agent-commands.js";
import { checkEnvironmentCommand, doctorCommand } from "./doctor/doctor-commands.js";
import { provideToolManual } from "./mcp-tools-manual.js";
import { measureUsageCommand } from "./usage/usage-commands.js";
import { usageCommand } from "./usage/usage-report-command.js";

export {
  type BlockingCheckpoint,
  blockedResultCheckpoint,
  blockingCheckpoint,
  blockScope,
  byOpening,
  checkpointPayload,
  confirmationFor,
  DEFAULT_RECIPIENTS,
  openBlockedResultCheckpoint,
  type ReusableCheckpoint,
  recipientFor,
  satisfies,
  verdictOf,
} from "./checkpoints/checkpoint-rules.js";

import { agentCommand } from "./agents/agent-command.js";
import { checkCallCommand } from "./budget/call-command.js";
import { answerCheckpointCommand } from "./chat/answer-command.js";
import { askCreatorCommand } from "./chat/ask-command.js";
import { answerStackCommand, askStackCommand, openStackCommand } from "./chat/stack-commands.js";
import { decideCheckpointCommand } from "./checkpoints/decide-command.js";
import { checkCiCommand } from "./ci/ci-check.js";
import { ciCommand } from "./ci/ci-setup.js";
import { type Command, CommandRegistry } from "./command.js";
import { courseAgentCommands } from "./course/course-commands.js";
import { requestCreatorActionCommand } from "./creator-actions/request-command.js";
import { workshopCommand } from "./creator-actions/workshop-command.js";
import { criterionAgentCommands } from "./criteria/criterion-command.js";
import { critiqueAgentCommands } from "./critique/critique-commands.js";
import { deferredAgentCommands, deferredCommand } from "./deferred/deferred-commands.js";
import { delegateCommand } from "./delegation/delegate-command.js";
import { docsCommand } from "./docs/docs-command.js";
import { summarizeCommand } from "./exchange/summarize-command.js";
import { leaveFastTrackCommand } from "./fast-track/fast-track-commands.js";
import { historyCommand } from "./history/history-command.js";
import { keyCommand, reviewCommand } from "./human/human-commands.js";
import { initCommand } from "./init/init-command.js";
import { journalCommand } from "./journal/journal-command.js";
import { loopAgentCommands } from "./loop/loop-command.js";
import { memoryCommands } from "./memory/index.js";
import { mergeOrderAgentCommands } from "./merge/merge-order-commands.js";
import { migrateCommand } from "./migrate/migrate-command.js";
import { nextAgentCommand, nextCommand } from "./next/next-command.js";
import { profileCommand } from "./profile/profile-command.js";
import { proofAgentCommands } from "./proofs/proof-run-command.js";
import { publicationCommand } from "./publications/publication-command.js";
import { qaAgentCommands } from "./qa/qa-command.js";
import { qualityAgentCommands } from "./quality/review-tests-command.js";
import { readinessAgentCommands } from "./readiness/readiness-command.js";
import { requirementAgentCommands } from "./requirements/requirement-commands.js";
import { reviewAgentCommands } from "./review/review-commands.js";
import { rulesCommand } from "./rules/rules-command.js";
import { sensitiveCommands } from "./sensitive/sensitive-commands.js";
import { openPullRequestCommand } from "./stories/pull-request.js";
import { startStoryCommand, storyCommand } from "./stories/story-start.js";
import { syncCommand } from "./sync/sync-command.js";
import { roundTableAgentCommands } from "./table/table-commands.js";
import { pauseTeamCommand } from "./team/pause-team-command.js";
import { testsCommand } from "./test-frame/tests-setup.js";
import { traceAgentCommands, traceCommand } from "./trace/trace-commands.js";
import { trustCommands } from "./trust/trust-commands.js";
import { trustDevicesCommand } from "./trust-devices/trust-command.js";
import { checkWriteCommand } from "./write-guard/write-command.js";

export const packageName = "@agentplugged/core";

export {
  type AgentPhaseView,
  type AgentValidationView,
  agentActivityCommands,
  type FullStateView,
  getStateCommand,
  type OpenPoint,
  openCheckpointCommand,
  planSprintCommand,
  type RecordedEvent,
  reportCostCommand,
  reportMeasuresCommand,
  reportProgressCommand,
  reportStatusCommand,
  submitResultCommand,
  updateStoryCommand,
} from "./agent-activity/agent-commands.js";
export {
  type AgentDigest,
  type AgentStateView,
  abridgeState,
  type CheckpointDigest,
  type CheckpointView,
  fitState,
  type GetStateResult,
  type ResultDigest,
  STATE_LIMITS,
  STATE_MAX_CHARS,
  type StateDetail,
  type StateLimits,
  type StoryDigest,
  stateDetail,
  stateSize,
  type TruncatedEntry,
} from "./agent-activity/state-view.js";
export {
  aliasAgent,
  aliasEvent,
  currentDeveloper,
  documentOwner,
  FORMER_AGENT_IDS,
  FORMER_AGENT_NAMES,
  isRetiredDeveloper,
  RENAMED_AGENTS,
  RENAMED_AGENTS_FORMAT,
  RETIRED_DEVELOPERS,
} from "./agents/agent-aliases.js";
export {
  AGENT_ACTIONS,
  type AgentAction,
  type AgentCommandResult,
  type AgentOrigin,
  agentCommand,
  checkCreate,
  definitionDir,
  type SettingsOutcome,
  toggledLists,
  writeAgentLists,
} from "./agents/agent-command.js";
export {
  changedSettings,
  type SettingsChange,
  settingsChange,
  TIER_DEFAULT,
  TOOL_NONE,
  writeAgentSettings,
} from "./agents/agent-settings.js";
export {
  AGENT_ONLY_FIELDS,
  CREATE_FIELDS,
  type CreateField,
  givenAnswers,
  REQUIRED_FIELDS,
  validateCreateField,
  validateGivenAnswers,
} from "./agents/create-fields.js";
export {
  AGENT_OVERRIDES_DIR,
  checkActiveMenus,
  loadOverrides,
  mergeAgent,
  overridePath,
  parseOverride,
  renderOverrideTemplate,
} from "./agents/overrides.js";
export {
  ensurePersonalIgnore,
  FILE_CAP,
  isPersonalLayerFile,
  LOADED_FILE_CAP,
  layerProblems,
  layersProblems,
  loadSkillLayers,
  loadSkillOverrides,
  mergedLayers,
  mergeSkillOverrides,
  type OverrideCost,
  overrideCost,
  overrideCostWithFiles,
  PERSONAL_IGNORE,
  parseSkillOverride,
  renderSkillCustomisation,
  renderSkillOverrideTemplate,
  SECTION_CAP,
  SKILL_OVERRIDES_DIR,
  type SkillLayer,
  type SkillLayers,
  skillOverridePath,
  skillSections,
  withCustomisation,
} from "./agents/skill-overrides.js";
export {
  displayName,
  NAME_MAX,
  type NewAgent,
  type NewSkill,
  renderAgentSkillTemplate,
  renderAgentYamlTemplate,
  renderSkillTemplate,
} from "./agents/templates.js";
export {
  analyze as analyzeDefinition,
  type Check as WorkshopCheck,
  type Finding as WorkshopFinding,
  isSkeleton,
  verify as verifyDefinition,
} from "./agents/workshop-analysis.js";
export { buildFromContent } from "./agents/workshop-build.js";
export {
  BODY_CAP,
  type Cost as WorkshopCost,
  DESCRIPTION_CAP,
  draftProblems,
  hasTrigger,
  type Problem as WorkshopProblem,
  unsafeProblems,
} from "./agents/workshop-rules.js";
export {
  ACTION_DECISIONS,
  answerable,
  assuranceOf,
  blocksInForce,
  type ExpiringCheckpoint,
  explicitConfirmed,
  liftsBlocks,
  parseWaiverAnswer,
  type ResolvableCheckpoint,
  type ReviewAction,
  resolutionProblem,
  reviewActions,
  statusAt,
  type WaiverRefusal,
  waiverDeadlineProblem,
  waiverExpired,
  waiverRefusal,
} from "./checkpoints/resolution-rules.js";
export {
  answeredElsewhere,
  carryOutWebAnswers,
  undoWebAnswer,
  type WebAnswer,
  type WebAnswerCheck,
  type WebAnswerWrite,
  type WebCarryOut,
  type WebDecided,
  type WebMerging,
  type WebUndo,
  type WebUndoWrite,
  webAnswerCheck,
  writeWebAnswer,
} from "./checkpoints/web-answer.js";
export { engineMerging } from "./checkpoints/web-merge.js";
export {
  type Actor,
  type Command,
  type CommandContext,
  type CommandInput,
  CommandRegistry,
  type CommandResult,
  type ConfirmationPrompt,
  defineCommand,
  fail,
  type HumanAccess,
  ok,
  type PassphrasePrompt,
} from "./command.js";
export {
  WorkshopInputSchema,
  type WorkshopResult,
  workshopCommand,
} from "./creator-actions/workshop-command.js";
export {
  completeDeferredCommand,
  type DeferredClosed,
  type DeferredList,
  type DeferredResult,
  type DeferredShown,
  deferredCommand,
  deferWorkCommand,
} from "./deferred/deferred-commands.js";
export {
  agentMayClose,
  type DeferredClosing,
  type DeferredItem,
  type DeferredView,
  deferredItems,
  deferredLocks,
  deferredView,
  openDeferred,
  storyLockProblem,
} from "./deferred/deferred-rules.js";
export {
  avoidPhrases,
  BRAND_PATH,
  brandDocumentChecks,
  IDENTITY_PAGE_PATH,
  IDENTITY_PATH,
  identityTokensOf,
} from "./docs/brand-documents.js";
export { checkBrandRules, flattenTokens, readRules } from "./docs/brand-rules.js";
export {
  type CheckDocumentsInput,
  checkDocuments,
  checkDocumentsDetailed,
  type DocsProblem,
  type DocsWarning,
  type DocumentsCheck,
} from "./docs/check-docs.js";
export { type DeckPage, escapeHtml, renderDeckPage } from "./docs/deck-page.js";
export type { DocsBase, DocsBaseRead, DocumentFile } from "./docs/docs-base.js";
export {
  DEFAULT_DOCS_BASE,
  type DeckDrawn,
  DOCS_ACTIONS,
  DOCUMENT_PATHS,
  type DocsAction,
  type DocsCheckResult,
  type DocsWithoutBase,
  docsCommand,
  isDocumentPath,
  readDocumentFiles,
} from "./docs/docs-command.js";
export {
  type DocumentSearchResult,
  searchDocuments,
  searchTerms,
} from "./docs/document-search.js";
export { forgeDocumentChecks, isForgeFile } from "./docs/forge-documents.js";
export {
  type ApprovedStoryDocument,
  approvedStoryDocuments,
  frozenIntents,
  type MismatchedStoryPath,
  readApprovedStory,
  storyDocumentsOf,
} from "./docs/frozen-intents.js";
export {
  IDEATION_DIR,
  ideationDocumentChecks,
  isIdeationSession,
} from "./docs/ideation-documents.js";
export {
  type IntentPreview,
  intentPreviews,
} from "./docs/intent-preview.js";
export { KNOWLEDGE_BASE_INDEX_PATH, KNOWLEDGE_BASE_WRITER } from "./docs/knowledge-base.js";
export {
  blobIdsOf,
  comparablePath,
  isKnowledgePage,
  type KnowledgePage,
  knowledgePages,
  knowledgePagesOf,
  type MergedStoryRef,
  mergedStoriesOf,
  pathKey,
  type StaleSource,
  type StaleStory,
  staleKnowledgeSources,
  staleKnowledgeStories,
  type TrackedSource,
  type ValidatedVersion,
  validatedVersions,
} from "./docs/knowledge-freshness.js";
export {
  type LateReason,
  lateReasons,
  syncLateNotices,
  withLateNotice,
} from "./docs/knowledge-notice.js";
export {
  KB_SELECT_MAX_CHARS,
  KB_SELECT_MAX_PASSAGES,
  type KnowledgeBaseView,
  type KnowledgePassage,
  knowledgeBaseView,
  passagesOf,
  type SelectedPassages,
  selectPassages,
  type VerifiedAnswer,
  verifyAnswer,
} from "./docs/knowledge-search.js";
export {
  deliverableStatus,
  isLaunchContent,
  isLaunchPage,
  isPositioning,
  LAUNCH_CAMPAIGNS_DIR,
  LAUNCH_CONTENT_DIR,
  LAUNCH_PAGES_DIR,
  type LaunchCheck,
  type LaunchCheckInput,
  launchDocumentChecks,
  POSITIONING_PATH,
  type PositioningState,
  type PositioningStatus,
  positioningStatus,
} from "./docs/launch-documents.js";
export {
  comparableText,
  type Definition as RequirementDefinition,
  type ParsedDocument,
  type Placeholder,
  parseDefinitionLine,
  parseDefinitions,
  parseDocumentFile,
  parseSections,
  placeholdersOf,
  type Section,
  type StoryFields,
  scanBody,
  sectionText,
} from "./docs/parse-document.js";
export {
  DECK_PAGE_PATH,
  DECK_PATH,
  DESIGN_DIR,
  NARRATIVE_PATH,
  pitchDocumentChecks,
  pitchKindOf,
} from "./docs/pitch-documents.js";
export { prfaqDocumentChecks } from "./docs/prfaq-documents.js";
export type { SectionsRead } from "./docs/read-command.js";
export {
  type ResearchFound,
  type ResearchHit,
  researchLine,
  researchLines,
} from "./docs/research-find.js";
export {
  planImport,
  planLines,
  planRun,
  type ResearchPlanned,
} from "./docs/research-plan.js";
export {
  isOffer,
  isSequence,
  OFFERS_DIR,
  SEQUENCES_DIR,
  salesDocumentChecks,
} from "./docs/sales-documents.js";
export type { SheetsWritten, SheetWritten } from "./docs/sheet-command.js";
export {
  type ApprovedStory,
  checkIntents,
  compareStories,
  type IntentCheck,
  intentOf,
  storyOrder,
} from "./docs/story-rules.js";
export {
  fingerprintOf as sheetFingerprintOf,
  SHEET_MAX_LINES,
  type SheetState,
  type StaleExcerpt,
  sheetStates,
} from "./docs/story-sheet.js";
export {
  STRATEGY_DIR,
  strategyDocumentChecks,
  strategyKindOf,
} from "./docs/strategy-documents.js";
export {
  type UxCheck,
  type UxElement,
  uxDocumentChecks,
  uxElementsOf,
} from "./docs/ux-documents.js";
export { type MockupFault, mockupFaults } from "./docs/ux-mockup.js";
export {
  type EngineAutoUpdate,
  type EngineRelease,
  type EngineUpdate,
  type EngineUpdated,
  type EngineUpdateFailure,
  type EngineUpdateSettings,
  type EngineUpdates,
  engineTargetOf,
  installAndPin,
  maybeAutoUpdate,
  type UpdateAvailable,
} from "./engine-update.js";
export { AgentPluggedError } from "./errors.js";
export {
  cursorOfEvents,
  type ImportTotals,
  type PublishedStateOptions,
  type PublishedStateRead,
  publishedPhases,
  readPublishedState,
} from "./feed/published-state.js";
export { publishedStoryDocs, STORY_FILES_DIR, type StoryFileText } from "./feed/story-docs.js";
export {
  type DetectedFacts,
  type DetectedWorkflow,
  detectGitWorkflow,
  STAGING_BRANCH_NAMES,
} from "./git/detect-workflow.js";
export {
  type GitView,
  gitView,
  type ReleaseBrake,
  type StagingView,
  type WaitingStory,
} from "./git/git-view.js";
export {
  lastRelease,
  type ReleaseRecord,
  repositoryOnForge,
  sameGitWorkflow,
  stagedStories,
  validateGitWorkflow,
  type WorkflowImplication,
  type WorkflowRecord,
  type WorkflowView,
  workflowImplications,
  workflowOf,
  writeGitWorkflow,
} from "./git/git-workflow.js";
export {
  recordGitRelease,
  recordGitWorkflow,
  type WorkflowRecorded,
} from "./git/record-workflow.js";
export {
  filterHistory,
  HISTORY_COLUMNS,
  HISTORY_CSV_COLUMNS,
  type HistoryEntry,
  type HistoryFilters,
  type HistoryFormat,
  historyCsv,
  historyEntries,
  historyFormatOf,
  historyJson,
  type IgnoredValidation,
  ignoredValidations,
  parseHistoryFilters,
  parseSince,
} from "./history/history.js";
export {
  type HistoryExport,
  type HistoryResult,
  historyCommand,
} from "./history/history-command.js";
export {
  type InitHumanKey,
  installHumanKey,
  KEY_ACTIONS,
  type KeyEndorseResult,
  type KeyPresenceResult,
  type KeyResult,
  keyCommand,
  type PendingKey,
  type PresenceState,
  type PresenceStatus,
  type ReviewList,
  type ReviewResolved,
  type ReviewResult,
  reviewCommand,
  reviewNotInteractive,
} from "./human/human-commands.js";
export {
  checkHumanEvents,
  fingerprintOf,
  type HumanDraft,
  type HumanSigner,
  linkPayload,
  localeSigner,
  type PresencePrompt,
  prepareHumanEvents,
  presenceSigner,
} from "./human/human-events.js";
export {
  type HumanKey,
  humanDevice,
  loadHumanKey,
  readStoredPresence,
  storePresence,
} from "./human/human-key.js";
export {
  type PresenceAuthenticator,
  type PresenceAvailability,
  type PresenceUnavailableReason,
  type PresenceUser,
  unavailablePresence,
} from "./human/presence.js";
export {
  type InitProductKey,
  installProductKey,
  type KeyExportResult,
  type KeyImportResult,
  type KeySealResult,
  sealFiles,
} from "./human/product-key-commands.js";
export {
  constitutionTarget,
  renderConstitution,
  renderConstitutionReference,
  renderConstitutionReferenceFiles,
} from "./init/constitution.js";
export {
  checkEngine,
  compareSemver,
  type EngineCheck,
  type EngineCheckOptions,
} from "./init/engine-check.js";
export { detectExistingProduct, isExistingProduct } from "./init/existing-product.js";
export {
  BLOCK_BEGIN,
  BLOCK_END,
  GENERATED_HEADER,
  GENERATED_HEADER_HASH,
  importsOutsideBlock,
  isGenerated,
  type PointerStyle,
  pointerBlock,
  renderImportFile,
  withGeneratedHeader,
} from "./init/generated.js";
export {
  type InitAction,
  type InitEntry,
  type InitResult,
  initCommand,
} from "./init/init-command.js";
export {
  INSTALL_CHANNEL_PATH,
  INSTALL_CHANNELS,
  type InstallChannel,
  readInstallChannel,
  validateInstallChannel,
  writeInstallChannel,
} from "./init/install-channel.js";
export {
  METHOD_CONFIG_PATH,
  METHOD_CONSTITUTION_PATH,
  METHOD_DIR,
  METHOD_SUBDIRS,
  MODELS_PATH,
  REFERENCE_DIR,
  referenceFilePath,
} from "./init/layout.js";
export { loadMethodConfig, ROOT_FIELD, writeEngineVersion } from "./init/method-config.js";
export {
  BACKUP_BLOCKS,
  type BackupBlock,
  type BackupRemote,
  isAccessRefusal,
  JOURNAL_REMOTE_NAME,
  JournalBackup,
  type JournalBackupOptions,
  type JournalBackupPort,
  type JournalBackupView,
  type RemoteExposure,
} from "./journal/journal-backup.js";
export {
  JOURNAL_ACTIONS,
  type JournalAction,
  journalCommand,
} from "./journal/journal-command.js";
export {
  type JournalFiles,
  type JournalIntegration,
  type JournalSync,
  type JournalSyncResult,
  type JournalWriter,
  MAX_PUSH_ATTEMPTS,
  noRemote,
  type PushOutcome,
  type RemoteCallOptions,
  type RemoteFetch,
  type SyncJournalOptions,
  syncJournal,
} from "./journal/journal-sync.js";
export {
  type KeyStore,
  keychainFull,
  loadMachineKey,
  type MachineKey,
  type MachineLock,
  MemoryKeyStore,
  machineDevice,
  readMachineKey,
} from "./journal/key-store.js";
export { MemoryStateStore } from "./journal/memory-state-store.js";
export {
  type DeviceHead,
  deviceHeads,
  hashOf,
  journalProduct,
  nextDeviceHead,
  type PreparedAppend,
  prepareAppend,
  prepareEngineEvents,
  productIdMismatch,
} from "./journal/prepare-event.js";
export {
  ensureProductId,
  type ProductIdResult,
  readJournalProductId,
  writeProductId,
} from "./journal/product-id.js";
export {
  type AdoptionJournal,
  type AnnouncedKey,
  adoptRotatedKey,
  announcedKey,
  backupProductKey,
  checkAnnounced,
  createProductKey,
  forgetProductKey,
  hasRotation,
  keychainUnavailable,
  type ProductKey,
  type ProjectionKey,
  productKeyById,
  productKeyMismatch,
  productKeyMissing,
  productKeyOf,
  projectionKey,
  readHeldProductKey,
  readProductKey,
  sensitiveProductKey,
  storeProductKey,
  writingKey,
} from "./journal/product-key.js";
export { type RotationResult, rotateProductKey } from "./journal/product-key-rotation.js";
export type {
  AppendOptions,
  AppendPrecondition,
  EventDraft,
  JournalHistory,
  JournalListing,
  JournalProblem,
  RemoteJournalStatus,
  StateStore,
} from "./journal/state-store.js";
export {
  type Clock,
  createUlidFactory,
  newUlid,
  nextUlid,
  type RandomSource,
  type UlidFactory,
} from "./journal/ulid.js";
export {
  JOURNEY_CATALOG,
  type StepInfo,
  skipWarning,
} from "./journey/journey-catalog.js";
export {
  documentProblemIsWarning,
  documentStep,
  isSkipped,
  type SkipState,
  type Skips,
  skippedList,
  skippedPhases,
  skippedSteps,
  skipsOf,
} from "./journey/journey-rules.js";
export { type JourneyView, journeyView, type SkippedView } from "./journey/journey-view.js";
export {
  electPrimary,
  type PrimaryCandidate,
  type PrimaryChangeInput,
  type PrimaryChangePlan,
  planPrimaryChange,
  publishesFor,
  publishesProjection,
  type RoutedOrder,
  routeOrder,
} from "./machines/primary.js";
export {
  type PrimaryJournalFacts,
  readPrimaryFacts,
  writePrimaryChange,
} from "./machines/primary-write.js";
export {
  AGENT_FILE,
  ANNEX_DIRS,
  type Definition,
  type DefinitionKind,
  parseDefinition,
  readDefinitions,
  SKILL_FILE,
} from "./method/definitions.js";
export type { MethodSource } from "./method/method-source.js";
export {
  effectiveTable,
  inheritClients,
  isInherit,
  loadModelTable,
  parseModelTable,
  readShippedTable,
  renderModelsFile,
  SHIPPED_MODELS_FILE,
} from "./models/model-table.js";
export { creatorLastAnswer, MORNING_LIMIT, morningSummary } from "./next/morning.js";
export {
  answerChannel,
  answerReason,
  byStoryId,
  type DecisionItem,
  decisionQueue,
  type Morning,
  type MorningClosed,
  type MorningDecided,
  type MorningDone,
  type MorningEscalated,
  NEXT_STEPS,
  type NextBackground,
  type NextConfig,
  type NextDeferred,
  type NextDocs,
  type NextSprint,
  type NextState,
  type NextStep,
  type NextStepId,
  nextStep,
  type Pile,
  pileOf,
  type SyncFreshness,
  type SyncNeed,
  syncNeed,
  type WaitingCheckpoint,
} from "./next/next.js";
export {
  type AgentNextResult,
  type NextResult,
  nextAgentCommand,
  nextCommand,
  TOOL_MARKERS,
} from "./next/next-command.js";
export { computeBasis } from "./orders/basis.js";
export {
  appliedOrders,
  findOrderApplied,
  lastAppliedSequences,
  type OrderAppliedWrite,
  writeOrderApplied,
  writeOrderRejected,
} from "./orders/order-events.js";
export {
  ARCHITECTURE_PATH,
  ARCHITECTURE_SECURITY_REVIEW_PATH,
  type ArchitectureReview,
  citedReview,
  type DesignWorkingCopy,
  designSecurityReviewGap,
  isBlobOf,
  parseReviewLine,
  REVIEW_LINE_PREFIX,
  type ReviewVerdict,
  readWorkingBytes,
  reviewsSince,
  SECURITY_REVIEWER,
  type SecurityReviewGap,
} from "./phases/design-review.js";
export {
  activePhases,
  approvedAt,
  PHASE_CLOSERS,
  PHASE_DOMAINS,
  type PhaseProgress,
  type PhaseStatus,
  phaseProgress,
  REPEATING_PHASES,
  refusedDocumentReview,
  STORY_BUILDERS,
  STRUCTURING_DOCUMENT_PATHS,
  type StrayPhaseEnd,
} from "./phases/phases.js";
export {
  AGENT_DOMAINS,
  type AgentId,
  activeAgents,
  DEFAULT_PRESET,
  DEVELOPER_AGENTS,
  DEVELOPER_SPECIALTIES,
  DEVELOPER_SPECIALTY,
  type DeveloperSpecialty,
  DOMAIN_IDS,
  type DomainId,
  inactiveAgents,
  isPresetId,
  MAX_PARALLEL_STORIES,
  PHASE_IDS,
  type PhaseId,
  PROFILE_PRESET_IDS,
  PROFILE_PRESETS,
  type PresetSpec,
  type ProfilePresetId,
  specialtyOf,
} from "./profile/catalog.js";
export {
  type ProfileAdjustments,
  resolveProfile,
  validateProfile,
  writeProfile,
} from "./profile/profile.js";
export {
  methodNotInstalled,
  type ProfileResult,
  type ProfileState,
  profileCommand,
  readProfile,
} from "./profile/profile-command.js";
export type { BricksFound, ProfileBrief, ProfileShown } from "./project-profile/project-command.js";
export {
  AGENT_REDUCERS,
  type AgentState,
  type CostSignals,
  type CostsState,
  type CostTotals,
  type InstanceState,
  instanceKey,
  type ResultEntry,
  type StoryStarted,
  type StoryState,
} from "./projection/agent-reducers.js";
export {
  BUDGET_REDUCERS,
  type BudgetThresholdEntry,
  type BudgetThresholds,
} from "./projection/budget-reducers.js";
export {
  CHECKPOINT_REDUCERS,
  type CheckpointResolution,
  type CheckpointState,
  type MeasureEntry,
  settleHeldResolutions,
  type ValidationEntry,
} from "./projection/checkpoint-reducers.js";
export {
  type ComputeProjectionOptions,
  computeProjection,
  computeProjectionDetailed,
  type DetailedProjection,
  type ExtensionEvent,
} from "./projection/compute-projection.js";
export type {
  DeviceTrustView,
  RevokedDevice,
  RootFault,
  TrustedDevice,
} from "./projection/device-trust.js";
export {
  HUMAN_REDUCERS,
  type HumanState,
  type HumanTrust,
  type PresenceEntry,
  trustedHuman,
} from "./projection/human-reducers.js";
export {
  type HistoryRewrittenWarning,
  type KeychainUnavailableWarning,
  type LocalWarning,
  type ProjectStateOptions,
  type ProjectStateResult,
  projectState,
  STATE_CACHE_PATH,
  type StateFileStatus,
  stateFile,
} from "./projection/project-state.js";
export { type ProjectionDraft, REDUCERS, type Reducer } from "./projection/reducers.js";
export {
  readSensitiveCommand,
  type SensitiveFileRead,
  type SensitiveFileWritten,
  sensitiveCommands,
  sensitiveKey,
  writeSensitiveCommand,
} from "./sensitive/sensitive-commands.js";
export { checkSensitivePath, fileBinding, workspacePath } from "./sensitive/sensitive-files.js";
export {
  choosePath,
  FULL_PATH_SCORE,
  MAX_SPEC_REQUIREMENTS,
  MAX_SPEC_STORIES,
  outgrown,
  type PathChoice,
  type PathCriteria,
  readScope,
} from "./spec/path-rules.js";
export type { SpecGrowResult, SpecPathResult } from "./spec/spec-command.js";
export { countSpec, growSpec, SPEC_PATH } from "./spec/spec-grow.js";
export { type SpecNext, specNext } from "./spec/spec-next.js";
export {
  type CheckSprintInput,
  checkSprint,
  currentSprint,
  latestSprint,
  type SprintProblem,
  type SprintState,
  type SprintStatus,
  type SprintStory,
  type SprintStoryStatus,
  type SprintView,
  sprintBudget,
  sprintStatus,
  sprintView,
} from "./sprints/sprint-rules.js";
export {
  preferredToolSentence,
  type ResolvedAgent,
  renderAgentBody,
  resolveAgent,
  toolName,
} from "./sync/agent-render.js";
export {
  CAPABILITIES,
  type Capability,
  type ClientCompatibility,
  type ClientId,
  COMPATIBILITY,
  type CompatibilityCell,
  fallbacksFor,
  MODEL_INHERIT_REASON,
  type ToolFallback,
} from "./sync/compatibility.js";
export {
  cursorIgnoreBlock,
  withCursorIgnoreBlock,
  withoutCursorIgnoreBlock,
} from "./sync/cursor-ignore.js";
export { resolveEngineCommand } from "./sync/engine-command.js";
export { SYNC_CONFIG_KEYS, SYNC_INPUT_DIRS, syncInputsFingerprint } from "./sync/inputs.js";
export { SYNC_MANIFEST_PATH } from "./sync/manifest.js";
export {
  engineCommand,
  engineWords,
  isGeneratedMcpEntry,
  MCP_JSON_FILES,
  MCP_SERVER_NAME,
  type McpJsonFile,
  type McpServerLaunch,
  mcpLaunch,
  withEngineCommand,
} from "./sync/mcp.js";
export {
  CLAUDE_SETTINGS_SCHEMA_URL,
  cursorDenyRules,
  denyRules,
} from "./sync/permissions.js";
export {
  PHASE_SKILL_BASE,
  type SkillPhase,
  skillPhaseKey,
  skillsOfPhase,
} from "./sync/phase-skills.js";
export {
  RUN_COMPATIBILITY,
  RUN_MECHANISMS,
  RUN_TOOLS,
  type RunCell,
  type RunFallback,
  type RunMechanism,
  type RunTool,
  runFallbackId,
  runFallbacksFor,
} from "./sync/run-compatibility.js";
export {
  activeDefinitions,
  type PreferredTool,
  type SyncAction,
  type SyncEntry,
  type SyncResult,
  type SyncWarning,
  syncCommand,
} from "./sync/sync-command.js";
export {
  ANTIGRAVITY_AGENTS_DIR,
  GEMINI_MD_PATH,
} from "./sync/targets/antigravity.js";
export {
  CLAUDE_AGENTS_DIR,
  CLAUDE_MD_PATH,
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SKILLS_DIR,
} from "./sync/targets/claude-code.js";
export {
  CODEX_AGENTS_DIR,
  CODEX_CONFIG_PATH,
  renderCodexConfig,
  renderCodexHooks,
  tomlMultiline,
  tomlString,
} from "./sync/targets/codex.js";
export type { TargetGroup } from "./sync/targets/common.js";
export {
  CURSOR_AGENTS_DIR,
  CURSOR_CLI_PATH,
  CURSOR_IGNORE_PATH,
  CURSOR_RULE_PATH,
  renderCursorGuard,
} from "./sync/targets/cursor.js";
export { SHARED_SKILLS_DIR } from "./sync/targets/shared-skills.js";
export { TOOL_CATALOG, type ToolId, type ToolSpec } from "./tools/catalog.js";
export {
  compareVersions,
  type DetectedTool,
  detectTools,
  parseVersion,
  type ToolSource,
} from "./tools/detect-tools.js";
export { targetedTools, toolsFromDetection } from "./tools/targeted-tools.js";
export type { CommandMatch, Editor, ExtensionMatch, ToolProbe } from "./tools/tool-probe.js";
export {
  buildOfferAuthorizedPayload,
  buildPairedPayload,
  buildProvisionalRevocation,
  buildRevocation,
  buildRootCertifiedPayload,
  type PairedDeviceDescription,
  pairedHeadIfTrusted,
  type RootSigner,
  readDeviceTrust,
  revocationPayload,
  rootCertificationHolds,
  type TrustWrite,
  writeConfirmedDevice,
  writePairedDevice,
  writeProvisionalRevocation,
  writeRevocation,
  writeRootCertified,
} from "./trust-devices/pairing-events.js";
export {
  assertOrdersAllowed,
  isTrustedDevice,
  rootChangedError,
} from "./trust-devices/root-changed.js";
export {
  MemoryRootPinStore,
  parseRootPin,
  type RootPinStore,
  rootPinText,
} from "./trust-devices/root-pin.js";
export {
  TRUST_ACTIONS,
  type TrustFaultView,
  type TrustResult,
  trustDevicesCommand,
} from "./trust-devices/trust-command.js";
export type { WorkspaceFiles } from "./workspace-files.js";

/** Every command shipped by core. */
export const builtInCommands: ReadonlyArray<Command> = [
  initCommand,
  profileCommand,
  syncCommand,
  agentCommand,
  journalCommand,
  reviewCommand,
  keyCommand,
  trustDevicesCommand,
  ...agentActivityCommands,
  docsCommand,
  historyCommand,
  nextCommand,
  ...sensitiveCommands,
  rulesCommand,
  migrateCommand,
  ...trustCommands,
  checkWriteCommand,
  checkCallCommand,
  planSprintCommand,
  ...deferredAgentCommands,
  ...requirementAgentCommands,
  ...critiqueAgentCommands,
  ...readinessAgentCommands,
  ...roundTableAgentCommands,
  ...courseAgentCommands,
  ...proofAgentCommands,
  ...criterionAgentCommands,
  ...loopAgentCommands,
  ...qualityAgentCommands,
  ...qaAgentCommands,
  deferredCommand,
  storyCommand,
  startStoryCommand,
  leaveFastTrackCommand,
  openPullRequestCommand,
  checkCiCommand,
  ciCommand,
  testsCommand,
  ...traceAgentCommands,
  traceCommand,
  usageCommand,
  publicationCommand,
  answerCheckpointCommand,
  decideCheckpointCommand,
  requestCreatorActionCommand,
  workshopCommand,
  nextAgentCommand,
  delegateCommand,
  summarizeCommand,
  pauseTeamCommand,
  ...reviewAgentCommands,
  askCreatorCommand,
  openStackCommand,
  askStackCommand,
  answerStackCommand,
  ...memoryCommands,
  ...mergeOrderAgentCommands,
  measureUsageCommand,
  doctorCommand,
  checkEnvironmentCommand,
];

// The manual of the grouped tools is rendered from these commands.
provideToolManual(builtInCommands);

export {
  agentRoleProblem,
  NOAH_COMMANDS,
  noahActive,
  roleForbidden,
} from "./agents/noah-role.js";
export {
  type AutonomyState,
  dialedText,
  readAutonomyState,
  setAutonomyDial,
  setPermissionRule,
} from "./autonomy/autonomy.js";
export {
  type BudgetCeiling,
  type BudgetContext,
  type BudgetGate,
  type BudgetSettingsInForce,
  budgetCheckpoint,
  type CeilingSource,
  gateOf,
  offeredRaises,
  raisedBudget,
  statusFor,
  storyCeiling,
  type ThresholdEntry,
  type ThresholdPlan,
  thresholdPlan,
} from "./budget/budget-rules.js";
export { budgetSettings } from "./budget/budget-settings.js";
export { CALL_GUARD_BUDGET_MS, checkCallCommand } from "./budget/call-command.js";
export { forgetCallCosts } from "./budget/call-cost.js";
export {
  budgetMessage,
  LAUNCH_TOOLS,
  OWN_TOOL_PREFIX,
  PAUSE_HELD_TOOLS,
  pausedMessage,
  pauseHolds,
} from "./budget/call-rules.js";
export {
  ACTIVITY_FILE_MAX_BYTES,
  ACTIVITY_HOOK_COMMAND,
  ACTIVITY_HOOK_PATH,
  ACTIVITY_SECRET_SHAPES,
  ACTIVITY_SPOOL_DIR,
  isActivityHook,
  renderActivityHookScript,
  settingsHaveActivityHook,
} from "./chat/activity-hook.js";
export {
  type AnswerRecorded,
  answerCheckpointCommand,
  answerPlan,
} from "./chat/answer-command.js";
export {
  ANTIGRAVITY_HOOK_NAME,
  ANTIGRAVITY_HOOK_PATH,
  ANTIGRAVITY_HOOKS_PATH,
  ANTIGRAVITY_MCP_CONFIG_PATH,
  ANTIGRAVITY_PLUGIN_DIR,
  ANTIGRAVITY_POLICY_PATH,
  ANTIGRAVITY_UNCHECKED_REASON,
  renderAntigravityHookScript,
} from "./chat/antigravity-hook.js";
export {
  type AskCreatorResult,
  askCreatorCommand,
  channelOf,
  formBlocked,
  type QuestionToolDictation,
  type QuestionToolNotRecorded,
  type Recorded,
} from "./chat/ask-command.js";
export { AUTO_TYPES, type AutoCandidate, autoOption } from "./chat/auto-apply.js";
export {
  type DecisionChannel,
  type DecisionChannels,
  decisionChannels,
  type ElicitationState,
  type QuestionToolState,
} from "./chat/channels.js";
export {
  type ChatAccess,
  type ChatLog,
  type ChatMessage,
  chatClientOf,
  chatHookPath,
  citedKey,
  isAntigravityClient,
  isCodexClient,
  isCursorClient,
  isHookedClient,
  matchQuote,
  proofSession,
  proofSessionOf,
  type QuoteMatch,
  type QuoteRefusal,
  sameProject,
} from "./chat/chat-proof.js";
export { messageDigest, normalizeChatText, quoteDigest } from "./chat/chat-text.js";
export {
  CODEX_HOOK_NAME,
  CODEX_HOOK_PATH,
  CODEX_HOOK_TIMEOUT,
  CODEX_POLICY_PATH,
  CODEX_POST_MATCHER,
  CODEX_PRE_MATCHER,
  CODEX_PROMPT_HOOK_TIMEOUT,
  CODEX_RULES_PATH,
  CODEX_UNCHECKED_REASON,
  codexRequestText,
  codexSessionIdOf,
  renderCodexHookScript,
} from "./chat/codex-hook.js";
export { CREATOR_TEXT_PATTERNS, creatorText, visibleText } from "./chat/creator-text.js";
export {
  CURSOR_HOOK_NAME,
  CURSOR_HOOK_PATH,
  CURSOR_HOOKS_PATH,
  CURSOR_POLICY_PATH,
  CURSOR_UNCHECKED_REASON,
  cursorHookCommand,
  cursorRequestText,
  renderCursorHookScript,
  renderCursorHooks,
} from "./chat/cursor-hook.js";
export {
  DECISION_ANSWER_MAX,
  DECISION_HOOK_COMMAND,
  DECISION_HOOK_NAME,
  DECISION_HOOK_PATH,
  decisionHookHandler,
  isDecisionHook,
  renderDecisionHookScript,
} from "./chat/decision-hook.js";
export {
  type CreatorPrompt,
  type CreatorReply,
  DECISION_FORM_FIELDS,
  decisionPrompt,
  type ElicitedAnswer,
  formDigest,
  type MergeHold,
  readReply,
} from "./chat/decision-prompt.js";
export {
  ELICITATION_HOOK_EVENTS,
  elicitationHookIn,
  QUESTION_TOOL_HOOK_EVENTS,
  questionToolHookIn,
} from "./chat/elicitation-hooks.js";
export {
  CHAT_STORE_DIR,
  GENERATED_HEADER_SLASH,
  isPromptHook,
  PROMPT_HOOK_COMMAND,
  PROMPT_HOOK_PATH,
  promptHookHandler,
  renderPromptHookScript,
  SESSION_CONTEXT_PREFIX,
} from "./chat/prompt-hook.js";
export {
  type DecisionLog,
  type DecisionRecord,
  type Dictation,
  freeRecords,
  normalizeToolQuestions,
  type QuestionReader,
  type QuestionScreen,
  type QuestionToolAccess,
  questionsDigest,
  readStackScreen,
  readToolAnswer,
  refOfRecord,
  screenFallback,
  screenProblem,
  type ToolOption,
  type ToolQuestion,
} from "./chat/question-tool.js";
export {
  type AskStackResult,
  answerStackCommand,
  answerStackPlan,
  askStackCommand,
  openStackCommand,
  type StackAnswered,
  type StackNotRecorded,
  type StackOpened,
  type StackPointShown,
  type StackQuestionToolDictation,
  type StackRecorded,
  type StackStanding,
} from "./chat/stack-commands.js";
export {
  isInstallCheckpoint,
  parseStackReply,
  readStackReply,
  type StackApproval,
  type StackReply,
  selectionOutsideStack,
  stackApproval,
  stackField,
  stackItemDigest,
  stackItems,
  stackProblem,
  stackPrompt,
  stackPromptDigest,
  stackPromptItem,
} from "./chat/stack-rules.js";
export {
  type ResolvedValidationSettings,
  resolveValidationSettings,
  type UnpublishedMain,
  type ValidationSettingsWarning,
} from "./chat/validation-settings.js";
export {
  type DecideRecorded,
  decideCheckpointCommand,
  decidePlan,
} from "./checkpoints/decide-command.js";
export {
  type Delegation,
  type DelegationVerdict,
  deciderFor,
  delegationOf,
  delegationVerdict,
  isDelegated,
  type NotDelegated,
  POINT_DECIDERS,
  type PointCandidate,
  type PointKind,
  type PointsView,
  pointKindOf,
  pointsView,
} from "./checkpoints/point-rules.js";
export {
  type CiCheckResult,
  type CiWaiveResult,
  checkCiCommand,
  checkName,
  ciPayload,
  ciUnavailable,
  storyCi,
} from "./ci/ci-check.js";
export type {
  CiCheck,
  CiReader,
  CiReadFailure,
  CiReading,
  CiRepository,
} from "./ci/ci-reader.js";
export {
  CI_CONFIG_PATHS,
  ciGreen,
  ciStatusOf,
  existingCi,
  GITHUB_WORKFLOWS_DIR,
  heldMergeCheckpoint,
  isWorkflowFile,
  type MergeGate,
  type MergeGateOptions,
  mergeGate,
  mergeHold,
  mergeReady,
  REVIEW_NOT_DONE,
  type ReviewDoneCondition,
  type StoryCiStatus,
  storyCiStatus,
} from "./ci/ci-rules.js";
export {
  CI_JOBS,
  CI_STACKS,
  CI_TEMPLATES,
  type CiJob,
  type CiPlan,
  type CiSetupResult,
  type CiStack,
  ciCommand,
  ciPlan,
  ciTestGaps,
  renderCiTemplate,
  TEST_LEVEL_SCRIPTS,
} from "./ci/ci-setup.js";
export {
  type CourseResult,
  courseAgentCommands,
  courseCommand,
  openedAnswer,
} from "./course/course-commands.js";
export {
  type CourseRecord,
  type CourseView,
  courseHolds,
  courseView,
  leftLines,
  openCourse,
} from "./course/course-rules.js";
export type { ActionExecuted } from "./creator-actions/creator-action-execution.js";
export {
  type FileExecution,
  isFileAction,
} from "./creator-actions/creator-action-files.js";
export {
  actionRisk,
  terminalCommand,
} from "./creator-actions/creator-action-rules.js";
export { DryRunFiles } from "./creator-actions/dry-run-files.js";
export {
  type CreatorActionRequested,
  requestCreatorActionCommand,
} from "./creator-actions/request-command.js";
export {
  type CriterionView,
  criterionAgentCommands,
  recordCriterionCommand,
} from "./criteria/criterion-command.js";
export {
  type CriterionRecord,
  type CriterionRun,
  type CriterionStatus,
  citedCriteria,
  criterionHolds,
  criterionStatus,
  MAX_TRACE_CRITERIA,
  missingLines,
  traceLine,
} from "./criteria/criterion-rules.js";
export {
  type CriterionTrace,
  criteriaProblem,
  criteriaTrace,
  type StoryTrace,
} from "./criteria/criterion-trace.js";
export {
  type CritiqueResult,
  critiqueAgentCommands,
  critiqueCommand,
} from "./critique/critique-commands.js";
export {
  type CritiqueOffer,
  type CritiqueRisk,
  type CritiqueView,
  correctionLines,
  critiqueOffer,
  critiqueStack,
  critiqueView,
  documentRisk,
  type HypothesisDue,
  hypothesesDue,
  passageFound,
  validateCritiqueReport,
} from "./critique/critique-rules.js";
export {
  type DelegationTarget,
  delegateCommand,
  delegationInvalid,
} from "./delegation/delegate-command.js";
export {
  type DocumentsInputs,
  documentStanding,
  documentsList,
  requirementTrace,
} from "./docs/documents-view.js";
export { summarizeCommand } from "./exchange/summarize-command.js";
export {
  type FastTrackOutcome,
  fastTrackEvents,
  outcomeOf,
  readFastTrack,
} from "./fast-track/fast-track-check.js";
export {
  fastTrackNotPossible,
  leaveFastTrackCommand,
  leaveProblem,
} from "./fast-track/fast-track-commands.js";
export {
  dependencyPath,
  exitCheckpoints,
  type FastTrackHold,
  type FastTrackVerdict,
  fastTrackHold,
  fastTrackVerdict,
  interfacePath,
  migrationPath,
  openExitCheckpoint,
} from "./fast-track/fast-track-rules.js";
export { stringifyMethodDocument } from "./init/method-config.js";
export { type LoopView, loopAgentCommands, loopCommand } from "./loop/loop-command.js";
export {
  type AttemptRecord,
  type AttemptsView,
  approachWords,
  attemptLimitCheckpoint,
  attemptsView,
  type HypothesesView,
  hypothesesView,
  hypothesisProblem,
  LOOP_STEPS,
  type LoopState,
  type LoopVerdict,
  loopVerdict,
  parseHypothesis,
  ruledOutLines,
  sameApproach,
  stopReasonOf,
  triedLines,
  tryProblem,
} from "./loop/loop-rules.js";
export { type CommonMemory, MemoryCommonMemory } from "./memory/common-memory.js";
export { memoryCommands } from "./memory/index.js";
export {
  activeLessonIds,
  anchorsOf,
  dueScopes,
  type LessonAnchor,
  type LessonBatch,
  lessonStatuses,
  type RetroState,
  retrosOf,
  scopeFinished,
  scopeStatus,
} from "./memory/memory-rules.js";
export { type MemoryPreview, memoryPreviews } from "./memory/preview.js";
export type { LessonPromoted } from "./memory/promotion.js";
export type { RetrospectiveProposed } from "./memory/propose-retrospective.js";
export type { MemoryRead, ServedAction, ServedLesson } from "./memory/read-memory.js";
export type { LessonsRecorded } from "./memory/record-lessons.js";
export { retroStatus, retrospectivesView } from "./memory/retro-view.js";
export { hasConflictMarkers, parseConflictMarkers } from "./merge/conflict-markers.js";
export {
  analyseConflict,
  type ConflictAnalysis,
  checkResolution,
  conflictSummary,
  fileClass,
  hunkClass,
  usefulLines,
} from "./merge/conflict-rules.js";
export {
  coherenceProblem,
  conflictProblem,
  mergeRefused,
  orderProblem,
} from "./merge/merge-guards.js";
export {
  compareStoryIds,
  mergeOrder,
  mergeWaits,
  type OrderEntry,
  queueOrder,
  type ReadyStory,
} from "./merge/merge-order.js";
export {
  type ConflictQualified,
  getMergeOrderCommand,
  type MergeOrderRead,
  type MergeQueueEntry,
  mergeOrderAgentCommands,
  qualifyMergeConflictCommand,
} from "./merge/merge-order-commands.js";
export type {
  BranchMerge,
  ConflictFileProbe,
  ConflictHunk,
  ConflictProbe,
  MergeProbe,
} from "./merge/merge-probe.js";
export { INSTRUMENTATION_MARKER } from "./merge/story-files.js";
export {
  afterMerge,
  changedFiles,
  type MergeDone,
  type MergeResult,
  mergedEvent,
  mergeFailed,
  mergeStory,
  mergesOn,
  type WorktreeAfterMerge,
} from "./merge/story-merge.js";
export { type MigrateResult, migrateCommand } from "./migrate/migrate-command.js";
export {
  applyMigration,
  type FormatMigration,
  METHOD_MIGRATIONS,
  planMigration,
  readFormat,
} from "./migrate/migrations.js";
export {
  LATEST_ENGINE,
  UPGRADE_DEFAULT_COMMAND,
  upgradeTarget,
  withUpgradeTarget,
} from "./migrate/upgrade-target.js";
export type { StoryCi } from "./projection/ci-reducers.js";
export { type DelegationEntry, delegationsOf } from "./projection/delegation-reducers.js";
export { type ExchangeEntry, exchangesOf } from "./projection/exchange-reducers.js";
export { FAST_TRACK_REDUCERS } from "./projection/fast-track-reducers.js";
export {
  type InstallEntry,
  installsOf,
  MAX_RECORDED_INSTALLS,
} from "./projection/install-reducers.js";
export {
  conflictNote,
  MERGE_ORDER_REDUCERS,
  openConflict,
  refreshedMergeSummary,
} from "./projection/merge-order-reducers.js";
export {
  isMergeCheckpoint,
  MERGE_REDUCERS,
} from "./projection/merge-reducers.js";
export { type StackItemState, type StackState, stacksOf } from "./projection/stack-reducers.js";
export type { ExternalReadEntry } from "./projection/trust-reducers.js";
export {
  type ProofDecisions,
  proofDecisions,
  standingOf,
} from "./proofs/proof-accord.js";
export {
  type DeclaredProofCommand,
  PROOFS_PATH,
  type ProofDeclaration,
  proofFingerprint,
  readProofDeclaration,
} from "./proofs/proof-declaration.js";
export { isSecretVariable, parseCommandLine } from "./proofs/proof-line.js";
export { safeOutput, usefulLines as proofUsefulLines } from "./proofs/proof-output.js";
export {
  PROOF_RUNS_DIR,
  type ProofRunView,
  proofAgentCommands,
  runProofCommand,
} from "./proofs/proof-run-command.js";
export {
  MAX_PROOF_OUTPUT_BYTES,
  type ProofRunner,
  type ProofRunRequest,
  type ProofRunResult,
  type WorkingCopy,
} from "./proofs/proof-runner.js";
export {
  type ExportedFile,
  PUBLICATION_ACTIONS,
  type PublicationExported,
  type PublicationFile,
  type PublicationResult,
  type PublicationShown,
  publicationCommand,
} from "./publications/publication-command.js";
export {
  decodeStrict,
  isPublication,
  isValidatedPublication,
  publicationOpenProblem,
  withoutHeader,
} from "./publications/publication-rules.js";
export { acceptanceQaCommand, type QaView } from "./qa/qa-command.js";
export {
  type ChangedFile,
  type CopyOpening,
  insideProject,
  type MutationCopy,
  type MutationLab,
  type MutationPlan,
  type MutationReport,
  mutationCounts,
  runMutationCheck,
  survivorLines,
} from "./quality/mutation-run.js";
export { reviewTestsCommand, type TestsView } from "./quality/review-tests-command.js";
export {
  type ReadyResult,
  readinessAgentCommands,
  readyCommand,
} from "./readiness/readiness-command.js";
export { type ReadinessNext, readinessNext } from "./readiness/readiness-next.js";
export {
  type RequirementsSynced,
  recordProofCommand,
  requirementAgentCommands,
  settleGapCommand,
  submitAuditCommand,
  syncRequirementsCommand,
} from "./requirements/requirement-commands.js";
export {
  budgetOf,
  buildRegistry,
  measureResult,
  openGaps,
  proofIsStale,
  type RequirementItem,
  type RequirementsView,
  releaseHold,
  requirementProofState,
  requirementsView,
  validateAuditReport,
} from "./requirements/requirement-rules.js";
export { isCodePath, isReadableCode, MAX_FILE_BYTES } from "./reuse/code-files.js";
export {
  DEFAULT_MIN_TOKENS,
  type Detection,
  type DetectOptions,
  type Duplicate,
  detectDuplicates,
  type Place,
  type SourceFile,
} from "./reuse/duplicates.js";
export {
  analyzeReuse,
  type CodeSource,
  duplicateFindings,
  type ReuseReport,
  reuseLines,
  reuseOf,
  type StoryWeight,
} from "./reuse/reuse.js";
export { findTwins, type Twin } from "./reuse/twins.js";
export { type WeighedStory, weighedStoriesOf, weightDrift } from "./reuse/weight.js";
export {
  diffPathOf,
  exportReviewCommand,
  FREE,
  type FreeReviewSubmitted,
  freeDirOf,
  getReviewCommand,
  publishPass,
  publishReviewCommand,
  REVIEW_DIFF_DIR,
  type ReviewExport,
  type ReviewFindingView,
  type ReviewPublished,
  type ReviewRead,
  type ReviewStart,
  type ReviewSubmitted,
  reviewAgentCommands,
  reviewNotPossible,
  reviewProblem,
  reviewRead,
  startReviewCommand,
  submitReviewCommand,
  triageReviewCommand,
} from "./review/review-commands.js";
export type { FreeDiff, FreeDiffRequest, StoryDiff } from "./review/review-diff.js";
export {
  type ExportInput,
  type ExportParts,
  exportPrompt,
  lensFileOf,
  passFileOf,
} from "./review/review-export.js";
export {
  DEVIATION_MARKER,
  deviationComment,
  type ForgePosting,
  forgeTarget,
  REVIEW_MARKER,
  reviewDraft,
} from "./review/review-forge.js";
export {
  type FreeSource,
  freeIdOf,
  isUnifiedDiff,
  parseSource,
  readFree,
  sourceLabel,
} from "./review/review-free.js";
export {
  changeFiles,
  chooseLenses,
  isSensitiveChange,
  lensDiff,
  planReaders,
  type Reader,
  type ReaderPass,
  readerPasses,
} from "./review/review-lenses.js";
export {
  closedFindings,
  currentPass,
  type DiffFile,
  type FindingTriage,
  failedPassesSinceLoop,
  findFinding,
  isReviewLoopCheckpoint,
  isStoryDeveloper,
  needsSecurity,
  openMergeCheckpoint,
  parseDiff,
  passComplete,
  passNumberFor,
  passOutcome,
  type ReviewFindingState,
  type ReviewPass,
  type ReviewPublication,
  type ReviewRecord,
  reviewDone,
  reviewLoopReached,
  reviewOf,
  reviewVerdictOf,
  type SecurityInputs,
  type StoryReview,
  securityReasons,
  securityWords,
  sensitivePath,
  storyReviewDone,
  unpublishedKinds,
  untriagedFindings,
} from "./review/review-rules.js";
export {
  type UxFlow,
  uxFlows,
  WALK_CHARS,
  WALK_STOPS,
  type WalkCriterion,
  type WalkInputs,
  type WalkStep,
  type WalkStop,
  type Walkthrough,
  walkCriteria,
  walkSlot,
  walkthrough,
  walkthroughText,
} from "./review/review-walkthrough.js";
export type { MainBranchRead, MainBranchReader } from "./rules/main-branch.js";
export {
  type ResolvedRules,
  type RulesSource,
  type RulesWarning,
  resolveRules,
} from "./rules/resolve-rules.js";
export {
  allowedValues,
  DEFAULT_RULES,
  lockOf,
  type RuleLock,
} from "./rules/rule-table.js";
export { type RuleRow, type RulesResult, rulesCommand, writeRule } from "./rules/rules-command.js";
export {
  CHAINED_HOOK_NAME,
  COMMIT_CHECK_PATH,
  COMMIT_HOOK_LINE,
  COMMIT_HOOK_NAME,
  COMMIT_SKIPS_PATH,
  COMMIT_STORIES_DIR,
  commitHookFiles,
  renderCommitCheck,
  renderCommitHook,
  type TraceSkips,
  traceSkipsOf,
} from "./stories/commit-hook.js";
export {
  deliveryRemote,
  forgeNotLinked,
  linkInstructions,
  notOpenable,
  oneLine,
  openPullRequestCommand,
  pullRequestFailed,
  type StoryPullRequestResult,
  targetBranch,
} from "./stories/pull-request.js";
export {
  acceptanceCriteria,
  fileWebUrl,
  PULL_REQUEST_MARKER,
  type PullRequestContent,
  pullRequestTitle,
  renderPullRequestBody,
  withoutCost,
} from "./stories/pull-request-body.js";
export {
  type ResolvedPullRequestSettings,
  resolvePullRequestSettings,
} from "./stories/pull-request-settings.js";
export {
  type BranchPushOutcome,
  type ForgeCliState,
  type ForgeInspection,
  type ForgeLineComment,
  type ForgeMergeOutcome,
  type ForgeMergeRequest,
  type ForgePullRequest,
  type ForgePullRequestState,
  type ForgeRemote,
  type ForgeRepository,
  type ForgeReviewDraft,
  forgeCli,
  forgeOfHost,
  forgeRepositoryOf,
  isRepositoryPullRequest,
  type MainInspection,
  type PullRequestDraft,
  type RemoteBranchState,
  type RepositoryCreation,
  type RepositoryRequest,
  remoteLocation,
  repositoryWebUrl,
  type StoryForge,
} from "./stories/story-forge.js";
export {
  type BranchIntent,
  branchIntentProblem,
  latestStoryApproval,
  readBranchIntent,
  resultMovesToReview,
} from "./stories/story-review.js";
export {
  journalStartProblem,
  latestApprovedStoryBlob,
  notStartable,
  type StoryJournalView,
  type StoryStartResult,
  startStoryCommand,
  storyBuilder,
  storyCommand,
  storyJournalView,
  storyStartProblem,
} from "./stories/story-start.js";
export type {
  BranchEnsured,
  BranchMergeOutcome,
  BranchMergeRequest,
  CommitHookFiles,
  CommitHookInstall,
  FilesCommitOutcome,
  FilesCommitRequest,
  PathsCommitRequest,
  StoryFileOnBranch,
  StoryWorkspace,
  StoryWorkspaceCreation,
  StoryWorkspaceInspection,
  StoryWorkspaceTarget,
  WorkflowDetection,
  WorktreeRemoval,
} from "./stories/story-workspace.js";
export {
  PUBLICATION_BOUNDARY,
  PUBLISHING_DOMAINS,
} from "./sync/agent-render.js";
export { renderCodexRules } from "./sync/codex-rules.js";
export {
  type CodexTrustEntry,
  type CodexTrustPlan,
  type CodexUserConfig,
  codexHookHashes,
  codexTrustSupported,
  planCodexTrust,
} from "./sync/codex-trust.js";
export {
  KIMI_HOOK_TIMEOUT,
  KIMI_HOOKS_BEGIN,
  KIMI_HOOKS_END,
  type KimiHooksEdit,
  type KimiHooksRefusal,
  type KimiHooksState,
  kimiHookCommand,
  kimiHooksBlock,
  kimiHooksState,
  withKimiHooks,
  withoutKimiHooks,
} from "./sync/kimi-hooks.js";
export {
  type CodexRuleSettings,
  CURSOR_ENGINE_MCP_RULE,
  claudeRulePermissions,
  codexRuleSettings,
  cursorRulePermissions,
  type RulePermissions,
} from "./sync/rule-permissions.js";
export type { SyncRules } from "./sync/sync-command.js";
export {
  type RoundTableResult,
  roundTableAgentCommands,
  roundTableCommand,
} from "./table/table-commands.js";
export {
  gestureOwner,
  type TableOffer,
  tableCandidate,
  tableOffer,
  threeViewsAgents,
  validateClosing,
  validateProposal,
} from "./table/table-rules.js";
export { pauseTeamCommand } from "./team/pause-team-command.js";
export { openPause, type TeamState } from "./team/team-rules.js";
export {
  API_RUNNERS,
  type ApiRunner,
  criterionLine,
  E2E_RUNNERS,
  type E2eRunner,
  RUNNERS,
  type TestRunner,
  type TestStack,
} from "./test-frame/test-runners.js";
export {
  type ChosenRunner,
  proofsProposal,
  type TestInstall,
  type TestPlan,
  type TestsSetupResult,
  testPlan,
  testsCommand,
} from "./test-frame/tests-setup.js";
export {
  agentMayResolve,
  type Deviation,
  type DeviationResolution,
  type DeviationView,
  deviationResolutionProblem,
  deviationsOf,
  deviationView,
  findDeviation,
  openDeviation,
  openDeviations,
} from "./trace/deviation-rules.js";
export {
  type CandidateLine,
  isTestPath,
  MAX_CANDIDATE_LINES,
  requirementsInLine,
  type TestReference,
  type TestReferenceRead,
  type TestReferenceSource,
  testReferences,
} from "./trace/test-references.js";
export {
  getTraceCommand,
  reportDeviationCommand,
  resolveDeviationCommand,
  type TraceDetail,
  type TraceOverview,
  type TraceResolved,
  type TraceResult,
  type TraceTests,
  traceAgentCommands,
  traceCommand,
} from "./trace/trace-commands.js";
export {
  compareRequirements,
  type RequirementSummary,
  type RequirementTrace,
  requirementStatus,
  statusCounts,
  type TracedPullRequest,
  type TracedStory,
  type TraceInputs,
  tracedRequirements,
  tracedStoryStatus,
  traceRequirement,
  traceSummaries,
} from "./trace/trace-rules.js";
export {
  type AntigravityCall,
  callOf,
  type GuardDecision,
  type GuardFlavor,
  guardToolCall,
  recordToolRead,
} from "./trust/antigravity-guard.js";
export {
  CODEX_FLAVOR,
  codexCallOf,
  codexSessionOf,
  patchPaths,
  recordCodexRead,
} from "./trust/codex-guard.js";
export {
  CURSOR_FLAVOR,
  cursorCallOf,
  cursorSessionOf,
} from "./trust/cursor-guard.js";
export {
  type GateDecision,
  type GateRequest,
  gateDecision,
  installCheckpoint,
  normalizeDetail,
  ruleOf,
} from "./trust/gate.js";
export {
  type FolderReader,
  type InstallFolder,
  type InstallFolders,
  installFolders,
  onlyRoot,
  plainFolder,
  ROOT_SCOPE,
  storyFolders,
} from "./trust/install-folders.js";
export {
  type InstallTarget,
  type InstallVerdict,
  identityDigest,
  installIdentity,
  manifestPlanned,
  normalizedName,
  plannedInstall,
  readInstalls,
  registryRedirected,
} from "./trust/install-plan.js";
export {
  type InstallSettingsWarning,
  type ResolvedInstallSettings,
  resolveInstallSettings,
} from "./trust/install-settings.js";
export {
  KIMI_FLAVOR,
  KIMI_POLICY_PATH,
  kimiCallOf,
  kimiCallTool,
  kimiSessionOf,
} from "./trust/kimi-guard.js";
export { plannedDependencies } from "./trust/planned-dependencies.js";
export {
  AgentSession,
  readSource,
  type SessionTrust,
  sessionTrust,
} from "./trust/session.js";
export {
  checkActionCommand,
  type HookAnswer,
  type RequestActionResult,
  recordExternalReadCommand,
  requestActionCommand,
  trustCommands,
} from "./trust/trust-commands.js";
export {
  checkWriteCommand,
  WRITE_GUARD_BUDGET_MS,
  writeGuardIdle,
} from "./write-guard/write-command.js";
export { decisionGuards, decisionViolation, type Guard } from "./write-guard/write-decisions.js";
export {
  forgetGuardIndex,
  productRootOf as workingCopyProductRoot,
} from "./write-guard/write-index.js";
export { inScope, isSafePath, pathsNamedIn, type ScopeEntry } from "./write-guard/write-scope.js";

export function createCommandRegistry(): CommandRegistry {
  return new CommandRegistry(builtInCommands);
}

export type { EnvironmentFixDone } from "./creator-actions/environment-fix-gesture.js";
export {
  type Ask,
  type CatalogCheck,
  type Detect,
  DOCTOR_CATALOG_FILE,
  type DoctorCatalog,
  DoctorCatalogSchema,
  type Fix,
  OUTCOMES,
  type Outcome,
  parseDoctorCatalog,
  readDoctorCatalog,
} from "./doctor/catalog.js";
export {
  commandsIn,
  type Diagnosis,
  diagnoseFailure,
  type Failure,
  FailureSchema,
  portsIn,
} from "./doctor/diagnose.js";
export {
  type CheckEnvironmentResult,
  checkEnvironmentCommand,
  type DoctorResult,
  doctorCommand,
  type EnvironmentDiagnosis,
  type EnvironmentPoint,
} from "./doctor/doctor-commands.js";
export {
  DEFAULT_PATHEXT,
  type DirectorySpec,
  type EnvironmentProbe,
  type EnvironmentRun,
  envValue,
  type FoundCommand,
  type MachineDescription,
  type RunOptions,
} from "./doctor/environment-probe.js";
export { type Evaluation, evaluateDetect } from "./doctor/evaluate.js";
export {
  answerProblem,
  displayCommand,
  FIX_TIMEOUT_MS,
  type FixRun,
  fillText,
  isAutomatic,
  type Localized,
  type PlannedAsk,
  type PlannedFix,
  planFix,
  quoteArgument,
  runFix,
  withAnswers,
} from "./doctor/fixes.js";
export { MemoryEnvironment } from "./doctor/memory-environment.js";
export { prerequisiteChecks, readPrerequisites } from "./doctor/prerequisites.js";
export {
  type DoctorItem,
  type DoctorReport,
  type DoctorStatus,
  runDoctor,
} from "./doctor/report.js";
export {
  buildSupportReport,
  FACT_POLICY,
  REDACTIONS,
  type RedactionContext,
  type RedactionKind,
  redactFacts,
  redactionContextOf,
  redactText,
  type SupportCheck,
  type SupportReport,
} from "./doctor/support-report.js";
export {
  CASES_FILE,
  type CasesFile,
  casesDigest as evalCasesDigest,
  DEFAULT_THRESHOLDS as DEFAULT_EVAL_THRESHOLDS,
  EVALS_DIR,
  type EvalCase,
  messageOf as evalMessage,
  REFERENCE_FILE,
  readCases,
  type Thresholds as EvalThresholds,
  ThresholdsSchema as EvalThresholdsSchema,
  type TriggerQuery,
} from "./evals/eval-cases.js";
export {
  type Comparison as EvalComparison,
  compare as compareEvalPass,
  type Finding as EvalFinding,
  keep as keepEvalPass,
  type Pass as EvalPass,
  PassSchema as EvalPassSchema,
  stats as evalStats,
} from "./evals/eval-compare.js";
export {
  type AgentOutcome as EvalAgentOutcome,
  type AgentRequest as EvalAgentRequest,
  digestOf as evalDigest,
  type EvalAgent,
  evaluate,
  type Mode as EvalMode,
  type Options as EvalOptions,
  type Plan as EvalPlan,
  planOf as evalPlan,
  type Report as EvalReport,
  type SkillUnder as EvalSkill,
  type StagedFile as EvalFile,
  selection as evalSelection,
} from "./evals/eval-run.js";
export {
  type EvalStatus,
  evalStatus,
  type Loaded as LoadedEvalSkill,
  loadSkill as loadEvalSkill,
  suggestStarter as suggestEvalStarter,
} from "./evals/eval-store.js";
export {
  type Candidate as EvalCandidate,
  lineLoadsSkill as evalLineLoadsSkill,
  type QuerySet as EvalQuerySet,
  queryId as evalQueryId,
  routeByWords,
  scoreTriggersByWords,
  splitQueries,
} from "./evals/eval-triggers.js";
export { withoutPart as evalWithoutPart } from "./evals/eval-variant.js";
export {
  appendExtensionEvent,
  type ExtensionRead,
  type ExtensionReadResult,
  type ExtensionWrite,
  readExtensionEvents,
} from "./extensions/extension-events.js";
export {
  compact,
  RESPONSE_FORMS,
  type ResponseForm,
  type ResponseKind,
  ResponseMemory,
  responseFormsCover,
  shapeResponse,
} from "./mcp-responses.js";
export {
  commandOf,
  exposedCommands,
  TOOL_GROUPS,
  type ToolAction,
  type ToolCall,
  type ToolGroup,
  toolCallOf,
  toolInputOf,
  toolNotation,
  toolsOfCommands,
  withToolNotation,
} from "./mcp-tools.js";
export {
  inputShapeOf,
  provideToolManual,
  publishedShape,
  renderToolsReference,
} from "./mcp-tools-manual.js";
export {
  BASE_TOOLS,
  claudeToolName,
  disallowedToolsFor,
  toolsCitedIn,
  toolsNeededBy,
} from "./sync/agent-tools.js";
export { EXTENSION_SERVER_NAME, type ExtensionMcpServer } from "./sync/mcp.js";
export { renderAgentSkill } from "./sync/targets/common.js";
export {
  type AntigravityInfo,
  antigravityModelAt,
  antigravityPlace,
  antigravityTraceInfo,
} from "./usage/antigravity-reader.js";
export {
  type ModelPrice,
  PRICE_TABLE,
  type PriceTable,
  priceOf,
  usdOf,
} from "./usage/price-table.js";
export {
  type BreakEven,
  breakEvenOf,
  type CostSource,
  type CostsAsk,
  type CostsFound,
  costsLines,
  costsOf,
  type ProvidedCost,
  parseCostsAsk,
  productEstimate,
} from "./usage/product-costs.js";
export { habitsOf, type SessionHabits } from "./usage/session-habits.js";
export {
  type SkillSpan,
  skillAt,
  skillBoundaries,
  stepOf,
  toolSkillSpans,
} from "./usage/usage-attribution.js";
export { type MeasureUsageResult, measureUsageCommand } from "./usage/usage-commands.js";
export {
  parseUsageAsk,
  REPORT_AXES,
  type ReportAxis,
  type ReportRow,
  type RowOrigin,
  reportOf,
  type Tokens,
  type ToolNotes,
  toolNotes,
  type UsageAsk,
  type UsageReport,
  usageReport,
} from "./usage/usage-report.js";
export { usageCommand } from "./usage/usage-report-command.js";
export type { Estimates, UsageView } from "./usage/usage-rules.js";
export { MemoryUsageTraces, type TraceFile, type UsageTraces } from "./usage/usage-traces.js";
