import { utf8 } from "@agentplugged/crypto";
import {
  BRAND_DOCUMENT_ID,
  BRAND_NOT_MIN,
  BRAND_PROMISE_MAX,
  BRAND_SECTIONS,
  BRAND_STYLE_FILES_MAX,
  BRAND_TO_VERIFY,
  BRAND_VOICE_COLUMNS,
  BRAND_VOICE_MIN,
  IDENTITY_DOCUMENT_ID,
  IDENTITY_PAGE_MAX_BYTES,
  IDENTITY_SCREENS,
  IDENTITY_SECTIONS,
  IDENTITY_VARIANTS,
  STYLE_FILE_MAX_BYTES,
  UX_MOCKUP_DIR,
} from "@agentplugged/protocol";
import { documentOwner } from "../agents/agent-aliases.js";
import { splitFrontmatter } from "../init/generated.js";
import { METHOD_DIR } from "../init/layout.js";
import {
  type BrandSource,
  checkBrandRules,
  flattenTokens,
  readRules,
  weakPairs,
} from "./brand-rules.js";
import type { DocsProblem, DocsWarning } from "./docs-base.js";
import { pathKey } from "./knowledge-freshness.js";
import {
  deliverableStatus,
  invalid,
  type LaunchCheck,
  type LaunchCheckInput,
  languageProblem,
  placeholderProblems,
  visibleText,
} from "./launch-documents.js";
import { type ParsedDocument, type Section, tableCells } from "./parse-document.js";
import { sectionState } from "./sales-documents.js";
import { warning } from "./story-rules.js";
import { readTokens } from "./ux-documents.js";
import { mockupFaults } from "./ux-mockup.js";

/**
 * The brand, as pure functions: the platform of the brand (Julien) and the visual
 * identity (Stella) are notes of the launch folder, validated by a checkpoint like the positioning.
 * `docs check` verifies what a program can: the header and the sections, the shape of the voice and
 * of the promise, that every colour has a written role, that the fixed rules are declared in a form
 * that can be verified, and then applies them to the identity page, to the mock-up pages and to the
 * style files of the code. What a program cannot judge (is it the right name, the right voice) stays
 * the creator's; a rule it cannot verify is listed as such.
 */

export const BRAND_PATH = `${METHOD_DIR}/docs/launch/brand.md`;
export const IDENTITY_PATH = `${METHOD_DIR}/docs/launch/identity.md`;
export const IDENTITY_PAGE_PATH = `${METHOD_DIR}/docs/launch/identity.html`;

/** The pages whose words are read against the voice of the brand. */
const PUBLISHED_DIRS = [
  `${METHOD_DIR}/docs/launch/pages/`,
  `${METHOD_DIR}/docs/launch/content/`,
  `${METHOD_DIR}/docs/launch/campaigns/`,
];

const VALIDATING = ["publication", "document"] as const;
const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(\S.*)$/;

export interface BrandCheckInput extends LaunchCheckInput {
  /**
   * The identity page and the style files of the code, by path, as read for the check. Absent when
   * the caller did not read them: the page and the files are then not checked.
   */
  readonly files?: ReadonlyMap<string, string> | undefined;
  /** The mock-up pages of the UX, by path. */
  readonly mockups?: ReadonlyMap<string, string> | undefined;
}

/** The tokens of the identity by path, for the UX specification that uses them by name. */
export function identityTokensOf(
  documents: readonly ParsedDocument[],
): ReadonlyMap<string, string> | undefined {
  const identity = documents.find((document) => pathKey(document.path) === IDENTITY_PATH);
  return identity?.tokens === undefined ? undefined : flattenTokens(identity.tokens.value);
}

function headerProblems(document: ParsedDocument, id: string, agent: string): DocsProblem[] {
  const { path } = document;
  const problems: DocsProblem[] = [];
  const bad = (line: number, field: string, extra: Record<string, unknown> = {}) =>
    problems.push(invalid(path, line, "brand_header", { field, ...extra }));
  if (document.id !== id) bad(document.idLine, "id", { expected: id });
  if (document.kind !== undefined && document.kind.value !== "note") {
    bad(document.kind.line, "kind", { expected: "note" });
  }
  if (
    document.owner !== undefined &&
    !new Set([agent, "creator"]).has(documentOwner(document.owner.value))
  ) {
    bad(document.owner.line, "owner", { expected: agent, owner: document.owner.value });
  }
  if (document.links.length === 0) bad(1, "links");
  problems.push(...languageProblem(document), ...placeholderProblems(document));
  return problems;
}

