import { z } from "zod";

/** Stable error codes, in SCREAMING_SNAKE_CASE. */
export const ErrorCode = {
  METHOD_CONFIG_INVALID: "METHOD_CONFIG_INVALID",
  /** The command needs `.agentplugged/method.yaml`, and `init` has not been run. */
  METHOD_NOT_INSTALLED: "METHOD_NOT_INSTALLED",
  /** An agent or skill definition (`SKILL.md`) breaks the format; `details` names file and field. */
  AGENT_DEFINITION_INVALID: "AGENT_DEFINITION_INVALID",
  /** The constitution (`AGENTS.md` or `.agentplugged/AGENTS.md`) is missing: run `init`. */
  CONSTITUTION_MISSING: "CONSTITUTION_MISSING",
  /** `.claude/settings.json` cannot be read as settings: nothing was written. */
  SETTINGS_INVALID: "SETTINGS_INVALID",
  /** `agent create`: an agent or skill (shipped, in the catalog or the creator's) has this id. */
  AGENT_EXISTS: "AGENT_EXISTS",
  /** `agent edit|enable|disable`: no agent or skill has this id. */
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  /**
   * A customisation (`.agentplugged/overrides/agents/<id>.yaml`) is invalid or names no agent;
   * `details` names file and field. Nothing was written.
   */
  OVERRIDE_INVALID: "OVERRIDE_INVALID",
  /**
   * `method.yaml` pins another engine version than the running one: nothing was written.
   * `details.pinned` and `details.command` say how to run the pinned engine.
   */
  ENGINE_VERSION_MISMATCH: "ENGINE_VERSION_MISMATCH",
  /**
   * `method.yaml` uses a `format_version`, or an event envelope a `v`, newer than the running
   * engine knows: update it.
   */
  UPGRADE_REQUIRED: "UPGRADE_REQUIRED",
  /**
   * An event envelope breaks the v1 schema:
   * `details: { field, reason_key }` names the first field at fault.
   */
  EVENT_INVALID: "EVENT_INVALID",
  /**
   * An event's signature does not verify, or its declared `assurance` is not the one the
   * signature gives: `details.reason_key` says why.
   */
  SIGNATURE_INVALID: "SIGNATURE_INVALID",
  /**
   * Another process held the journal lock (`agentplugged-journal.lock` in the common Git folder)
   * for longer than the wait allows: nothing was written. `details.lock` names the file.
   */
  JOURNAL_BUSY: "JOURNAL_BUSY",
  /** The command needs a Git repository, and the folder is not in one: nothing was written. */
  NOT_A_GIT_REPO: "NOT_A_GIT_REPO",
  /**
   * The product id given (`method.yaml`, or an event's `product`) is not the one the journal
   * holds (its `product.created` event): nothing was written. `details.journal_product_id` names it.
   */
  PRODUCT_ID_MISMATCH: "PRODUCT_ID_MISMATCH",
  /**
   * `journal sync`: the remote journal no longer holds events already seen there or held locally
   * (its tip does not descend from the last one seen, lacks event files, or the branch was
   * deleted after being seen). Nothing was integrated or pushed. `details: { remote, missing }`,
   * `missing` being the number of event files gone.
   */
  JOURNAL_REWRITTEN: "JOURNAL_REWRITTEN",
  /**
   * `journal sync`: an incoming file is not a canonical event at its path, holds an id already
   * held at another path, lies outside `journal/`, or a path holds two different contents.
   * Nothing was written. `details: { remote, path }`.
   */
  JOURNAL_CONFLICT: "JOURNAL_CONFLICT",
  /**
   * `journal sync`: the remote kept moving, and every push was refused as not a fast-forward.
   * The local journal holds the events integrated so far. `details: { remote, attempts }`.
   */
  JOURNAL_PUSH_REJECTED: "JOURNAL_PUSH_REJECTED",
  /**
   * `journal sync`: Git could not reach the remote (network, authentication, missing repository,
   * timeout). Nothing was integrated or pushed. `details: { remote, reason }`, `reason` being
   * Git's own one-line message.
   */
  JOURNAL_REMOTE_UNREACHABLE: "JOURNAL_REMOTE_UNREACHABLE",
  /**
   * `journal sync`: no Git remote is configured (`details: {}`), or the one named does not exist
   * (`details: { remote }`). Nothing was done.
   */
  NO_REMOTE: "NO_REMOTE",
  /**
   * An agent's command would take an action an open checkpoint blocks (`story.review`,
   * `story.complete`…): nothing was written. `details: { checkpoint, action }`.
   */
  CHECKPOINT_OPEN: "CHECKPOINT_OPEN",
  /** `report_measures` or `review`: no checkpoint has this id. `details: { checkpoint }`. */
  CHECKPOINT_NOT_FOUND: "CHECKPOINT_NOT_FOUND",
  /**
   * `report_measures` or `review`: the checkpoint is no longer open (already answered).
   * `details: { checkpoint, status }`.
   */
  CHECKPOINT_NOT_OPEN: "CHECKPOINT_NOT_OPEN",
  /**
   * `review` or `key` was run without an interactive terminal (standard input and output both
   * terminals): only the creator answers a checkpoint or links a key, at the keyboard. Nothing
   * was written. `details: { command }`. Also `rules set` and `rules reset`.
   */
  REVIEW_NOT_INTERACTIVE: "REVIEW_NOT_INTERACTIVE",
  /**
   * `review` or `key endorse`: this machine has no creator's key. Nothing was written: run
   * `npx agentplugged init` (or `key presence`) first.
   */
  HUMAN_KEY_MISSING: "HUMAN_KEY_MISSING",
  /**
   * `review` or `key endorse`: this creator's key is not trusted in this product yet (another
   * creator's key came first): an endorsed creator runs `npx agentplugged key endorse <device>`.
   * Nothing was written. `details: { device }`.
   */
  HUMAN_KEY_UNENDORSED: "HUMAN_KEY_UNENDORSED",
  /**
   * The journal holds another root of trust than the one this machine pinned:
   * no order is given for this product until the creator runs `trust dismiss` at the terminal.
   * `details: { events }`, the faulty events (their ids).
   */
  SECURITY_ROOT_CHANGED: "SECURITY_ROOT_CHANGED",
  UNKNOWN_COMMAND: "UNKNOWN_COMMAND",
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  /** The creator stopped answering (end of input): nothing was written. */
  CANCELLED: "CANCELLED",
  /** A failure nobody anticipated (for example a file-system error); `details.reason` says why. */
  UNEXPECTED: "UNEXPECTED",
  /**
   * `docs check`: a document's header is missing or breaks the schema.
   * `details: { path, line, field, reason }`.
   */
  DOC_HEADER_INVALID: "DOC_HEADER_INVALID",
  /** `docs check`: two documents share an `id`. `details: { path, line, id, first }`. */
  DOC_ID_DUPLICATE: "DOC_ID_DUPLICATE",
  /**
   * `docs check`: a requirement identifier is defined twice in the working copy.
   * `details: { path, line, id, first, first_line }`.
   */
  REQ_ID_DUPLICATE: "REQ_ID_DUPLICATE",
  /**
   * `docs check`: an identifier defined in the base is gone (it must be kept, marked retired).
   * `details: { path, line, id, base }`, `path` and `line` being its place in the base.
   */
  REQ_ID_REMOVED: "REQ_ID_REMOVED",
  /**
   * `docs check`: an identifier retired in the base is active again.
   * `details: { path, line, id, base, base_path, base_line }`.
   */
  REQ_ID_REUSED: "REQ_ID_REUSED",
  /**
   * `docs check`: the text of a base definition is now under another identifier.
   * `details: { path, line, from, to, base, base_path, base_line }`.
   */
  REQ_ID_RENUMBERED: "REQ_ID_RENUMBERED",
  /**
   * `docs check`: a code fence is never closed, so the lines after it are not read.
   * `details: { path, line }`, `line` being the fence's.
   */
  DOC_UNCLOSED_FENCE: "DOC_UNCLOSED_FENCE",
  /**
   * `docs check`: a header link names no document, or no active requirement.
   * `details: { path, line, link }`.
   */
  DOC_LINK_DANGLING: "DOC_LINK_DANGLING",
  /**
   * `docs check`: a document's kind does not fit its folder (`epics/` holds epics, `stories/`
   * stories). `details: { path, line, kind, expected, folder }`.
   */
  DOC_KIND_MISMATCH: "DOC_KIND_MISMATCH",
  /**
   * `history --export`: a file already exists at the path given, and `--force` was not passed.
   * Nothing was written. `details: { path }`.
   */
  FILE_EXISTS: "FILE_EXISTS",
  /**
   * Sensitive content (an encrypted event, a file of the Salle or of the memory) needs the product
   * key, and this machine's keychain has none: nothing was written. Import it (`key export` on a
   * machine that has it, then `key import` here). `details: { product, key_id? }`.
   */
  PRODUCT_KEY_MISSING: "PRODUCT_KEY_MISSING",
  /**
   * The product key given or found is not the one the journal announces (`product.key_created`),
   * or the file was encrypted with another key: nothing was written.
   * `details: { key_id, journal_key_id }`.
   */
  PRODUCT_KEY_MISMATCH: "PRODUCT_KEY_MISMATCH",
  /**
   * `key export` or `key import`: the passphrase is too short, the two entries differ, or it does
   * not open the exported key. Nothing was written. `details: { reason }`.
   */
  PASSPHRASE_INVALID: "PASSPHRASE_INVALID",
  /**
   * `read_sensitive`: the file of the Salle or of the memory is in clear (written by hand, or
   * before encryption): never served as trusted content. The creator encrypts such files with
   * `npx agentplugged key seal`. `details: { area, path }`.
   */
  SENSITIVE_NOT_ENCRYPTED: "SENSITIVE_NOT_ENCRYPTED",
  /**
   * The system keychain refuses any new entry because it is full (Windows Credential Manager:
   * "Windows error code 8"): nothing was written. The creator removes old entries (Windows:
   * Credential Manager, "Windows Credentials"; `cmdkey /list`, `cmdkey /delete:<target>`).
   * `details: { reason }`, the system's message.
   */
  KEYCHAIN_FULL: "KEYCHAIN_FULL",
  /**
   * A command of the retrospective and of the memory (`propose_retrospective`,
   * `record_lessons`, `propose_promotion`, `promote_lesson`) refuses. Nothing was written.
   * `details: { reason, … }` (`MEMORY_INVALID_REASONS`).
   */
  MEMORY_INVALID: "MEMORY_INVALID",
  /**
   * `rules set`: the rule asked for loosens a locked action (`push_main`, `force_push` and
   * `read_secrets` are always `deny`; `destructive_command` is never `allow`). Nothing was
   * written. `sync` and `rules` also report a locked rule loosened by hand in `method.yaml`, and
   * apply the locked value. `details: { action, value, allowed }`.
   */
  RULE_LOCKED: "RULE_LOCKED",
  /**
   * `open_checkpoint` with `phase_end`: the phase is not the current one (a later, an earlier or
   * a skipped phase), there is no current phase, or its end is already open. Nothing was written.
   * `details: { phase, current, reason, checkpoint? }` (`not_current`, `none_current`,
   * `already_open`).
   */
  PHASE_NOT_CURRENT: "PHASE_NOT_CURRENT",
  /**
   * `open_checkpoint` with `phase_end`: this agent does not close that phase. Nothing
   * was written. `details: { agent, phase, closers }`, the active agents that close it (`main`
   * when none is active).
   */
  AGENT_NOT_CLOSER: "AGENT_NOT_CLOSER",
  /**
   * `open_checkpoint` with `phase_end`: a `document` checkpoint of a structuring document (brief,
   * PRD, UX specification, architecture) of this phase is still open. Nothing was
   * written: the creator answers that one first, then the end of the phase is opened.
   * `details: { phase, checkpoint }`.
   */
  DOCUMENT_REVIEW_OPEN: "DOCUMENT_REVIEW_OPEN",
  /**
   * `method.yaml` uses a `format_version` older than the running engine knows: nothing was
   * written. Run `npx agentplugged migrate`. `details: { path, format_version,
   * supported, engine_version, command }`.
   */
  MIGRATION_REQUIRED: "MIGRATION_REQUIRED",
  /**
   * `migrate`: the journal already records a migration this working copy has not received (by
   * another machine, or with a newer engine), or `method.yaml` changed while `migrate` ran.
   * Nothing was written. `details: { reason, event_id?, format_version?, engine? }`.
   */
  MIGRATION_CONFLICT: "MIGRATION_CONFLICT",
  /**
   * `docs check`: an active architecture decision (`AD-n`) of a `kind: architecture` document
   * lacks one of its three fields. `details: { path, line, id, missing }`, `missing`
   * listing `Binds`, `Prevents` and/or `Rule`.
   */
  AD_FIELDS_MISSING: "AD_FIELDS_MISSING",
  /**
   * `docs check`: the scope a `kind: spec` document declares (size, users, sensitive, integrations,
   * platforms, asked) is unreadable, or says the short path does not suit the product: a risk
   * (personal data, payment, accounts) the creator did not explicitly ask the short path for, or
   *. `details: { path, line, reason, why? }`,
   * `reason` being `scope` or `risk_not_asked`. A spec that merely outgrew the short path is not an
   * error: `next` says so (`spec_path: grow`).
   */
  SPEC_SCOPE: "SPEC_SCOPE",
  /**
   * `open_checkpoint` with `phase_end` for `design`, while Chloé is active: the end does not carry
   * a security review of the architecture she submitted during the phase for the architecture
   * cited. Nothing was written. `details: { phase, reason, agent, document, architecture }`
   *, `reason` being one of `not_submitted`, `invalid_date`, `path_case`,
   * `not_attached`, `architecture_not_attached`, `review_mismatch`, `stale`,
   * `review_file_missing`, `review_file_changed`, `review_not_security_reviewer`, `architecture_changed`.
   */
  SECURITY_REVIEW_MISSING: "SECURITY_REVIEW_MISSING",
  /**
   * `docs check`: an active `EF-n` or `ENF-n` of the PRD is in no story's
   * `requirements` nor in an epic's `out_of_scope`. `details: { path, line, id }`.
   */
  REQ_NOT_COVERED: "REQ_NOT_COVERED",
  /**
   * `docs check`: a section of a story's body is missing, empty or given twice.
   * `details: { path, line, section, reason }` (`missing`, `empty`, `duplicate`).
   */
  STORY_SECTION_INVALID: "STORY_SECTION_INVALID",
  /**
   * `docs check`: a story depends on a later one (same or higher order).
   * `details: { path, line, story, dependency }`.
   */
  STORY_DEPENDENCY_FORWARD: "STORY_DEPENDENCY_FORWARD",
  /** `docs check`: stories depend on each other in a loop. `details: { path, line, cycle }`. */
  STORY_DEPENDENCY_CYCLE: "STORY_DEPENDENCY_CYCLE",
  /**
   * `docs check`: the intent of a story differs from the one the creator approved in a `document`
   * checkpoint. `details: { path, line, story, checkpoint, reason, approved_path, blob }`
   * (`changed`, `removed`: gone although this branch held it, `no_intent`: the approved version
   * holds no story with an intent section). Also `update_story` `in_review` and the `complete`
   * result that moves a story to review, while the last commit of the story's branch
   * no longer holds the approved intent: `message_key` `error.story_intent_changed.on_branch`,
   * `details: { story, reason, checkpoint, branch, path }` (`changed`, `no_intent`, `removed`).
   * Nothing written.
   */
  STORY_INTENT_CHANGED: "STORY_INTENT_CHANGED",
  /**
   * `update_story` `in_review` and the `complete` result that moves a story to review (story
   * 17.3): a criterion has no test seen failing then passing, and is not declared untestable.
   * `details: { story, missing }` (one short line per criterion). Nothing written.
   */
  CRITERIA_NOT_PROVEN: "CRITERIA_NOT_PROVEN",
  /**
   * `docs check`: a template marker (`<…>`) is left in the title or the body of a story or an
   * epic. `details: { path, line, marker }`.
   */
  DOC_PLACEHOLDER_LEFT: "DOC_PLACEHOLDER_LEFT",
  /**
   * `plan_sprint`: the proposed sprint breaks a rule; nothing was written.
   * `details: { count, first, problems }`: `count`, the number of problems; `first`, a readable
   * line for the first one, preferring one that names a story (`over_budget` with the total and
   * the ceiling, `no_capacity` explained); `problems`, each `{ reason, story?, dependency?, agent?,
   * checkpoint?, why?, budget_usd?, limit?, field?, max? }` (`SPRINT_PROBLEM_REASONS`).
   */
  SPRINT_INVALID: "SPRINT_INVALID",
  /** `complete_deferred` or `deferred`: no item of deferred work has this id. `details: { item }`. */
  DEFERRED_NOT_FOUND: "DEFERRED_NOT_FOUND",
  /**
   * `complete_deferred` or `deferred`: the item is already closed (done or dropped). Nothing was
   * written. `details: { item, status }`.
   */
  DEFERRED_NOT_OPEN: "DEFERRED_NOT_OPEN",
  /**
   * An open item of deferred work locks the story: it neither starts nor merges until
   * the item is done or dropped. Nothing was written. `details: { story, action, count, items,
   * first, title }`, `action` being `start` or `merge`, `items` the open items in recording order.
   */
  STORY_LOCKED: "STORY_LOCKED",
  /**
   * `complete_deferred`: this agent may not close the item. Only its owner (an agent) or the agent
   * that recorded it closes it; an item the creator owns closes only at the creator's terminal
   * (`deferred resolve|drop`). Nothing was written. `details: { item, agent, owner }`.
   */
  DEFERRED_NOT_ALLOWED: "DEFERRED_NOT_ALLOWED",
  /**
   * `complete_deferred` or `deferred`: the closing was written, but the projection does not apply
   * it (another machine's clock, an item recorded meanwhile elsewhere): the item is still open.
   * `details: { item, event }`. Run `journal sync`, then try again.
   */
  DEFERRED_CLOSING_IGNORED: "DEFERRED_CLOSING_IGNORED",
  /**
   * `story start` and `start_story`: the story cannot start; nothing was created nor
   * written. `details: { story, reason, ... }` (`STORY_START_REASONS`), with `why`, `status`,
   * `device`, `sprint`, `dependency`, `branch`, `base_ref` or `path` as the reason needs.
   */
  STORY_NOT_STARTABLE: "STORY_NOT_STARTABLE",
  /**
   * An agent's write on a story paused by its budget: a budget checkpoint of the story
   * is open, the creator stopped it, or its cost is already over a new ceiling (`pending`).
   * Nothing was written. `details: { story, reason, checkpoint, budget_usd, budget }`. Stop working
   * on it: report what is left with `report_cost`, end with `submit_result` `partial`.
   * No longer raised: the public engine has no budget ceiling (kept for old journals).
   */
  BUDGET_EXCEEDED: "BUDGET_EXCEEDED",
  /**
   * `story pr` and `open_pull_request`: the story's pull request cannot open; nothing
   * was pushed nor written. `details: { story, reason, ... }` (`PULL_REQUEST_REASONS`), with
   * `agent`, `expected`, `status`, `branch` or `url` as the reason needs.
   */
  PULL_REQUEST_NOT_OPENABLE: "PULL_REQUEST_NOT_OPENABLE",
  /**
   * `story pr` and `open_pull_request`: the forge is not linked (no remote, a forge
   * the engine does not know, its command-line tool missing or not logged in). Nothing was
   * pushed. `details: { story, reason, forge?, host?, cli?, checkpoint? }`
   * (`FORGE_LINK_REASONS`); `checkpoint` is the one opened for the creator (MCP only).
   */
  FORGE_NOT_LINKED: "FORGE_NOT_LINKED",
  /**
   * `story pr` and `open_pull_request`: the push or the forge failed. `details: {
   * story, reason, message }` (`PULL_REQUEST_FAILURES`), `message` on one line, without
   * credentials.
   */
  PULL_REQUEST_FAILED: "PULL_REQUEST_FAILED",
  /**
   * `story ci`, `check_ci` and `ci setup`: the CI cannot be read or set up; nothing was
   * written. `details: { story?, reason, ... }` (`CI_UNAVAILABLE_REASONS`), with `tool`, `branch`
   * or `reason` as the reason needs.
   */
  CI_UNAVAILABLE: "CI_UNAVAILABLE",
  /**
   * `review`: the merge checkpoint of a story waits for a green CI read after the
   * story's last status, for its review, and for no open deviation. `details: {
   * checkpoint, story, ci, review, deviations, untriaged, fast_track? }` (what the
   * fast track holds back, `unverified`, `exceeded`, `left_open` or `stopped`).
   */
  MERGE_NOT_READY: "MERGE_NOT_READY",
  /**
   * `review`, `decide_checkpoint`, `answer_checkpoint`: a `release` point is not
   * approved while a non-functional requirement has no valid proof or a failed one, unless the
   * creator settled the gap. `details: { checkpoint, open, failed, requirements }`.
   */
  RELEASE_NOT_READY: "RELEASE_NOT_READY",
  /**
   * `trace <EF-n>` and `get_trace`: no `EF-n` / `ENF-n` of a `prd` document has this
   * id. `details: { requirement }`.
   */
  REQUIREMENT_NOT_FOUND: "REQUIREMENT_NOT_FOUND",
  /**
   * `report_deviation`: nothing was written. `details: { story, reason, requirement? }`
   * (`DEVIATION_NOT_REPORTABLE_REASONS`).
   */
  DEVIATION_NOT_REPORTABLE: "DEVIATION_NOT_REPORTABLE",
  /** `lift_deviation`, `trace resolve`: no deviation has this id. `{ deviation }`. */
  DEVIATION_NOT_FOUND: "DEVIATION_NOT_FOUND",
  /** The deviation is already resolved. `details: { deviation, status }`. */
  DEVIATION_NOT_OPEN: "DEVIATION_NOT_OPEN",
  /**
   * `lift_deviation`: only the agent that reported a deviation lifts it, never the
   * story's developer (the creator at the terminal otherwise). `details: { deviation, agent,
   * reported_by }`.
   */
  DEVIATION_NOT_ALLOWED: "DEVIATION_NOT_ALLOWED",
  /**
   * The resolution was written but the journal does not apply it (a clock behind the report's):
   * the deviation stays open. `details: { deviation, event }`.
   */
  DEVIATION_RESOLUTION_IGNORED: "DEVIATION_RESOLUTION_IGNORED",
  /**
   * `answer_checkpoint`: the quote is not a whole message the creator typed or
   * dictated in this session, after the checkpoint opened, and not cited yet. Nothing was
   * written; the checkpoint stays open. `details: { checkpoint, reason }`, `reason` being
   * `no_message`, `before_opening` or `already_cited`.
   */
  CHAT_QUOTE_NOT_FOUND: "CHAT_QUOTE_NOT_FOUND",
  /**
   * `answer_checkpoint` from a tool whose hook records the creator's messages, without the
   * tool's session id (`session`): the quote cannot be checked. `details: { checkpoint }`.
   */
  CHAT_SESSION_REQUIRED: "CHAT_SESSION_REQUIRED",
  /**
   * `answer_checkpoint` on a checkpoint that only the terminal answers: a high risk at the
   * `strict` level (never at the `chat` or `auto` level).
   * `details: { checkpoint, reason, command }`.
   */
  REVIEW_REQUIRED: "REVIEW_REQUIRED",
  /**
   * `reopen` (chat or terminal) on a checkpoint the engine did not apply on its own.
   * `details: { checkpoint, status }`.
   */
  CHECKPOINT_NOT_REOPENABLE: "CHECKPOINT_NOT_REOPENABLE",
  /**
   * `migrate`: an agent or a skill of the creator's has the identifier of an agent
   * the new format ships. Nothing was written. `details: { id, path }`: rename it, then run
   * `migrate` again.
   */
  AGENT_ID_CONFLICT: "AGENT_ID_CONFLICT",
  /**
   * `request_creator_action`: the action is not one the creator decides through a
   * request: an unknown kind, or an item of deferred work its owner closes.
   * `details: { kind, reason, kinds? }`, `reason` being `unknown_kind` or `not_creator_owned`.
   * Nothing was written.
   */
  CREATOR_ACTION_NOT_RESERVED: "CREATOR_ACTION_NOT_RESERVED",
  /**
   * `request_creator_action`: the action would change nothing (the profile, level,
   * settings or activation already so). `details: { kind }`. Nothing was written.
   */
  CREATOR_ACTION_UNCHANGED: "CREATOR_ACTION_UNCHANGED",
  /**
   * An approval of a creator's action whose target moved since the request: the
   * story's branch has another head (`head_moved`). `details: { checkpoint, kind, reason }`.
   * Nothing was written; the request stays open (it can still be refused).
   */
  CREATOR_ACTION_STALE: "CREATOR_ACTION_STALE",
  /**
   * An approved creator's action recorded in the journal whose files could not be
   * written afterwards. `details: { checkpoint, kind, command, reason }`: run `command` at the
   * terminal.
   */
  CREATOR_ACTION_FAILED: "CREATOR_ACTION_FAILED",
  /**
   * An agent's call outside its role. Noah, the main session's assistant, calls only
   * the tools of his contract (reading the state, `report_status`, `answer_checkpoint`,
   * `delegate`…), and only Noah hands work over with `delegate`. Nothing was written.
   * `details: { agent, command }`.
   */
  ROLE_FORBIDDEN: "ROLE_FORBIDDEN",
  /**
   * `delegate`: the handover cannot go to this agent or skill. Nothing was written.
   * `details: { to, reason, story? }` (`DELEGATION_INVALID_REASONS`).
   */
  DELEGATION_INVALID: "DELEGATION_INVALID",
  /**
   * A review cannot start, be given, sorted, read or posted (`start_review`,
   * `submit_review`, `triage_review`, `get_review`, `publish_review`). Nothing was written.
   * `details: { story, reason, … }` (`REVIEW_NOT_POSSIBLE_REASONS`).
   */
  REVIEW_NOT_POSSIBLE: "REVIEW_NOT_POSSIBLE",
  /**
   * The engine could not merge an approved story (`MERGE_FAILURES`). Nothing was
   * written and the merge checkpoint stays open, except `not_recorded` (merged at the forge, but
   * the write was refused: answer again, the merge is then recorded).
   * `details: { story, checkpoint, reason, message?, url? }`.
   */
  MERGE_FAILED: "MERGE_FAILED",
  /**
   * The fast track cannot be entered or left (`FAST_TRACK_REFUSALS`). Nothing was
   * written. `details: { story, reason }`.
   */
  FAST_TRACK_NOT_POSSIBLE: "FAST_TRACK_NOT_POSSIBLE",
  /**
   * A conflict with the main branch cannot be qualified (`qualify_merge_conflict`,
   * `MERGE_CONFLICT_REASONS`). Nothing was written. `details: { story, reason, files? }`.
   */
  MERGE_CONFLICT: "MERGE_CONFLICT",
  /**
   * `docs check`: the positioning or a page of the launch is not in its contract: a
   * section, the header, the search fields of a page or one of its keywords.
   * `details: { path, line, field, reason, ... }` (`LAUNCH_DOCUMENT_REASONS`), with `section` for
   * a section, `keyword` and `index` for a keyword. It extends to the contents and the
   * campaign plans (`content_*` reasons: `field`, `section`, `heading`, `index`). It also covers the
   * UX specification and its mock-up pages (`UX_DOCUMENT_REASONS`).
   */
  LAUNCH_DOCUMENT_INVALID: "LAUNCH_DOCUMENT_INVALID",
  /**
   * `open_checkpoint`: the end of a phase cites a document that is not committed on
   * the branch it names (a blob made with `git hash-object -w` on an untracked file, or a commit
   * on another branch). Nothing was written. `details: { phase, documents, count }`.
   */
  DOCUMENT_NOT_COMMITTED: "DOCUMENT_NOT_COMMITTED",
  /**
   * `open_stack`: a checkpoint, or the list, cannot form a stack to validate (fewer
   * than 2 or more than 8 points, a point at a high risk or irreversible, one that is not open,
   * an action of the creator's…). Nothing was written. `details: { reason, checkpoint? }`
   * (`STACK_INVALID_REASONS`).
   */
  STACK_INVALID: "STACK_INVALID",
  /** `ask_stack` or `answer_stack`: no such stack. `details: { stack }`. */
  STACK_NOT_FOUND: "STACK_NOT_FOUND",
  /**
   * `ask_stack` or `answer_stack`: every point of the stack is answered already.
   * `details: { stack }`.
   */
  STACK_CLOSED: "STACK_CLOSED",
  /**
   * `answer_stack`, or `answer_checkpoint` on the point of a stack: the creator's
   * message is not an approval of numbers of the stack that the engine can read. Nothing was
   * written; the points stay open. `details: { stack, reason }` (`STACK_REPLY_REASONS`).
   */
  STACK_REPLY_UNCLEAR: "STACK_REPLY_UNCLEAR",
  /**
   * An approved gesture of the forge the engine cannot carry out: the repository, the
   * forge's tool or the remote does not allow it. Nothing was done; at the request or the approval
   * nothing was written. `details: { kind, reason, message? }`, `reason` being `no_repository`,
   * `not_repository_root`, `cli_missing`, `not_logged_in`, `remote_exists`, `no_remote`,
   * `name_taken`, `unknown_forge`, `no_main_branch`, `remote_ahead`, `remote_diverged`,
   * `remote_unreadable`, `branch_not_pushed`, `main_not_pushed`, `not_ci_change`,
   * `diff_unreadable`, `pull_request_closed`, `head_moved`, `not_mergeable`, `forge_failed`,
   * `not_available`.
   */
  FORGE_GESTURE_FAILED: "FORGE_GESTURE_FAILED",
  /**
   * `docs check`: a research report (a page with a `research` block) is not in its
   * contract: its header, a section, a claim without its source or at the wrong level, a source
   * not read as untrusted, or an instruction that is not flagged.
   * `details: { path, line, reason, ... }` (`RESEARCH_REPORT_REASONS`).
   */
  RESEARCH_REPORT_INVALID: "RESEARCH_REPORT_INVALID",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Every error crossing a boundary: `{ code, message_key, details }`. */
export const ErrorPayloadSchema = z.strictObject({
  code: z.string().regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/),
  message_key: z.string().min(1),
  details: z.record(z.string(), z.unknown()),
});

export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;
