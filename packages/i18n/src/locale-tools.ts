import {
  FALLBACK_CHAIN,
  FALLBACK_LOCALE,
  interpolate,
  type Locale,
  languageOf,
  type MessageParams,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./translate.js";

// Tools shared by the surfaces of the product: the choice of
// the language per creator and per product, formats and plurals that follow the language (the
// system's internationalization API), the pseudo-language, and the translator of catalogs split by
// screen domain. Nothing here holds a text of a screen: those live elsewhere.

// --- Language setting ------------------------------------------------------------------

export type LocaleSettings = {
  /** The language set for this product, when the creator chose one. */
  readonly product?: string | undefined;
  /** The language set by the creator for all their products. */
  readonly creator?: string | undefined;
  /** The system language (`LANG`, the browser, the phone), used when nothing is set. */
  readonly system?: string | undefined;
};

/** The supported language a setting names (`fr`, `pt-BR`, `ES_es.UTF-8`), or undefined. */
function settingLocale(tag: string | undefined): Locale | undefined {
  const language = languageOf(tag);
  return (SUPPORTED_LOCALES as ReadonlyArray<string>).includes(language ?? "")
    ? (language as Locale)
    : undefined;
}

/**
 * The display language: the product's setting, else the creator's, else the system language, else
 * English. A setting that names no supported language is ignored (the next one decides), unlike
 * the system language, whose unsupported value falls back to English as `resolveLocale` does.
 */
export function resolveLocaleSetting(settings: LocaleSettings): Locale {
  return (
    settingLocale(settings.product) ??
    settingLocale(settings.creator) ??
    resolveLocale([settings.system])
  );
}

// --- Formats and plurals -----------------------------------------------------------------------

/** The language tag given to `Intl`: Portuguese follows the general `pt` rules (Brazilian base). */
const INTL_TAGS: Readonly<Record<Locale, string>> = { en: "en", es: "es", fr: "fr", pt: "pt" };

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

/** The plural category of `count` in the language (`Intl.PluralRules`): 0, 1, 2 and 5 differ by language. */
export function pluralCategory(locale: Locale, count: number): PluralCategory {
  return new Intl.PluralRules(INTL_TAGS[locale]).select(count);
}

/** The form for `count` among `forms`, `other` when the category has none. */
export function selectPlural(
  locale: Locale,
  count: number,
  forms: Readonly<Partial<Record<PluralCategory, string>> & { other: string }>,
): string {
  return forms[pluralCategory(locale, count)] ?? forms.other;
}

export type FormatOptions = {
  /** An IANA time zone (`Europe/Paris`); the system's by default. */
  readonly timeZone?: string;
};

/** Shown in place of a date that is not a valid moment: a damaged timestamp never breaks a screen. */
export const INVALID_DATE_TEXT = "—";

/** An `Intl.DateTimeFormat` in the language; an unknown time zone falls back to the system's. */
function dateFormat(
  locale: Locale,
  style: Intl.DateTimeFormatOptions,
  timeZone: string | undefined,
): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat(INTL_TAGS[locale], {
      ...style,
      ...(timeZone ? { timeZone } : {}),
    });
  } catch {
    return new Intl.DateTimeFormat(INTL_TAGS[locale], style);
  }
}

function formatMoment(format: Intl.DateTimeFormat, date: Date | number): string {
  const time = typeof date === "number" ? date : date.getTime();
  return Number.isFinite(time) && Math.abs(time) <= 8.64e15
    ? format.format(date)
    : INVALID_DATE_TEXT;
}

export function formatDate(
  locale: Locale,
  date: Date | number,
  style: "short" | "medium" | "long" = "long",
  options: FormatOptions = {},
): string {
  return formatMoment(dateFormat(locale, { dateStyle: style }, options.timeZone), date);
}

export function formatTime(
  locale: Locale,
  date: Date | number,
  options: FormatOptions = {},
): string {
  return formatMoment(dateFormat(locale, { timeStyle: "short" }, options.timeZone), date);
}

