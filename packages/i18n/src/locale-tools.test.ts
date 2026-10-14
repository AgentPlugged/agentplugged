import { describe, expect, it } from "vitest";
import {
  createCatalogTranslator,
  createTranslator,
  FALLBACK_CHAIN,
  fallbackReason,
  formatCurrency,
  formatDate,
  formatNumber,
  formatTime,
  INVALID_DATE_TEXT,
  type Locale,
  PSEUDO_END,
  PSEUDO_LOCALE,
  PSEUDO_START,
  pluralCategory,
  pseudoCatalog,
  pseudoLocalize,
  resolveLocale,
  resolveLocaleSetting,
  SUPPORTED_LOCALES,
  selectPlural,
} from "./index.js";

describe("supported languages", () => {
  it("are English, Spanish, French and Portuguese", () => {
    expect([...SUPPORTED_LOCALES]).toEqual(["en", "es", "fr", "pt"]);
  });

  it("recognises es and pt from a system language", () => {
    expect(resolveLocale(["es_ES.UTF-8"])).toBe("es");
    expect(resolveLocale(["pt-BR"])).toBe("pt");
    expect(resolveLocale(["de"])).toBe("en");
  });

  it("falls back to English, and only English, for a missing text", () => {
    expect(FALLBACK_CHAIN).toEqual({
      en: ["en"],
      es: ["es", "en"],
      fr: ["fr", "en"],
      pt: ["pt", "en"],
    });
    // The engine catalogs have no Spanish or Portuguese: the English text is read.
    expect(createTranslator("es")("init.action.created")).toBe(
      createTranslator("en")("init.action.created"),
    );
    expect(createTranslator("pt")("init.action.created")).toBe(
      createTranslator("en")("init.action.created"),
    );
  });

  it("gives the English fallback reason in Spanish and Portuguese", () => {
    expect(fallbackReason("es", "codex.permissions", "English text")).toBe("English text");
    expect(fallbackReason("pt", "codex.permissions", "English text")).toBe("English text");
  });
});

describe("language per creator and per product", () => {
  it("prefers the product, then the creator, then the system, then English", () => {
    expect(resolveLocaleSetting({ product: "pt", creator: "es", system: "fr" })).toBe("pt");
    expect(resolveLocaleSetting({ creator: "es", system: "fr" })).toBe("es");
    expect(resolveLocaleSetting({ system: "fr-FR" })).toBe("fr");
    expect(resolveLocaleSetting({})).toBe("en");
  });

  it("ignores a setting that names no supported language", () => {
    expect(resolveLocaleSetting({ product: "de", creator: "es", system: "fr" })).toBe("es");
    expect(resolveLocaleSetting({ product: "", creator: "xx", system: "de" })).toBe("en");
    expect(resolveLocaleSetting({ product: "pt-BR" })).toBe("pt");
  });
});

describe("plurals follow the language", () => {
  it.each([
    ["en", [0, 1, 2, 5], ["other", "one", "other", "other"]],
    ["es", [0, 1, 2, 5], ["other", "one", "other", "other"]],
    ["fr", [0, 1, 2, 5], ["one", "one", "other", "other"]],
    ["pt", [0, 1, 2, 5], ["one", "one", "other", "other"]],
  ] as const)("%s: 0, 1, 2 and 5", (locale, counts, expected) => {
    expect(counts.map((count) => pluralCategory(locale, count))).toEqual([...expected]);
  });

  it("selects the form, `other` when the category has none", () => {
    const forms = { one: "{n} produit", other: "{n} produits" };
    expect(selectPlural("fr", 0, forms)).toBe("{n} produit");
    expect(selectPlural("en", 0, forms)).toBe("{n} produits");
    expect(selectPlural("es", 5, forms)).toBe("{n} produits");
    // Spanish 1 000 000 is `many`, which these forms do not carry.
    expect(selectPlural("es", 1_000_000, forms)).toBe("{n} produits");
  });
});

