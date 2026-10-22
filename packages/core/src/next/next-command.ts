import {
  type AgentFrontmatter,
  DOCUMENT_KINDS,
  DOMAIN_IDS,
  type DocumentKind,
  ErrorCode,
  type MethodConfig,
  NextInputSchema,
  NOAH_AGENT,
  PHASE_IDS,
  type ProjectionState,
  REVIEW_DOMAINS,
  StoryIdSchema,
  type ToolId,
  type ValidationMode,
} from "@agentplugged/protocol";
import { invalidInput } from "../agent-activity/agent-commands.js";
import { type DecisionChannels, decisionChannels } from "../chat/channels.js";
import { isHookedClient } from "../chat/chat-proof.js";
import {
  type ResolvedValidationSettings,
  resolveValidationSettings,
} from "../chat/validation-settings.js";
import { delegationOf, type PointsView, pointsView } from "../checkpoints/point-rules.js";
import { existingCi } from "../ci/ci-rules.js";
import { type CommandContext, defineCommand, fail, ok } from "../command.js";
import { type CourseNote, courseNote } from "../course/course-rules.js";
import { type CritiqueNext, critiqueNext } from "../critique/critique-next.js";
import { currentState } from "../deferred/deferred-commands.js";
import { readDocumentFiles } from "../docs/docs-command.js";
import { KNOWLEDGE_BASE_INDEX_PATH } from "../docs/knowledge-base.js";
import { knowledgePagesOf, mergedStoriesOf } from "../docs/knowledge-freshness.js";
import { noticeBranchOf, syncLateNotices } from "../docs/knowledge-notice.js";
import { isPositioning } from "../docs/launch-documents.js";
import { type ParsedDocument, parseDocumentFile } from "../docs/parse-document.js";
import { stepReading } from "../docs/read-sections.js";
import { sheetCommand, sheetStates, staleList } from "../docs/story-sheet.js";
import { engineUpdateOf, updateAvailableOf } from "../engine-update.js";
import { AgentPluggedError } from "../errors.js";
import { gitView } from "../git/git-view.js";
import { workflowOf } from "../git/git-workflow.js";
import { isExistingProduct } from "../init/existing-product.js";
import { METHOD_CONFIG_PATH, METHOD_DIR } from "../init/layout.js";
import { loadMethodConfig } from "../init/method-config.js";
import { isSkipped } from "../journey/journey-rules.js";
import { journeyView } from "../journey/journey-view.js";
import { readRefusals } from "../loop/refusal-registry.js";
import { ARCHITECTURE_PATH, readWorkingBytes } from "../phases/design-review.js";
import { methodNotInstalled } from "../profile/profile-command.js";
import type { StoryState } from "../projection/agent-reducers.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { computeProjection } from "../projection/compute-projection.js";
import { type ReadinessNext, readinessNext } from "../readiness/readiness-next.js";
import type { MainBranchReader } from "../rules/main-branch.js";
import { SPEC_PATH } from "../spec/spec-grow.js";
import { type SpecNext, specNext } from "../spec/spec-next.js";
import { SPEC_SECURITY_REVIEW_PATH } from "../spec/spec-security.js";
import { validatedStories } from "../sprints/sprint-rules.js";
import { readSprintStories } from "../sprints/sprint-stories.js";
import { syncInputsFingerprint } from "../sync/inputs.js";
import { loadManifest, SYNC_MANIFEST_PATH } from "../sync/manifest.js";
import { KIMI_MCP_PATH } from "../sync/mcp.js";
import { skillPhaseKey, skillPhaseOf } from "../sync/phase-skills.js";
import { activeDefinitions, loadDefinitions, syncCommand } from "../sync/sync-command.js";
import { GEMINI_MD_PATH } from "../sync/targets/antigravity.js";
import { CLAUDE_SETTINGS_PATH } from "../sync/targets/claude-code.js";
import { CODEX_CONFIG_PATH } from "../sync/targets/codex.js";
import { CURSOR_RULE_PATH } from "../sync/targets/cursor.js";
import { type TableNext, tableNext } from "../table/table-next.js";
import { detectTools } from "../tools/detect-tools.js";
import { targetedTools } from "../tools/targeted-tools.js";
import type { WorkspaceFiles } from "../workspace-files.js";
import { morningSummary } from "./morning.js";
import {
  answerChannel,
  answerReason,
  decisionQueue,
  type NextConfig,
  type NextDocs,
  type NextStep,
  nextStep,
  pileOf,
  type SyncFreshness,
} from "./next.js";
import { type WebAnswerNote, webAnswersNote } from "./web-answers.js";

