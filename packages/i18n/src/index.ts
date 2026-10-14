export const packageName = "@agentplugged/i18n";

export { type Catalog, en, type MessageKey } from "./catalogs/en.js";
export { FALLBACK_REASONS } from "./catalogs/fallback-reasons.js";
export { fr } from "./catalogs/fr.js";
export {
  type CatalogTranslate,
  createCatalogTranslator,
  type DomainCatalogs,
  type FormatOptions,
  formatCurrency,
  formatDate,
  formatNumber,
  formatTime,
  INVALID_DATE_TEXT,
  type LocaleSettings,
  type PluralCategory,
  PSEUDO_END,
  PSEUDO_GROWTH,
  PSEUDO_LOCALE,
  PSEUDO_START,
  type PseudoLocale,
  pluralCategory,
  pseudoCatalog,
  pseudoLocalize,
  resolveLocaleSetting,
  selectPlural,
} from "./locale-tools.js";
export {
  createTranslator,
  FALLBACK_CHAIN,
  FALLBACK_LOCALE,
  fallbackReason,
  interpolate,
  isMessageKey,
  type Locale,
  type MessageParams,
  pluralOf,
  resolveLocale,
  SUPPORTED_LOCALES,
  type Translate,
} from "./translate.js";
