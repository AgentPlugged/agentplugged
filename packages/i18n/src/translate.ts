import { type Catalog, en, type MessageKey } from "./catalogs/en.js";
import { FALLBACK_REASONS } from "./catalogs/fallback-reasons.js";
import { fr } from "./catalogs/fr.js";

export const SUPPORTED_LOCALES = ["en", "es", "fr", "pt"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
export const FALLBACK_LOCALE: Locale = "en";

/**
 * The texts of the method and the engine exist in English and French only: Spanish and Portuguese have
 * no catalog here and read English through `FALLBACK_CHAIN` (their translation is planned)
 * The texts of the other surfaces live elsewhere, complete in all four languages.
 */
const catalogs: Readonly<Record<Locale, Partial<Catalog>>> = { en, es: {}, fr, pt: {} };

/**
 * The languages tried, in order, for a text missing in the creator's language: the language
 * itself, then English (the single source). Portuguese does not read Spanish: a mix of two
 * languages in one screen would be worse than a plain English text.
 */
export const FALLBACK_CHAIN: Readonly<Record<Locale, ReadonlyArray<Locale>>> = {
  en: ["en"],
  es: ["es", "en"],
  fr: ["fr", "en"],
  pt: ["pt", "en"],
};

export type MessageParams = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: MessageParams) => string;

export function isMessageKey(key: string): key is MessageKey {
  return Object.hasOwn(en, key);
}

/** Replaces each `{name}` with its parameter; unknown placeholders are left visible. */
export function interpolate(template: string, params: MessageParams): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

export function createTranslator(locale: Locale): Translate {
  const catalog = catalogs[locale];
  return (key, params = {}) => interpolate(catalog[key] ?? en[key], params);
}

/**
 * The plural form of `count` in the translator's language: `one` for 1, `other` above, and for 0
 * the language's own rule (`plural.zero`: `other` in English, `one` in French).
 */
export function pluralOf(t: Translate, count: number): "one" | "other" {
  if (count === 1) return "one";
  if (count === 0) return t("plural.zero") === "one" ? "one" : "other";
  return "other";
}

/** Values that name no language (POSIX defaults). */
const NO_LANGUAGE = new Set(["c", "posix"]);

/** Language subtag of a tag such as `fr_FR.UTF-8`, `fr-CA` or `en`, or undefined when it names none. */
export function languageOf(tag: string | undefined): string | undefined {
  if (typeof tag !== "string") return undefined;
  const language = tag
    .trim()
    .split(/[-_.@]/)[0]
    ?.toLowerCase();
  return language && !NO_LANGUAGE.has(language) ? language : undefined;
}

/**
 * Picks the display language from candidates in priority order (for example
 * `AGENTPLUGGED_LANG`, then the system language). The first candidate that names a
 * language decides; an unsupported language falls back to English.
 */
export function resolveLocale(candidates: ReadonlyArray<string | undefined>): Locale {
  for (const candidate of candidates) {
    const language = languageOf(candidate);
    if (language) {
      return (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(language)
        ? (language as Locale)
        : FALLBACK_LOCALE;
    }
  }
  return FALLBACK_LOCALE;
}

/**
 * A fallback reason in the given language: its translation when there is one, otherwise the
 * English reason given by the compatibility matrix (the single English source). `params` fill
 * the translation's placeholders (`{path}`).
 */
export function fallbackReason(
  locale: Locale,
  id: string,
  english: string,
  params: MessageParams = {},
): string {
  if (!Object.hasOwn(FALLBACK_REASONS, locale)) return english;
  const translations = FALLBACK_REASONS[locale as keyof typeof FALLBACK_REASONS];
  const anyClient = `*.${id.slice(id.indexOf(".") + 1)}`;
  const key = Object.hasOwn(translations, id)
    ? id
    : Object.hasOwn(translations, anyClient)
      ? anyClient
      : undefined;
  const template = key === undefined ? undefined : translations[key];
  return template === undefined ? english : interpolate(template, params);
}