function sectionProblems(
  document: ParsedDocument,
  titles: Readonly<Record<string, readonly string[]>>,
): { problems: DocsProblem[]; found: Map<string, Section> } {
  const problems: DocsProblem[] = [];
  const found = new Map<string, Section>();
  for (const [key, accepted] of Object.entries(titles)) {
    const { section, problem } = sectionState(document.sections, accepted);
    if (problem !== undefined) {
      problems.push(
        invalid(document.path, section?.line ?? 1, "brand_section", {
          section: key,
          problem,
          heading: `## ${accepted[0]?.replace(/^./, (letter) => letter.toUpperCase())}`,
        }),
      );
    } else if (section !== undefined) found.set(key, section);
  }
  return { problems, found };
}

const bulletsOf = (section: Section) =>
  section.lines.flatMap((text, index) => {
    const bullet = BULLET.exec(text);
    return bullet === null ? [] : [{ line: section.line + 1 + index, text: bullet[1] ?? "" }];
  });

const SEPARATOR_ROW = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/** A table of a section: its header cells and its data rows (with their lines). */
function tableOf(section: Section): {
  header: string[];
  rows: Array<{ line: number; cells: string[] }>;
} {
  const header: string[] = [];
  const rows: Array<{ line: number; cells: string[] }> = [];
  let fenced = false;
  section.lines.forEach((text, index) => {
    if (/^\s*```/.test(text)) fenced = !fenced;
    if (fenced || !/^\s*\|/.test(text) || SEPARATOR_ROW.test(text)) return;
    const next = section.lines[index + 1] ?? "";
    if (header.length === 0 && SEPARATOR_ROW.test(next)) header.push(...tableCells(text));
    else if (header.length > 0 || !SEPARATOR_ROW.test(next)) {
      rows.push({ line: section.line + 1 + index, cells: tableCells(text) });
    }
  });
  return { header, rows };
}

const plainCell = (cell: string) =>
  cell
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`_]/g, "")
    .trim();
const filled = (cell: string | undefined) =>
  plainCell(cell ?? "") !== "" && !/^<[^>]*>$/.test(plainCell(cell ?? ""));

/** The phrases the voice says to avoid, as written in the second column of its table. */
export function avoidPhrases(document: ParsedDocument): string[] {
  const voice = sectionState(document.sections, BRAND_SECTIONS.voice).section;
  if (voice === undefined) return [];
  const { header, rows } = tableOf(voice);
  if (!BRAND_VOICE_COLUMNS.avoid.test(plainCell(header[1] ?? ""))) return [];
  return rows
    .map((row) =>
      plainCell(row.cells[1] ?? "")
        .replace(/^[«"“'`]+|[»"”'`.!…]+$/g, "")
        .trim(),
    )
    .filter((phrase) => phrase.length >= 3);
}

// ---------------------------------------------------------------------------------------------
// The platform
// ---------------------------------------------------------------------------------------------

function platformProblems(document: ParsedDocument): DocsProblem[] {
  const { path } = document;
  const problems = headerProblems(document, BRAND_DOCUMENT_ID, "julien");
  const { problems: missing, found } = sectionProblems(document, BRAND_SECTIONS);
  problems.push(...missing);
  const promise = found.get("promise");
  if (promise !== undefined) {
    const lines = visibleText(promise.lines).split("\n");
    const text = (lines[0] ?? "").replace(/^[>*\s]+|[*\s]+$/g, "");
    const inner = /[.!?…]\s+\p{L}/u.test(text);
    if (lines.length !== 1 || text.length > BRAND_PROMISE_MAX || inner) {
      problems.push(
        invalid(path, promise.line, "brand_promise", {
          problem: lines.length !== 1 ? "lines" : inner ? "sentences" : "long",
          max: BRAND_PROMISE_MAX,
        }),
      );
    }
  }
  const not = found.get("not");
  if (not !== undefined && bulletsOf(not).length < BRAND_NOT_MIN) {
    problems.push(
      invalid(path, not.line, "brand_section", {
        section: "not",
        problem: "few",
        min: BRAND_NOT_MIN,
      }),
    );
  }
  const voice = found.get("voice");
  if (voice !== undefined) {
    const { header, rows } = tableOf(voice);
    const columns =
      BRAND_VOICE_COLUMNS.say.test(plainCell(header[0] ?? "")) &&
      BRAND_VOICE_COLUMNS.avoid.test(plainCell(header[1] ?? ""));
    const examples = rows.filter((row) => filled(row.cells[0]) && filled(row.cells[1]));
    const rules = bulletsOf(voice).length;
    const problem = !columns
      ? "columns"
      : examples.length < BRAND_VOICE_MIN.examples || examples.length < rows.length
        ? "examples"
        : rules < BRAND_VOICE_MIN.rules
          ? "rules"
          : undefined;
    if (problem !== undefined) {
      problems.push(
        invalid(path, voice.line, "brand_voice", {
          problem,
          rules: BRAND_VOICE_MIN.rules,
          examples: BRAND_VOICE_MIN.examples,
        }),
      );
    }
  }
  const name = found.get("name");
  if (name !== undefined && !BRAND_TO_VERIFY.test(visibleText(name.lines))) {
    problems.push(invalid(path, name.line, "brand_availability", {}));
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The identity
// ---------------------------------------------------------------------------------------------

/** A path of the code the rules also bind: a relative `.css` file, with no way out of the project. */
export const STYLE_PATH = /^(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))[\w@.+/-]+\.css$/;

function paletteProblems(
  document: ParsedDocument,
  section: Section,
  tokens: ReadonlyMap<string, string>,
): DocsProblem[] {
  const problems: DocsProblem[] = [];
  const { rows } = tableOf(section);
  const written = new Map<string, string>();
  for (const row of rows) {
    const name = plainCell(row.cells[0] ?? "");
    if (!/^color\.[\w.-]+$/.test(name)) continue;
    written.set(name, plainCell(row.cells[1] ?? ""));
    if (!tokens.has(name)) {
      problems.push(
        invalid(document.path, row.line, "identity_palette", { token: name, problem: "unknown" }),
      );
    }
  }
  for (const token of [...tokens.keys()].filter((path) => path.startsWith("color."))) {
    const role = written.get(token);
    if (
      role === undefined ||
      role.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length < 2
    ) {
      problems.push(
        invalid(document.path, section.line, "identity_palette", {
          token,
          problem: role === undefined ? "missing" : "role",
        }),
      );
    }
  }
  return problems;
}

function identityProblems(
  document: ParsedDocument,
  input: BrandCheckInput,
): { problems: DocsProblem[]; warnings: DocsWarning[] } {
  const { path } = document;
  const warnings: DocsWarning[] = [];
  const problems = headerProblems(document, IDENTITY_DOCUMENT_ID, "stella");
  const { problems: missing, found } = sectionProblems(document, IDENTITY_SECTIONS);
  problems.push(...missing);

  // The symbol: shown on a light ground, on a dark ground and as an app icon.
  const symbol = found.get("symbol");
  if (symbol !== undefined) {
    const text = symbol.lines.join("\n").replace(/<!--[\s\S]*?-->/g, "");
    const absent = Object.entries(IDENTITY_VARIANTS)
      .filter(([, pattern]) => !pattern.test(text))
      .map(([name]) => name);
    if (absent.length > 0) {
      problems.push(
        invalid(path, symbol.line, "brand_section", {
          section: "symbol",
          problem: "variants",
          detail: absent.join(", "),
        }),
      );
    }
  }
  const screens = found.get("screens");
  if (screens !== undefined) {
    const count = screens.lines.filter((text) => /^###\s+\S/.test(text)).length;
    if (count !== IDENTITY_SCREENS) {
      problems.push(
        invalid(path, screens.line, "brand_section", {
          section: "screens",
          problem: "count",
          found: count,
          min: IDENTITY_SCREENS,
        }),
      );
    }
  }

  // The tokens, in the format of the UX specification.
  const block = document.tokens;
  const tokens = block === undefined ? new Map<string, string>() : flattenTokens(block.value);
  if (block === undefined) {
    problems.push(invalid(path, 1, "brand_header", { field: "tokens" }));
  } else {
    const read = readTokens(block.value);
    for (const found of read.problems.slice(0, 3)) {
      problems.push(
        invalid(path, block.line, "ux_tokens", { field: "tokens", detail: found.detail }),
      );
    }
    const defined = new Set(tokens.keys());
    for (const alias of read.aliases) {
      if (!defined.has(alias) && ![...defined].some((token) => token.startsWith(`${alias}.`))) {
        problems.push(invalid(path, block.line, "ux_token_undefined", { token: alias }));
      }
    }
  }
  const palette = found.get("palette");
  if (palette !== undefined && block !== undefined)
    problems.push(...paletteProblems(document, palette, tokens));

  // The fixed rules.
  const rulesBlock = document.brand_rules;
  const { rules, problems: ruleProblems } =
    rulesBlock === undefined
      ? { rules: [], problems: [{ rule: "brand_rules", detail: "missing" }] }
      : readRules(rulesBlock.value, tokens);
  for (const item of ruleProblems.slice(0, 5)) {
    problems.push(
      invalid(path, rulesBlock?.line ?? 1, "identity_rules", {
        rule: item.rule,
        detail: item.detail,
      }),
    );
  }
  const rulesSection = found.get("rules");
  if (rulesSection !== undefined) {
    const text = visibleText(rulesSection.lines);
    for (const rule of rules) {
      if (!new RegExp(`(?<![\\w-])${rule.id}(?![\\w-])`).test(text)) {
        problems.push(
          invalid(path, rulesSection.line, "identity_rules", {
            rule: rule.id,
            detail: "not written in the section of the rules",
          }),
        );
      }
    }
  }
  for (const rule of rules.filter((item) => item.kind === "contrast")) {
    for (const pair of weakPairs(rule, tokens)) {
      problems.push(
        invalid(path, rulesBlock?.line ?? 1, "brand_rule", {
          rule: rule.id,
          detail: `text ${pair.text} on ${pair.background}: contrast ${pair.ratio.toFixed(2)}:1, minimum ${pair.min}:1`,
        }),
      );
    }
  }

  // The style files of the code, and the pages.
  const listed = document.style_files?.value;
  const styles = Array.isArray(listed) ? listed : listed === undefined ? [] : [listed];
  const stylePaths: string[] = [];
  styles.forEach((entry) => {
    if (
      typeof entry !== "string" ||
      !STYLE_PATH.test(entry) ||
      stylePaths.length >= BRAND_STYLE_FILES_MAX
    ) {
      problems.push(
        invalid(path, document.style_files?.line ?? 1, "identity_styles", {
          file: String(entry).slice(0, 60),
          problem: "path",
        }),
      );
    } else stylePaths.push(entry.replaceAll("\\", "/"));
  });
  const sources: BrandSource[] = [];
  const files = input.files;
  if (files !== undefined) {
    const page = files.get(IDENTITY_PAGE_PATH);
    if (page === undefined)
      warnings.push(warning("identity_page_absent", { path: IDENTITY_PAGE_PATH }));
    else if (page.trim() === "" || utf8(page).length > IDENTITY_PAGE_MAX_BYTES) {
      problems.push(
        invalid(IDENTITY_PAGE_PATH, 1, "identity_page", {
          problem: "size",
          max: IDENTITY_PAGE_MAX_BYTES,
        }),
      );
    } else {
      const fault = mockupFaults(page)[0];
      if (fault !== undefined) {
        problems.push(
          invalid(IDENTITY_PAGE_PATH, 1, "identity_page", {
            problem: fault.problem,
            detail: fault.detail,
          }),
        );
      } else sources.push({ path: IDENTITY_PAGE_PATH, text: page, kind: "html" });
    }
    for (const style of stylePaths) {
      const text = files.get(style);
      if (text === undefined)
        problems.push(
          invalid(path, document.style_files?.line ?? 1, "identity_styles", {
            file: style,
            problem: "missing",
          }),
        );
      else if (utf8(text).length > STYLE_FILE_MAX_BYTES) {
        problems.push(
          invalid(path, document.style_files?.line ?? 1, "identity_styles", {
            file: style,
            problem: "size",
          }),
        );
      } else sources.push({ path: style, text, kind: "css" });
    }
  }
  // The mock-up pages that stand alone and are safe: the unsafe ones are named by the UX checks.
  const prefix = `${METHOD_DIR}/docs/${UX_MOCKUP_DIR}/`;
  for (const [mockup, text] of input.mockups ?? []) {
    if (mockup.startsWith(prefix) && text.trim() !== "" && mockupFaults(text).length === 0) {
      sources.push({ path: mockup, text, kind: "html" });
    }
  }

  // The engine.
  if (ruleProblems.length === 0 && rules.length > 0) {
    const run = checkBrandRules(rules, tokens, sources);
    for (const finding of run.findings) {
      problems.push(
        invalid(finding.path, finding.line, "brand_rule", {
          rule: finding.rule,
          detail: finding.detail,
        }),
      );
    }
    if (run.unverifiable.length > 0) {
      warnings.push(
        warning("brand_rule_unverifiable", {
          path,
          count: run.unverifiable.length,
          rules: run.unverifiable.map((rule) => rule.id).join(", "),
        }),
      );
    }
    for (const [file, count] of run.undetermined) {
      warnings.push(warning("brand_contrast_undetermined", { path: file, count }));
    }
    for (const file of run.tooDeep) {
      warnings.push(warning("brand_css_too_deep", { path: file }));
    }
    for (const [file, count] of run.truncated) {
      warnings.push(warning("brand_values_truncated", { path: file, count }));
    }
  }

  // The tokens of the UX specification that say otherwise than the identity.
  const ux = input.documents.find(
    (candidate) => candidate.tokens !== undefined && candidate.kind?.value === "ux",
  );
  if (ux?.tokens !== undefined) {
    const own = flattenTokens(ux.tokens.value);
    for (const [token, value] of own) {
      const brand = tokens.get(token);
      if (brand !== undefined && brand.toLowerCase() !== value.toLowerCase()) {
        problems.push(
          invalid(ux.path, ux.tokens.line, "identity_drift", {
            token,
            value: value.slice(0, 40),
            brand: brand.slice(0, 40),
          }),
        );
      }
    }
  }
  return { problems, warnings };
}

// ---------------------------------------------------------------------------------------------
// The voice, read on the published pages
// ---------------------------------------------------------------------------------------------

function voiceWarnings(platform: ParsedDocument, input: BrandCheckInput): DocsWarning[] {
  const phrases = avoidPhrases(platform);
  if (phrases.length === 0) return [];
  const warnings: DocsWarning[] = [];
  for (const document of input.documents) {
    const key = pathKey(document.path);
    if (!PUBLISHED_DIRS.some((dir) => key.startsWith(dir))) continue;
    const raw = input.textOf(document.path);
    if (raw === undefined) continue;
    const body = (splitFrontmatter(raw.replace(/\r\n?/g, "\n"))?.body ?? raw)
      .replace(/<!--[\s\S]*?-->/g, " ")
      .toLowerCase();
    const hits = phrases.filter((phrase) =>
      new RegExp(
        `(?<![\\p{L}\\p{N}])${phrase.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`,
        "u",
      ).test(body),
    );
    const first = hits[0];
    if (first !== undefined) {
      warnings.push(
        warning("brand_voice_avoid", {
          path: document.path,
          phrase: first.slice(0, 60),
          count: hits.length,
        }),
      );
    }
  }
  return warnings;
}

/**
 * The rules of the brand platform and of the visual identity. Warnings: a rule no program can
 * verify, a colour pair whose text or background is inherited, an identity built on a platform that
 * is not validated, a published page that uses a phrase the voice says to avoid.
 */
export function brandDocumentChecks(input: BrandCheckInput): LaunchCheck {
  const problems: DocsProblem[] = [];
  const warnings: DocsWarning[] = [];
  const platform = input.documents.find((document) => pathKey(document.path) === BRAND_PATH);
  const identity = input.documents.find((document) => pathKey(document.path) === IDENTITY_PATH);
  if (platform !== undefined) {
    problems.push(...platformProblems(platform));
    warnings.push(...voiceWarnings(platform, input));
  }
  if (identity !== undefined) {
    const checked = identityProblems(identity, input);
    problems.push(...checked.problems);
    warnings.push(...checked.warnings);
    if (
      platform !== undefined &&
      input.validations !== undefined &&
      identity.links.some((link) => link.value === BRAND_DOCUMENT_ID)
    ) {
      const status = deliverableStatus(
        BRAND_PATH,
        input.textOf(platform.path),
        input.validations.checkpoints,
        input.validations.now,
        VALIDATING,
      );
      if (status.state !== "validated") {
        warnings.push(warning("brand_not_validated", { path: identity.path, state: status.state }));
      }
    }
  }
  return { problems, warnings };
}
