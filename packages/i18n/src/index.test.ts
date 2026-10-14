import { describe, expect, it } from "vitest";
import {
  createTranslator,
  en,
  FALLBACK_REASONS,
  fallbackReason,
  fr,
  isMessageKey,
  packageName,
  resolveLocale,
} from "./index.js";

describe("i18n", () => {
  it("exposes its package name", () => {
    expect(packageName).toBe("@agentplugged/i18n");
  });

  it("has the same keys in every catalog", () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it("uses the same placeholders in every catalog", () => {
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(fr[key]), key).toEqual(placeholders(en[key]));
    }
  });
});

describe("French copy", () => {
  it("addresses the creator with « tu »", () => {
    const texts = [...Object.values(fr), ...Object.values(FALLBACK_REASONS.fr)];
    for (const text of texts) expect(text).not.toMatch(/\b(vous|vos|votre)\b|\b\w+ez\b/i);
  });
});

describe("fallbackReason", () => {
  it("keeps the English reason as given, and translates it in French", () => {
    expect(fallbackReason("en", "codex.rules", "English text")).toBe("English text");
    expect(fallbackReason("fr", "codex.rules", "English text")).toBe(
      FALLBACK_REASONS.fr["codex.rules"],
    );
    expect(fallbackReason("fr", "unknown.reason", "English text")).toBe("English text");
  });
});

describe("createTranslator", () => {
  it("translates and interpolates", () => {
    expect(createTranslator("en")("error.unknown_command", { command: "x" })).toBe(
      'Unknown command "x".',
    );
    expect(createTranslator("fr")("init.action.created")).toBe("créé");
  });

  it("leaves unknown placeholders visible", () => {
    expect(createTranslator("en")("error.unknown_command")).toBe('Unknown command "{command}".');
  });

  it("recognises message keys", () => {
    expect(isMessageKey("init.action.updated")).toBe(true);
    expect(isMessageKey("nope")).toBe(false);
    expect(isMessageKey("toString")).toBe(false);
  });
});

describe("resolveLocale", () => {
  it.each([
    [["fr"], "fr"],
    [["fr_FR.UTF-8"], "fr"],
    [["FR-ca"], "fr"],
    [["en-US"], "en"],
    [[undefined, "fr-FR"], "fr"],
    [["", "fr-FR"], "fr"],
    [["C", "fr-FR"], "fr"],
    [["C.UTF-8", "POSIX", "fr"], "fr"],
    [["de", "fr"], "en"],
    [["en", "fr"], "en"],
    [[], "en"],
    [[undefined], "en"],
  ] as const)("resolves %j to %s", (candidates, expected) => {
    expect(resolveLocale(candidates)).toBe(expected);
  });
});