export const DOCS_DIR = `${METHOD_DIR}/docs`;
export const EPICS_DIR = `${METHOD_DIR}/epics`;
export const STORIES_DIR = `${METHOD_DIR}/stories`;

/**
 * A file `sync` writes for each targeted tool, whatever the active agents: missing, the tool lacks
 * its files.
 */
export const TOOL_MARKERS: Readonly<Record<ToolId, string>> = {
  "claude-code": CLAUDE_SETTINGS_PATH,
  codex: CODEX_CONFIG_PATH,
  antigravity: GEMINI_MD_PATH,
  cursor: CURSOR_RULE_PATH,
  kimi: KIMI_MCP_PATH,
};

/** The kinds `next` looks for, and the file name that stands for each without a header. */
const UPSTREAM_KINDS = ["brief", "prd", "spec", "ux", "architecture", "epic"] as const;

/** What `next` returns: the step (see `nextStep`). */
export type NextResult = NextStep;

/**
 * What `next` gives an agent: the step, and how the creator is asked **now**.
 * `validation.elicitation` is read from the session as it is at this call (a new connection, a
 * reloaded window may change it): an agent reads it here before it presents each decision, never
 * from an earlier reading. `elicitation` true: the AI tool shows the engine's forms (`ask_creator`,
 * `ask_stack`); `channels` says every channel the creator can click an answer in.
 */
export type AgentNextResult = NextResult &
  CritiqueNext &
  TableNext &
  SpecNext &
  ReadinessNext & {
    /** A correction of course is open: what is left to decide, the stories held. */
    readonly course?: CourseNote;
    /**
     * The answers the creator gave from the web view to points an agent opened, which that agent
     * has not acted on yet: told here because nothing else reaches it. Each names its `agent`.
     */
    readonly web_answers?: readonly WebAnswerNote[];
    readonly validation: {
      readonly mode: ValidationMode;
      /**
       * The local main branch holds commits not published to the remote, settings
       * included (they apply anyway): Noah offers to publish them (`forge_push_main`), or null.
       */
      readonly unpublished: ResolvedValidationSettings["unpublished"];
      readonly proof: "hook" | "unverified";
      readonly elicitation: boolean;
      /** The channels the creator can be asked a decision through, now. */
      readonly channels: DecisionChannels;
      /** The points the creator keeps for themselves, and those the agents decide. */
      readonly points: PointsView;
    };
  };

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1, -3);

async function syncFreshness(
  files: WorkspaceFiles,
  tools: readonly ToolId[],
): Promise<SyncFreshness> {
  const missing: ToolId[] = [];
  for (const tool of tools) if (!(await files.exists(TOOL_MARKERS[tool]))) missing.push(tool);
  const manifest = await files.exists(SYNC_MANIFEST_PATH);
  return {
    manifest,
    missing,
    recorded: manifest ? ((await loadManifest(files)).inputs ?? null) : null,
    current: await syncInputsFingerprint(files),
  };
}

/**
 * Runs `sync` again when the phase whose skills it installed is no longer the current one, and
 * nothing else changed since (a stale method is the creator's `sync` step). A failure changes
 * nothing: the skills of the former phase stay, and every skill stays callable by its name.
 */
async function refreshPhaseSkills(
  context: CommandContext,
  config: MethodConfig,
  projection: Record<string, unknown>,
  now: number,
): Promise<void> {
  const { files } = context;
  if (!(await files.exists(SYNC_MANIFEST_PATH))) return;
  const manifest = await loadManifest(files);
  if (manifest.skills_phase === undefined) return;
  if (manifest.skills_phase === skillPhaseKey(skillPhaseOf(projection, config, now))) return;
  if (manifest.inputs !== (await syncInputsFingerprint(files))) return;
  try {
    const synced = await syncCommand.run(context, {});
    if (synced.ok) await commitPhaseSync(context, projection, synced.value.entries);
  } catch {
    // The next call tries again.
  }
}

/** The commit message of the files a change of phase installed. */
export const PHASE_SYNC_COMMIT_MESSAGE = "Method: skills of the new phase";

