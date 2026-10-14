import { CREATOR_OWNER, ErrorCode, REQUIREMENT_ID_PATTERN } from "@agentplugged/protocol";
import { reasonDetails } from "../errors.js";
import { METHOD_DIR } from "../init/layout.js";
import type { CheckpointState } from "../projection/checkpoint-reducers.js";
import { specScopeProblems } from "../spec/spec-checks.js";
import { decisionFieldProblems } from "./architecture-decisions.js";
import { brandDocumentChecks, identityTokensOf } from "./brand-documents.js";
import type { DocsProblem, DocsWarning, DocumentFile } from "./docs-base.js";
import { forgeDocumentChecks } from "./forge-documents.js";
import { ideationDocumentChecks } from "./ideation-documents.js";
import {
  knowledgeCodeProblems,
  knowledgePagesOf,
  knowledgeSourceProblems,
  type MergedStoryRef,
  staleKnowledgeSources,
  staleKnowledgeStories,
  staleKnowledgeWarnings,
  staleStoryWarnings,
} from "./knowledge-freshness.js";
import { launchDocumentChecks } from "./launch-documents.js";
import {
  comparableText,
  type Definition,
  type ParsedDocument,
  parseDocumentFile,
} from "./parse-document.js";
import { pitchDocumentChecks } from "./pitch-documents.js";
import { prfaqDocumentChecks } from "./prfaq-documents.js";
import { researchReportChecks } from "./research-documents.js";
import { salesDocumentChecks } from "./sales-documents.js";
import { type ApprovedStory, breakdownProblems } from "./story-rules.js";
import { strategyDocumentChecks } from "./strategy-documents.js";
import { uxDocumentChecks } from "./ux-documents.js";

export type { DocsProblem, DocsWarning } from "./docs-base.js";

export interface CheckDocumentsInput {
  /** The documents of the working copy. */
  readonly current: readonly DocumentFile[];
  /** The documents of the base, or undefined without a base (rules 1 to 3 only). */
  readonly base?: readonly DocumentFile[] | undefined;
  /** How the base is named in messages (`HEAD`, `main`…). */
  readonly baseRef?: string;
  /** Agents a document may name as `owner` (`creator` is always allowed). */
  readonly owners: ReadonlySet<string>;
  /**
   * The stories approved in `document` checkpoints, read from their blobs, in the order of the
   * answers (rule 10). None when absent.
   */
  readonly approvals?: readonly ApprovedStory[];
  /**
   * The approved blobs this branch's history held: a frozen story gone from the working copy is
   * `removed` only when its blob is here. Undefined when the history could not be read.
   */
  readonly onBranch?: ReadonlySet<string>;
  /**
   * The pages of `ux-mockups/` by path. Without them, the pages are not checked and a
   * link to one is not followed.
   */
  readonly mockups?: ReadonlyMap<string, string>;
  /**
   * The identity page and the style files of the code the identity binds, by path.
   * Without them, the page and the files are not checked.
   */
  readonly brandFiles?: ReadonlyMap<string, string>;
  /**
   * The checkpoints of the projection, and the clock (milliseconds) that reads their status
   *: a page of the knowledge base behind a validated document is a warning. Without
   * them, freshness is not checked.
   */
  readonly validations?: {
    readonly checkpoints: readonly CheckpointState[];
    readonly now: number;
    /** The merged stories: a page behind one that changed its code is a warning. */
    readonly merges?: readonly MergedStoryRef[];
  };
}

/** What `checkDocumentsDetailed` found: the problems, sorted, and what rule 10 adds. */
export interface DocumentsCheck {
  readonly problems: DocsProblem[];
  readonly warnings: DocsWarning[];
  /** The frozen intents actually compared with the working copy. */
  readonly compared: number;
}

/** The kind a folder requires of its documents. */
const FOLDER_KINDS: ReadonlyArray<{ readonly folder: string; readonly kind: string }> = [
  { folder: `${METHOD_DIR}/epics/`, kind: "epic" },
  { folder: `${METHOD_DIR}/stories/`, kind: "story" },
];

function problem(
  code: ErrorCode,
  messageKey: string,
  path: string,
  line: number,
  details: Record<string, unknown> = {},
): DocsProblem {
  return { code, message_key: messageKey, details: { path, line, ...details } };
}