export function formatNumber(
  locale: Locale,
  value: number,
  options: Intl.NumberFormatOptions = {},
): string {
  return new Intl.NumberFormat(INTL_TAGS[locale], options).format(value);
}

/** An amount in a currency (`EUR`, `USD`, …) written the way the language writes it. */
export function formatCurrency(locale: Locale, value: number, currency: string): string {
  return formatNumber(locale, value, { style: "currency", currency });
}

// --- Pseudo-language ----------------------------------------------------------------

/** The name of the pseudo-language, handed to the translators in tests; never a creator's choice. */
export const PSEUDO_LOCALE = "pseudo";
export type PseudoLocale = typeof PSEUDO_LOCALE;

export const PSEUDO_START = "⟦";
export const PSEUDO_END = "⟧";
/** Added to each text, as a share of its length (a translation is often a third longer). */
export const PSEUDO_GROWTH = 0.3;

const PLAIN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const ACCENTED = "áƀçðéƒĝĥíĵķļɱñóþɋŕšţúṽŵẋýžÁƁÇÐÉƑĜĤÍĴĶĻṀÑÓÞɊŔŠŢÚṼŴẊÝŽ";
const ACCENT_OF = new Map(
  [...PLAIN].map((letter, index) => [letter, [...ACCENTED][index] ?? letter]),
);

/**
 * A text turned into the pseudo-language: letters accented (still readable), the text lengthened by
 * 30 % and wrapped in `⟦ ⟧`. `{placeholders}` stay as they are, so parameters still fill them. A
 * text visible on screen without these markers was not taken from a catalog. The lengthening is
 * computed on the text as written (a placeholder counts as its name): a very long parameter value
 * is not lengthened further.
 */
export function pseudoLocalize(text: string): string {
  const accented = text
    .split(/(\{\w+\})/)
    .map((part) =>
      /^\{\w+\}$/.test(part) ? part : [...part].map((char) => ACCENT_OF.get(char) ?? char).join(""),
    )
    .join("");
  const padding = "~".repeat(Math.ceil([...text].length * PSEUDO_GROWTH));
  return `${PSEUDO_START}${accented}${padding}${PSEUDO_END}`;
}

/** Every text of a catalog in the pseudo-language. */
export function pseudoCatalog<K extends string>(
  catalog: Readonly<Record<K, string>>,
): Readonly<Record<K, string>> {
  return Object.fromEntries(
    Object.entries<string>(catalog).map(([key, text]) => [key, pseudoLocalize(text)]),
  ) as Record<K, string>;
}

// --- Translator of catalogs by domain ----------------------------------------------------------

/** The complete catalogs of one domain: the same keys in each supported language. */
export type DomainCatalogs<K extends string> = Readonly<
  Record<Locale, Readonly<Record<K, string>>>
>;

export type CatalogTranslate<K extends string> = (key: K, params?: MessageParams) => string;

/**
 * A translator over catalogs complete in every language. The language is a supported one or the
 * pseudo-language. A key missing in the language reads through `FALLBACK_CHAIN` (a safety net: the
 * completeness test of the catalogs fails first).
 */
export function createCatalogTranslator<K extends string>(
  catalogs: DomainCatalogs<K>,
  locale: Locale | PseudoLocale,
): CatalogTranslate<K> {
  const own = (language: Locale, key: K): string | undefined => {
    const catalog = catalogs[language];
    return catalog !== undefined && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  };
  if (locale === PSEUDO_LOCALE) {
    return (key, params = {}) => {
      const text = own(FALLBACK_LOCALE, key);
      return text === undefined ? key : interpolate(pseudoLocalize(text), params);
    };
  }
  // A language that is not supported (a value read from a file) reads like English.
  const chain = Object.hasOwn(FALLBACK_CHAIN, locale)
    ? FALLBACK_CHAIN[locale]
    : FALLBACK_CHAIN[FALLBACK_LOCALE];
  return (key, params = {}) => {
    for (const language of chain) {
      const text = own(language, key);
      if (text !== undefined) return interpolate(text, params);
    }
    return key;
  };
}