/**
 * The files a change of phase wrote are committed by the engine where the creator's Git settings
 * allow a direct commit: left as changes, they would keep the main branch from taking a merge
 * (`base_dirty`). Where no direct commit is allowed, or the branch is not the one checked out
 * here, they stay as `sync` left them. Never fails.
 */
async function commitPhaseSync(
  context: CommandContext,
  projection: Record<string, unknown>,
  entries: readonly { readonly path: string; readonly action: string }[],
): Promise<void> {
  const flow = workflowOf(projection).resolved;
  const workspace = context.storyWorkspace;
  // Only where stories are merged here, by the engine: through a pull request, the working copy of
  // the main branch does not stand in the way of a merge. No branch named: the one checked out here.
  if (flow.merge !== "direct" || workspace?.commitPaths === undefined) return;
  const branch = flow.integration ?? flow.production;
  const paths = [
    ...new Set([
      ...entries.filter((entry) => entry.action !== "unchanged").map((entry) => entry.path),
      SYNC_MANIFEST_PATH,
    ]),
  ];
  try {
    await workspace.commitPaths({ branch, paths, message: PHASE_SYNC_COMMIT_MESSAGE });
  } catch {
    // The files stay as `sync` wrote them.
  }
}

/** A document's kind: its header's `kind` when known, else its file name (`PRD.md` → `prd`). */
function kindOf(parsed: ParsedDocument): DocumentKind | undefined {
  const kind = parsed.kind?.value;
  if (kind !== undefined && (DOCUMENT_KINDS as readonly string[]).includes(kind)) {
    return kind as DocumentKind;
  }
  const name = baseName(parsed.path).toLowerCase();
  return (UPSTREAM_KINDS as readonly string[]).includes(name) ? (name as DocumentKind) : undefined;
}

/** A story's id: its header's `id` when it is one (`2-3`), else the `<e>-<s>` its name starts with. */
function storyIdOf(parsed: ParsedDocument): string | undefined {
  const path = parsed.path;
  if (parsed.kind !== undefined && parsed.kind.value !== "story") return undefined;
  for (const candidate of [parsed.id, baseName(path)]) {
    if (candidate === undefined) continue;
    const match = /^\d{1,6}-\d{1,6}(?![0-9])/.exec(candidate);
    if (match !== null && StoryIdSchema.safeParse(match[0]).success) return match[0];
  }
  return undefined;
}

/** A text with something else than white space. */
const filled = (text: string | undefined) => text !== undefined && text.trim() !== "";

/**
 * True when the map of the knowledge base is a non-empty file of the working copy, or of the main
 * branch (written on another branch and merged, or not pulled here yet). A folder or an
 * empty file is no map; the main branch is read only when the working copy has none, and a failed
 * read counts as no map.
 */
async function knowledgeBasePresent(
  files: WorkspaceFiles,
  mainBranch: MainBranchReader | undefined,
): Promise<boolean> {
  if (filled(await files.readText(KNOWLEDGE_BASE_INDEX_PATH).catch(() => undefined))) return true;
  if (mainBranch === undefined) return false;
  const read = await mainBranch.read(KNOWLEDGE_BASE_INDEX_PATH).catch(() => undefined);
  return read?.found === true && filled(read.text);
}

/**
 * The documents as `next` reads them: the same set as `docs check` (`readDocumentFiles`), each
 * parsed once, an unreadable file left out.
 */