/** Definitions grouped by identifier, each group in file then line order. */
function byId(documents: readonly ParsedDocument[]): Map<string, Definition[]> {
  const groups = new Map<string, Definition[]>();
  for (const document of documents) {
    for (const definition of document.definitions) {
      const group = groups.get(definition.id);
      if (group) group.push(definition);
      else groups.set(definition.id, [definition]);
    }
  }
  return groups;
}

function parseAll(files: readonly DocumentFile[]): ParsedDocument[] {
  return [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => parseDocumentFile(file.path, file.text));
}

/**
 * Rule 1: every header is valid, its owner exists, its kind fits its folder, its links lead to a
 * document or an active requirement; no code fence is left open.
 */
function headerProblems(
  documents: readonly ParsedDocument[],
  current: ReadonlyMap<string, readonly Definition[]>,
  owners: ReadonlySet<string>,
) {
  const problems: DocsProblem[] = [];
  const documentIds = new Set(documents.flatMap((document) => document.id ?? []));
  for (const document of documents) {
    const { path } = document;
    for (const issue of document.issues) {
      problems.push(
        problem(ErrorCode.DOC_HEADER_INVALID, "error.doc_header_invalid", path, issue.line, {
          field: issue.field,
          ...issue.details,
        }),
      );
    }
    const owner = document.owner;
    if (owner !== undefined && owner.value !== CREATOR_OWNER && !owners.has(owner.value)) {
      problems.push(
        problem(ErrorCode.DOC_HEADER_INVALID, "error.doc_header_invalid", path, owner.line, {
          field: "owner",
          ...reasonDetails(`names no agent: ${owner.value}`, "reason.doc_owner", {
            owner: owner.value,
          }),
        }),
      );
    }
    const expected = FOLDER_KINDS.find((entry) => path.startsWith(entry.folder));
    const kind = document.kind;
    if (expected !== undefined && kind !== undefined && kind.value !== expected.kind) {
      problems.push(
        problem(ErrorCode.DOC_KIND_MISMATCH, "error.doc_kind_mismatch", path, kind.line, {
          kind: kind.value,
          expected: expected.kind,
          folder: expected.folder,
        }),
      );
    }
    for (const link of document.links) {
      const requirement = REQUIREMENT_ID_PATTERN.test(link.value);
      const found = requirement
        ? (current.get(link.value) ?? []).some((definition) => !definition.retired)
        : documentIds.has(link.value);
      if (found) continue;
      const key = requirement
        ? "error.doc_link_dangling.requirement"
        : "error.doc_link_dangling.document";
      problems.push(
        problem(ErrorCode.DOC_LINK_DANGLING, key, path, link.line, { link: link.value }),
      );
    }
    if (document.unclosedFence !== undefined) {
      problems.push(
        problem(
          ErrorCode.DOC_UNCLOSED_FENCE,
          "error.doc_unclosed_fence",
          path,
          document.unclosedFence,
        ),
      );
    }
  }
  return problems;
}

/** Rule 2: a document id is used once. */
function documentIdProblems(documents: readonly ParsedDocument[]) {
  const problems: DocsProblem[] = [];
  const first = new Map<string, string>();
  for (const document of documents) {
    if (document.id === undefined) continue;
    const owner = first.get(document.id);
    if (owner === undefined) {
      first.set(document.id, document.path);
      continue;
    }
    problems.push(
      problem(
        ErrorCode.DOC_ID_DUPLICATE,
        "error.doc_id_duplicate",
        document.path,
        document.idLine,
        {
          id: document.id,
          first: owner,
        },
      ),
    );
  }
  return problems;
}

/** Rule 3: a requirement identifier is defined once in the working copy. */
function definitionProblems(current: ReadonlyMap<string, readonly Definition[]>) {
  const problems: DocsProblem[] = [];
  for (const [id, group] of current) {
    const [first, ...others] = group;
    if (first === undefined) continue;
    for (const other of others) {
      problems.push(
        problem(ErrorCode.REQ_ID_DUPLICATE, "error.req_id_duplicate", other.path, other.line, {
          id,
          first: first.path,
          first_line: first.line,
        }),
      );
    }
  }
  return problems;
}

