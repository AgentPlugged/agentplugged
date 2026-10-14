import { builtInCommands, DEFAULT_RULES, renderConstitutionReference } from "@agentplugged/core";
import { en, FALLBACK_REASONS, fr } from "@agentplugged/i18n";
import { describe, expect, it } from "vitest";

/**
 * No text of the method (the constitution, Noah, the
 * skills, the catalogs of messages) tells the creator, at the default level, to copy a sentence, to
 * send two messages or to go to a terminal. The terminal is the way of the `strict` level only.
 */

// Vite's glob: every text of the method, read as is.
// @ts-expect-error `import.meta.glob` is Vite's: the types of this package do not load it.
const METHOD_FILES: Record<string, string> = import.meta.glob("../../../method/**/*.{md,yaml}", {
  query: "?raw",
  import: "default",
  eager: true,
});

interface Unit {
  readonly source: string;
  readonly text: string;
}

/** The sentences of a text: whitespace folded, cut after `.`, `!`, `?` and `;` followed by a space. */
function sentences(source: string, text: string): Unit[] {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .split(/\n\s*\n/)
    .flatMap((paragraph) =>
      paragraph
        .replace(/\\n/g, " ")
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?;])\s+(?=[A-ZÀ-Ý«"“(`-])/)
        .map((text) => ({ source, text })),
    );
}

const units: Unit[] = [
  ...Object.entries(METHOD_FILES).flatMap(([path, text]) =>
    sentences(path.slice(path.indexOf("/method/") + 1), text),
  ),
  ...sentences(
    "constitution",
    renderConstitutionReference([], DEFAULT_RULES, { tools: ["claude-code", "codex"] }),
  ),
  ...[
    ["fr", fr],
    ["en", en],
  ].flatMap(([name, catalog]) =>
    Object.entries(catalog as Record<string, string>).flatMap(([key, text]) =>
      sentences(`${name as string}:${key}`, text),
    ),
  ),
  ...Object.entries(FALLBACK_REASONS.fr).flatMap(([key, text]) =>
    sentences(`fallback:${key}`, text),
  ),
  // The descriptions of the tools the agents read (the MCP server hands them over as they are).
  ...builtInCommands.flatMap((command) =>
    sentences(`tool:${command.name}`, command.description ?? ""),
  ),
];

/** A sentence that forbids, or that speaks of the strict level: it may name the terminal. */
const RESTRICTED = /\b(strict|never|jamais|aucun|aucune|no|not)\b/i;

/** Setup chores that are no validation: the forge's login, the migration, the keys, the hooks. */
const CHORES =
  /auth login|doctor|migrate|key (presence|import|export|seal)|empreinte|Windows Hello|history\.source|no terminal|Aucun terminal|interactive|interactif|bridge|pont|sync|`init`|prompt|stdin|print mode/i;

describe("une validation, un geste", () => {
  it("lit des phrases", () => {
    expect(units.length).toBeGreaterThan(2000);
  });

  it("n'envoie pas le créateur au terminal hors du niveau strict", () => {
    const found = units.filter(
      ({ source, text }) =>
        /\bterminal\b/i.test(text) && !RESTRICTED.test(text) && !CHORES.test(`${source} ${text}`),
    );
    expect(found.map(({ source, text }) => `${source}: ${text}`)).toEqual([]);
  });

  it("n'attache aucune commande de validation du terminal hors du niveau strict", () => {
    const found = units.filter(
      ({ source, text }) =>
        /npx agentplugged (review\b|story ci [^`]*--waive|deferred (resolve|drop)|trace resolve)/.test(
          text,
        ) &&
        !/strict|never|jamais/i.test(text) &&
        !/^(fr|en):cli\.usage/.test(source),
    );
    expect(found.map(({ source, text }) => `${source}: ${text}`)).toEqual([]);
  });

  it("ne fait recopier aucune phrase et n'ordonne aucun double message", () => {
    const patterns = [
      /confirmation_quote/,
      /second (message|question)\b/i,
      /two (distinct |ordered )?messages|deux messages/i,
      /\bretape\b|recopie|tape exactement|écris exactement|phrase exacte|exact (sentence|phrase)|type exactly|repeat(ing)? (the action|a sentence)\b|by repeating it/i,
      /je confirme la fusion|confirm the merge/i,
    ];
    const found = units.filter(
      ({ source, text }) =>
        patterns.some((pattern) => pattern.test(text)) &&
        !RESTRICTED.test(text) &&
        !/key\.import/.test(source),
    );
    expect(found.map(({ source, text }) => `${source}: ${text}`)).toEqual([]);
  });

  it("ne demande plus de confirmation après une validation", () => {
    const found = units.filter(
      ({ source, text }) =>
        /confirmation (box|question)|confirm(es|e)[- ]tu cette action|do you confirm this/i.test(
          text,
        ) && !/key\.import/.test(source),
    );
    expect(found.map(({ source, text }) => `${source}: ${text}`)).toEqual([]);
  });
});