async function readDocs(files: WorkspaceFiles): Promise<NextDocs> {
  const documents = await readDocumentFiles(files, true);
  const texts = new Map(documents.map((file) => [file.path, file.text]));
  const parsed = documents.map((file) => parseDocumentFile(file.path, file.text));
  const inside = (dir: string, path: string) => path.startsWith(`${dir}/`);
  const kinds = new Set<DocumentKind>();
  const stories = new Set<string>();
  // The positioning of the launch.
  const positioning = parsed.some(isPositioning);
  for (const document of parsed) {
    if (inside(DOCS_DIR, document.path)) {
      const kind = kindOf(document);
      if (kind !== undefined) kinds.add(kind);
    } else if (inside(EPICS_DIR, document.path)) {
      // A file of `epics/` is an epic unless its header says otherwise.
      kinds.add(kindOf(document) ?? "epic");
    } else if (inside(STORIES_DIR, document.path)) {
      const id = storyIdOf(document);
      if (id !== undefined) stories.add(id);
    }
  }
  // The architecture as written: a review of another version is stale.
  const architecture = (await files.exists(ARCHITECTURE_PATH))
    ? ((await readWorkingBytes(files, ARCHITECTURE_PATH)) ?? undefined)
    : undefined;
  // The short path's spec: the review of its design must cover this version.
  const spec = (await files.exists(SPEC_PATH))
    ? ((await readWorkingBytes(files, SPEC_PATH)) ?? undefined)
    : undefined;
  const specReview = (await files.exists(SPEC_SECURITY_REVIEW_PATH))
    ? ((await readWorkingBytes(files, SPEC_SECURITY_REVIEW_PATH)) ?? undefined)
    : undefined;
  return {
    kinds: [...kinds],
    stories: [...stories],
    ...(architecture === undefined ? {} : { architecture }),
    ...(spec === undefined ? {} : { spec }),
    ...(specReview === undefined ? {} : { spec_review: specReview }),
    // The pages of the knowledge base and what they were built from.
    knowledge_pages: knowledgePagesOf(parsed, (path) => texts.get(path)),
    positioning,
  };
}

/**
 * The active agents (as `sync` generates them), by id, with their display name; and the active
 * reviewers of each kind, by their domain.
 */
async function activeAgents(
  files: WorkspaceFiles,
  config: MethodConfig,
): Promise<
  | { agents: Record<string, string>; reviewers: { qa: string[]; security: string[] } }
  | AgentPluggedError
> {
  const definitions = await loadDefinitions(files);
  if (definitions instanceof AgentPluggedError) return definitions;
  const agents: Record<string, string> = Object.create(null);
  const reviewers = { qa: [] as string[], security: [] as string[] };
  for (const definition of activeDefinitions(definitions, config)) {
    if (definition.kind !== "agent") continue;
    agents[definition.name] = definition.agent?.name ?? definition.name;
    const domain = (definition.frontmatter as AgentFrontmatter).metadata?.domain;
    if (domain === REVIEW_DOMAINS.qa) reviewers.qa.push(definition.name);
    if (domain === REVIEW_DOMAINS.security) reviewers.security.push(definition.name);
  }
  return { agents, reviewers };
}

function preferredTools(config: MethodConfig): Record<string, ToolId> {
  const preferred: Record<string, ToolId> = Object.create(null);
  for (const [id, settings] of Object.entries(config.agents?.settings ?? {})) {
    if (settings.tool !== undefined) preferred[id] = settings.tool;
  }
  return preferred;
}

/**
 * `next`: the product's next step (the step, the agent to call and where, what waits for the
 * creator), from the projection computed again from the journal, the documents of
 * `.agentplugged/`, the active agents and the profile. A read command: it writes nothing and
 * never reads a key; an agent may run it. Without a Git repository, the journal is empty. The one
 * thing it writes besides the journal is the late notice of a page of the knowledge base (story
 * 3.41), at the top of that page only, in a commit of its own where the creator's Git settings
 * allow one: the working copy is never left with a change not committed.
 */