/** Definitions of comparable text, by that text (`comparableText`, empty texts left out). */
function byText(groups: ReadonlyMap<string, readonly Definition[]>): Map<string, Definition[]> {
  const texts = new Map<string, Definition[]>();
  for (const group of groups.values()) {
    for (const definition of group) {
      const text = comparableText(definition.text);
      if (text === "") continue;
      const list = texts.get(text);
      if (list) list.push(definition);
      else texts.set(text, [definition]);
    }
  }
  return texts;
}

/** Rules 4 to 6: nothing defined in the base is removed, reused or renumbered. */
function baseProblems(
  current: ReadonlyMap<string, readonly Definition[]>,
  base: ReadonlyMap<string, readonly Definition[]>,
  baseRef: string,
) {
  const problems: DocsProblem[] = [];
  for (const [id, group] of base) {
    const [first] = group;
    if (first === undefined) continue;
    const now = current.get(id) ?? [];
    // Rule 4: the identifier must stay, marked retired when it is no longer wanted.
    if (now.length === 0) {
      problems.push(
        problem(ErrorCode.REQ_ID_REMOVED, "error.req_id_removed", first.path, first.line, {
          id,
          base: baseRef,
        }),
      );
      continue;
    }
    // Rule 5: an identifier retired in the base never comes back.
    const active = now.find((definition) => !definition.retired);
    if (group.every((definition) => definition.retired) && active !== undefined) {
      problems.push(
        problem(ErrorCode.REQ_ID_REUSED, "error.req_id_reused", active.path, active.line, {
          id,
          base: baseRef,
          base_path: first.path,
          base_line: first.line,
        }),
      );
    }
  }
  // Rule 6: the text of an active base definition, now under another identifier. Each side is
  // indexed by text once.
  const baseTexts = byText(base);
  const currentTexts = byText(current);
  const reported = new Set<string>();
  for (const [text, olds] of baseTexts) {
    const moved = (currentTexts.get(text) ?? []).filter((definition) => !definition.retired);
    if (moved.length === 0) continue;
    const baseIds = new Set(olds.map((definition) => definition.id));
    const currentIds = new Set((currentTexts.get(text) ?? []).map((definition) => definition.id));
    for (const old of olds) {
      if (old.retired) continue;
      const from = old.id;
      // Copied, not moved: the text is still under its own identifier. Retired now: the
      // identifier was dropped properly, and its text may live on under a new one.
      if (currentIds.has(from)) continue;
      if ((current.get(from) ?? []).some((definition) => definition.retired)) continue;
      for (const definition of moved) {
        const to = definition.id;
        // The other identifier already held this text in the base.
        if (to === from || baseIds.has(to) || reported.has(`${from} ${to}`)) continue;
        reported.add(`${from} ${to}`);
        problems.push(
          problem(
            ErrorCode.REQ_ID_RENUMBERED,
            "error.req_id_renumbered",
            definition.path,
            definition.line,
            { from, to, base: baseRef, base_path: old.path, base_line: old.line },
          ),
        );
      }
    }
  }
  return problems;
}

/**
 * The rules of `docs check`, as a pure function: headers (1), document ids (2), definitions in
 * the working copy (3), then, with a base, removed (4), reused (5) and renumbered (6)
 * identifiers; the three fields of every active architecture decision; and the
 * breakdown: links and sections of stories and epics (7), coverage of the PRD (8),
 * dependency graph (9) and frozen intents (10); the `sources` of the pages of the knowledge base,
 * and, with `validations`, the pages behind a validated document, as warnings.
 * Problems come sorted by file, line and code.
 */
export function checkDocuments(input: CheckDocumentsInput): DocsProblem[] {
  return checkDocumentsDetailed(input).problems;
}