describe("dates, times and numbers follow the language", () => {
  const moment = new Date(Date.UTC(2026, 9, 5, 14, 5));
  const utc = { timeZone: "UTC" };

  it.each([
    ["en", "October 5, 2026"],
    ["es", "5 de octubre de 2026"],
    ["fr", "5 octobre 2026"],
    ["pt", "5 de outubro de 2026"],
  ] as const)("writes the date in %s", (locale, expected) => {
    expect(formatDate(locale, moment, "long", utc)).toBe(expected);
  });

  it("writes the time with the language's clock", () => {
    expect(formatTime("en", moment, utc).replace(/\s/g, " ")).toBe("2:05 PM");
    for (const locale of ["es", "fr", "pt"] as const) {
      expect(formatTime(locale, moment, utc)).toBe("14:05");
    }
  });

  it("writes numbers and amounts with the language's separators", () => {
    const normalise = (text: string) => text.replace(/[  ]/g, " ");
    expect(normalise(formatNumber("en", 1234567.5))).toBe("1,234,567.5");
    expect(normalise(formatNumber("fr", 1234567.5))).toBe("1 234 567,5");
    expect(normalise(formatNumber("es", 1234567.5))).toBe("1.234.567,5");
    expect(normalise(formatNumber("pt", 1234567.5))).toBe("1.234.567,5");
    expect(normalise(formatCurrency("fr", 12.5, "EUR"))).toBe("12,50 €");
    expect(normalise(formatCurrency("en", 12.5, "EUR"))).toBe("€12.50");
  });
});

describe("pseudo-language", () => {
  it("wraps a text in markers and lengthens it by at least 30 %", () => {
    const text = "Scanne ce code avec ton téléphone.";
    const pseudo = pseudoLocalize(text);
    expect(pseudo.startsWith(PSEUDO_START)).toBe(true);
    expect(pseudo.endsWith(PSEUDO_END)).toBe(true);
    expect([...pseudo].length).toBeGreaterThanOrEqual(Math.ceil([...text].length * 1.3) + 2);
    expect(pseudo).not.toContain("Scanne");
  });

  it("keeps the placeholders, so parameters still fill them", () => {
    const pseudo = pseudoLocalize("Code : {code} ({minutes} min)");
    expect(pseudo).toContain("{code}");
    expect(pseudo).toContain("{minutes}");
  });

  it("turns every text of a catalog", () => {
    const catalog = pseudoCatalog({ a: "Un", b: "Deux" });
    for (const text of Object.values(catalog)) {
      expect(text.startsWith(PSEUDO_START) && text.endsWith(PSEUDO_END)).toBe(true);
    }
  });
});

describe("robustness", () => {
  it("ignores a setting that is not a string", () => {
    expect(
      resolveLocaleSetting({ product: 123 as never, creator: ["pt"] as never, system: "fr" }),
    ).toBe("fr");
    expect(resolveLocale([null as never, "es"])).toBe("es");
  });

  it("shows a dash for an invalid date and falls back to the system's time zone for an unknown one", () => {
    expect(formatDate("fr", new Date("nope"))).toBe(INVALID_DATE_TEXT);
    expect(formatTime("en", Number.NaN)).toBe(INVALID_DATE_TEXT);
    expect(formatDate("fr", 8.64e15 + 1)).toBe(INVALID_DATE_TEXT);
    const moment = new Date(Date.UTC(2026, 9, 5, 14, 5));
    expect(formatDate("fr", moment, "long", { timeZone: "Mars/Base" })).toMatch(/octobre 2026/);
  });
});

describe("createCatalogTranslator", () => {
  const catalogs = {
    en: { "x.hello": "Hello {name}" },
    es: { "x.hello": "Hola {name}" },
    fr: { "x.hello": "Bonjour {name}" },
    pt: { "x.hello": "Olá {name}" },
  } as const;

  it("translates in each language and in the pseudo-language", () => {
    for (const [locale, text] of [
      ["en", "Hello Ana"],
      ["es", "Hola Ana"],
      ["fr", "Bonjour Ana"],
      ["pt", "Olá Ana"],
    ] as const) {
      expect(createCatalogTranslator(catalogs, locale as Locale)("x.hello", { name: "Ana" })).toBe(
        text,
      );
    }
    const pseudo = createCatalogTranslator(catalogs, PSEUDO_LOCALE)("x.hello", { name: "Ana" });
    expect(pseudo).toMatch(/^⟦.*Ana.*⟧$/);
    expect(pseudo).not.toContain("Hello");
  });

  it("returns the key for an unknown key, even in the pseudo-language, and never reads the prototype", () => {
    for (const locale of ["en", PSEUDO_LOCALE] as const) {
      const t = createCatalogTranslator(catalogs, locale) as (key: string) => string;
      expect(t("nope")).toBe("nope");
      expect(t("toString")).toBe("toString");
      expect(t("__proto__")).toBe("__proto__");
    }
  });

  it("reads like English for a language that is not supported", () => {
    expect(createCatalogTranslator(catalogs, "de" as never)("x.hello", { name: "Ana" })).toBe(
      "Hello Ana",
    );
  });

  it("reads English when a language lacks the key", () => {
    const partial = { ...catalogs, fr: {} } as unknown as typeof catalogs;
    expect(createCatalogTranslator(partial, "fr")("x.hello", { name: "Ana" })).toBe("Hello Ana");
  });
});