export const nextCommand = defineCommand<NextResult>({
  name: "next",
  async run(context, input) {
    // `reading` (true) asks for the passages of the documents the step's agent reads: only that
    // agent asks for it; whoever just follows the step (Noah) does not pay for it.
    const wantsReading = input.reading === true;
    const extra = Object.keys(input).find((key) => key !== "reading");
    if (extra !== undefined) {
      return fail(
        new AgentPluggedError(ErrorCode.INVALID_ARGUMENTS, "error.invalid_arguments", {
          reason: extra,
        }),
      );
    }
    const { files } = context;
    if (!(await files.exists(METHOD_CONFIG_PATH))) return fail(methodNotInstalled());
    const loaded = await loadMethodConfig(files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    const { config } = loaded;
    try {
      // What the creator did on the forge is recorded before the step is computed.
      await (await import("../merge/forge-follow.js")).followForge(context);
      let projection: ProjectionState["state"] = {};
      let journalRead = false;
      if (context.journal !== undefined) {
        try {
          const listing = await context.journal.list();
          const state = await computeProjection(listing.events, {
            problems: listing.problems,
            head: listing.head,
            ...(config.product_id === undefined ? {} : { product: config.product_id }),
            allowTestTypes: context.allowTestTypes === true,
          });
          projection = state.state;
          journalRead = true;
        } catch (error) {
          // A folder without Git has no journal yet: nothing waits, nothing is blocked.
          if (!(error instanceof AgentPluggedError && error.code === ErrorCode.NOT_A_GIT_REPO)) {
            throw error;
          }
        }
      }
      const active = await activeAgents(files, config);
      if (active instanceof AgentPluggedError) return fail(active);
      const { agents, reviewers } = active;
      const tools = await targetedTools(config, () => detectTools(context.tools));
      // The points the creator keeps for themselves: the agents decide the others,
      // when an agent other than Noah is there to; absent while the creator has not chosen.
      const settings = await resolveValidationSettings(config, context.mainBranch);
      const delegation = Object.keys(agents).some((agent) => agent !== NOAH_AGENT)
        ? delegationOf(settings)
        : undefined;
      const nextConfig: NextConfig = {
        domains: config.profile?.domains ?? DOMAIN_IDS,
        phases: config.profile?.phases ?? PHASE_IDS,
        tools,
        preferred: preferredTools(config),
        agents,
        reviewers,
        existing: isExistingProduct(config),
        ...(delegation === undefined ? {} : { delegation }),
      };
      const now = (context.now ?? Date.now)();
      // A phase ended since the last `sync`: the engine installs the skills of the new one itself.
      if (journalRead) await refreshPhaseSkills(context, config, projection, now);
      const state = {
        projection,
        now,
        sync: await syncFreshness(files, tools),
        refusals: await readRefusals(files),
      };
      const docs = await readDocs(files);
      // The knowledge base: Zoé's first step on an existing product, and what the
      // positioning of the launch is drawn from.
      const knowledgeBase = await knowledgeBasePresent(files, context.mainBranch);
      // The stories a sprint may take: valid, and validated at their content.
      const sprintStories = await readSprintStories(files);
      const checkpoints = Object.values(
        (projection.checkpoints as Record<string, CheckpointState> | undefined) ?? {},
      );
      // A page of the base that is behind says so itself, in a commit of the engine
      // where the creator's Git settings allow one (never a dirty working copy); elsewhere the
      // pages behind are told here, in `late_pages`. Never a reason for `next` to fail.
      const notices = await syncLateNotices(
        files,
        { branch: noticeBranchOf(projection), workspace: context.storyWorkspace },
        { checkpoints, merges: mergedStoriesOf(projection), now },
      );
      // A story whose contract the creator skipped needs neither to be valid nor to be
      // validated (only to be readable): the sprint may take it, and a developer may start it.
      const validated = validatedStories(sprintStories, checkpoints, now);
      const plannable = [...sprintStories.keys()].filter((id) => {
        const state = sprintStories.get(id)?.state;
        if (isSkipped(projection, "story_contract", id)) return state !== "unreadable";
        return validated.has(id) && state === "valid";
      });
      // The product's CI: none, and `next` proposes Omar's `setup_ci`.
      // Read at the repository's top when the method sits in a folder of it; `ci setup` runs
      // only at the top, so `setup_ci` is never proposed elsewhere.
      const repository =
        context.ciReader === undefined
          ? undefined
          : await context.ciReader.repository().catch(() => null);
      const ci =
        repository === undefined || repository === null
          ? (await existingCi(files)).length > 0
          : repository.ci.length > 0;
      const ciSetup = repository === undefined ? {} : { ci_setup: repository?.prefix === "" };
      const step = nextStep(
        state,
        { ...docs, knowledge_base: knowledgeBase, plannable, ci, ...ciSetup },
        nextConfig,
      );
      // Where the creator answers: in the chat, but `review` for a high risk at
      // the `strict` level.
      const { mode } = settings;
      const checkpointsOfState =
        (projection.checkpoints as Record<string, CheckpointState> | undefined) ?? {};
      const answer = answerChannel(step, checkpointsOfState, mode);
      // Why the terminal: `strict` only when the level is `strict`.
      const reason = answerReason(step, checkpointsOfState, mode);
      // The decisions waiting for the creator, in Noah's order.
      // The fast track of the step's story.
      const stories = (projection.stories as Record<string, StoryState> | undefined) ?? {};
      const track =
        step.story !== null && Object.hasOwn(stories, step.story)
          ? stories[step.story]?.fast_track
          : undefined;
      const fast: Partial<NextStep> =
        track === undefined
          ? {}
          : {
              fast_track: {
                status: track.status,
                left_by: track.left?.by ?? null,
                reasons: track.left?.reasons ?? [],
              },
            };
      const decisions = decisionQueue(projection, now, mode, delegation);
      // The story sheets behind the documents they quote; never a reason for `next` to fail.
      const merged = new Set(mergedStoriesOf(projection).map((entry) => entry.story));
      const staleSheets = await readDocumentFiles(files, true)
        .then((current) =>
          sheetStates(current)
            .filter((sheet) => sheet.stale.length > 0 && !merged.has(sheet.story))
            .map((sheet) => ({
              story: sheet.story,
              path: sheet.path,
              excerpts: staleList(sheet.stale),
              command: sheetCommand(sheet.story),
            })),
        )
        .catch(() => []);
      // What the step's agent reads of the documents: passages, never a document; never a reason
      // for `next` to fail.
      const reading =
        !wantsReading || step.agent === null || step.you
          ? undefined
          : await readDocumentFiles(files, true)
              .then((current) => stepReading(current, step.agent ?? "", step.story))
              .catch(() => undefined);
      return ok({
        ...step,
        ...fast,
        ...(reading === undefined ? {} : { reading }),
        ...(notices.pending.length === 0 ? {} : { late_pages: notices.pending }),
        ...(staleSheets.length === 0 ? {} : { stale_sheets: staleSheets }),
        answer,
        ...(reason === undefined ? {} : { answer_reason: reason }),
        decisions,
        // Everything waiting for the creator as one stack, and what the night did.
        pile: pileOf(projection, now, mode, decisions),
        morning: morningSummary(projection, decisions),
        // The steps the creator skipped, shown as such.
        journey: journeyView(projection),
        // The creator's Git workflow, and what waits in staging.
        git: gitView(projection, now, { forge: repository?.forge != null }),
      });
    } catch (error) {
      if (error instanceof AgentPluggedError) return fail(error);
      throw error;
    }
  },
});

/**
 * `next` for the agents: the same step as the creator's `next`, exposed by the
 * MCP server so that Noah reads the next step and the decisions waiting for the creator. A read
 * command: it writes nothing and never reads a key.
 */
export const nextAgentCommand = defineCommand<AgentNextResult>({
  name: "next",
  audience: "agent",
  description:
    "Read the product's next step: the step, the active agent to call and in which tool, the story or checkpoint it concerns, the open checkpoints (`waiting`), where the creator answers (`answer`: `chat`, or `terminal` with its `answer_reason`: `strict`, a high risk at the strict level only) and `decisions`: the checkpoints waiting for the creator in the order to present them one at a time (by risk, then by the actions they block, then oldest first), each with its recommendation. `validation` says how the creator is asked right now: `channels` (`available`: the ways to click an answer, in the order the engine tries them, then `chat`; call ask_creator or ask_stack when it holds more than `chat`), `elicitation` (the form alone is usable), `mode` and `proof`; it is read at each call, so read it before each decision, never from an earlier reading; `validation.points` says which points the creator keeps (`fixed`) and which the agents decide (`delegated`). `validation.unpublished` (when not null) says the local main branch holds commits not published to the remote, the creator's settings among them, which apply anyway: Noah offers once to publish them with request_creator_action `forge_push_main` (never forced), one « oui », never a command to type. The step `point_decision` hands a point the creator did not keep to the agent it names (decide_checkpoint). `independent: true` marks work that does not depend on the points waiting for the creator: do it; `stop: true`: nothing independent is left, stop. `pile` is the single stack of everything waiting (open_stack with `pile.stack`), and `morning` the summary of what happened since the creator last answered. `journey.skipped` lists the steps of the proposed journey the creator skipped: they are never errors, never proposed again, and the creator may take one up again (`step_resume`); never skip a step yourself, the creator says it. `update_available` / `engine_update`: a newer engine to propose once (request_creator_action `engine_update`). `background`, when present, is Zoé's update of the knowledge base pages that are behind, to run beside the step (in another session, never in place of it, never holding a developer). `critique`, when present (`kind`, `why`), is the critique of the structuring document the creator is about to validate, at risk: offer it in one line, once (review.critique `propose` records it; never impose it); `kind: idea` offers to test the idea or write the press release first. `table`, when present (`format: three_views`, `story`, `agents`: product, delivery, quality), offers the three views of a sensitive story whose merge waits for the creator: one line, once per story (chat.table with `table` {`story`} alone records it; never impose it). `hypotheses_due` lists the open hypotheses an evidence arrived for (a proof, a merged story): show them in one line each and let the creator close them or keep them open. `spec_path`, when present, is the short path (one spec instead of the brief, the PRD and the architecture): `choose` (a new product at its framing: propose the path, once, after `docs path`), `grow` (the spec outgrew it, `spec_path_why` says why: offer the full path in one line), `risk` (the spec speaks of sensitive data its scope does not declare: same line) or `carry` (the full path is on again while a spec stands: `docs grow` carries it over). `web_answers`: answers given in the web view to your points (yours = `agent`), until you write something: apply like a chat answer.`reading`, asked with `reading: true` by the agent doing the step only, holds the passages of the PRD, architecture and UX specification that agent needs and the `command` (`docs read`) for the rest: never read a whole document. `refused`: the latest refusal of an agent's call with its gesture `do`; refused twice the same way, `change_method` says not to try again. `stale_sheets` lists story sheets quoting a passage changed since: the scrum master writes each again (`command`) and opens the story's `document` checkpoint again when it was validated. `late_pages` lists knowledge base pages that are behind the code and carry no late notice (the creator's Git settings give the engine no commit): treat them as late, never rely on them. It writes nothing but, where the creator's Git settings allow it, a commit of its own adding the late notice to a knowledge base page.",
  inputSchema: NextInputSchema,
  // It says that the session must move to the version the product pins.
  allowsOlderEngine: () => true,
  async run(context, input) {
    const parsed = NextInputSchema.safeParse(input);
    if (!parsed.success) return fail(invalidInput("next", parsed.error));
    const step = await nextCommand.run(
      context,
      parsed.data.reading === true ? { reading: true } : {},
    );
    if (!step.ok) return step;
    // Always fresh: read now, from this session (never from the journal, never cached).
    const loaded = await loadMethodConfig(context.files);
    if (loaded instanceof AgentPluggedError) return fail(loaded);
    const settings = await resolveValidationSettings(loaded.config, context.mainBranch);
    const hooked = context.chat?.hooked === true || isHookedClient(context.session?.client);
    const channels = await decisionChannels(context);
    const update = await engineUpdateOf(context);
    const available = await updateAvailableOf(context, () => currentState(context));
    // Said only while the journal is not saved; a blocked one is told once.
    const backup = await context.journalBackup?.report({ consume: true }).catch(() => undefined);
    // The critique to offer before a document is validated, the hypotheses brought back.
    const critique = await critiqueNext(context, step.value).catch((): CritiqueNext => ({}));
    // The three views of a sensitive story, offered once before its merge.
    const table = await tableNext(context, step.value).catch((): TableNext => ({}));
    // The path to propose (short or full), a spec that outgrew the short one.
    const path = await specNext(context, step.value).catch((): SpecNext => ({}));
    // The readiness gate before the stories are cut and before the first one.
    const readiness = await readinessNext(context, step.value).catch((): ReadinessNext => ({}));
    // A correction of course that is open, until its last decision is taken.
    const state = await currentState(context);
    const course = courseNote(state);
    const answers = webAnswersNote(state, (context.now ?? Date.now)());
    return ok({
      ...step.value,
      ...critique,
      ...table,
      ...(course === undefined ? {} : { course }),
      ...(answers.length === 0 ? {} : { web_answers: answers }),
      ...path,
      ...readiness,
      validation: {
        mode: settings.mode,
        unpublished: settings.unpublished,
        proof: hooked ? "hook" : "unverified",
        elicitation: channels.available.includes("elicitation"),
        channels,
        points: pointsView(settings.points),
      },
      // The engine that answers (the session moves between versions between two calls).
      engine_version: context.engineVersion,
      ...(update === undefined ? {} : { engine_update: update }),
      ...(available === undefined ? {} : { update_available: available }),
      ...(backup === undefined ? {} : { journal_backup: backup }),
    });
  },
});