/** `checkDocuments`, with the warnings of rule 10 and the number of intents compared. */
export function checkDocumentsDetailed(input: CheckDocumentsInput): DocumentsCheck {
  const documents = parseAll(input.current);
  const current = byId(documents);
  const breakdown = breakdownProblems(
    documents,
    current,
    input.owners,
    input.approvals ?? [],
    input.onBranch,
  );
  const problems = [
    ...headerProblems(documents, current, input.owners),
    ...documentIdProblems(documents),
    ...definitionProblems(current),
    // Every active architecture decision states binds, prevents and rule.
    ...decisionFieldProblems(input.current, documents),
    // The scope of a short-path spec.
    ...specScopeProblems(documents),
    ...breakdown.problems,
    // The `sources` of a page of the knowledge base.
    ...knowledgeSourceProblems(documents),
    // Its `code` and `last_story`.
    ...knowledgeCodeProblems(documents),
  ];
  const validations = input.validations;
  const texts = new Map(input.current.map((file) => [file.path, file.text]));
  // The positioning and the pages of the launch.
  const launch = launchDocumentChecks({
    documents,
    textOf: (path) => texts.get(path),
    ...(validations === undefined
      ? {}
      : { validations: { checkpoints: validations.checkpoints, now: validations.now } }),
  });
  problems.push(...launch.problems);
  // The offer pages and the email sequences of the sales.
  const sales = salesDocumentChecks({
    documents,
    textOf: (path) => texts.get(path),
    ...(validations === undefined
      ? {}
      : { validations: { checkpoints: validations.checkpoints, now: validations.now } }),
  });
  problems.push(...sales.problems);
  // The narrative, the deck and the design thinking syntheses.
  const pitch = pitchDocumentChecks({
    documents,
    textOf: (path) => texts.get(path),
    ...(validations === undefined
      ? {}
      : { validations: { checkpoints: validations.checkpoints, now: validations.now } }),
  });
  problems.push(...pitch.problems);
  // The problem analyses and the innovation strategies.
  const strategy = strategyDocumentChecks({
    documents,
    textOf: (path) => texts.get(path),
  });
  problems.push(...strategy.problems);
  // The sessions of ideas.
  const ideation = ideationDocumentChecks({ documents, textOf: (path) => texts.get(path) });
  problems.push(...ideation.problems);
  // The files of the forge and the press release once a verdict closes it.
  const forge = forgeDocumentChecks({ documents, textOf: (path) => texts.get(path) });
  problems.push(...forge.problems);
  const release = prfaqDocumentChecks({ documents, textOf: (path) => texts.get(path) });
  problems.push(...release.problems);
  // The tokens, the elements, the key screens and the mock-up pages of the UX.
  const ux = uxDocumentChecks({
    documents,
    textOf: (path) => texts.get(path),
    mockups: input.mockups,
    brandTokens: identityTokensOf(documents),
  });
  problems.push(...ux.problems);
  // The platform of the brand, the identity and its fixed rules.
  const brand = brandDocumentChecks({
    documents,
    textOf: (path) => texts.get(path),
    files: input.brandFiles,
    mockups: input.mockups,
    ...(validations === undefined
      ? {}
      : { validations: { checkpoints: validations.checkpoints, now: validations.now } }),
  });
  problems.push(...brand.problems);
  // The research reports.
  const research = researchReportChecks({
    documents,
    textOf: (path) => texts.get(path),
    now: validations?.now ?? Date.now(),
  });
  problems.push(...research.problems);
  const pages =
    validations === undefined ? [] : knowledgePagesOf(documents, (path) => texts.get(path));
  const freshness =
    validations === undefined
      ? []
      : [
          ...staleKnowledgeWarnings(
            staleKnowledgeSources(pages, validations.checkpoints, validations.now),
          ),
          ...staleStoryWarnings(staleKnowledgeStories(pages, validations.merges ?? [])),
        ];
  if (input.base !== undefined) {
    problems.push(...baseProblems(current, byId(parseAll(input.base)), input.baseRef ?? "HEAD"));
  }
  return {
    problems: sortProblems(problems),
    warnings: [
      ...breakdown.warnings,
      ...freshness,
      ...launch.warnings,
      ...sales.warnings,
      ...pitch.warnings,
      ...strategy.warnings,
      ...research.warnings,
      ...ux.warnings,
      ...brand.warnings,
    ],
    compared: breakdown.compared,
  };
}

function sortProblems(problems: DocsProblem[]): DocsProblem[] {
  return problems.sort(
    (a, b) =>
      (a.details.path < b.details.path ? -1 : a.details.path > b.details.path ? 1 : 0) ||
      a.details.line - b.details.line ||
      (a.code < b.code ? -1 : a.code > b.code ? 1 : 0),
  );
}
