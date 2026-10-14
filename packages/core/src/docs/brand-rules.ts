import {
  BRAND_FINDINGS_PER_RULE,
  BRAND_RULE_KINDS,
  BRAND_RULES_MAX,
  type BrandRuleKind,
  CONTRAST_AA,
} from "@agentplugged/protocol";
import { contrastRatio, hexOf, over, parseColor, type Rgba } from "./brand-color.js";
import {
  colorsIn,
  customContexts,
  customsIn,
  type Declaration,
  readCss,
  readHtmlStyles,
  type Sheet,
  selectorIn,
  valueVariants,
} from "./brand-css.js";

/**
 * The fixed rules of the brand, as pure functions. A rule is declared in the header
 * of the identity under `brand_rules`, in one of a few forms a program can verify; the engine
 * applies them to the mock-up pages, to the identity page and to the style files of the code, and
 * names each gap in one line with the rule that is broken. A rule no program can verify is `manual`:
 * it is listed as such, never reported as kept.
 */

export interface BrandRule {
  readonly id: string;
  readonly kind: BrandRuleKind;
  readonly text: string;
  /** `reserved_color`: the colour token. `font_role`: the family token. */
  readonly token?: string;
  /** The simple selectors (`.cta`, `#logo`, `button`) a colour or a family is reserved to. */
  readonly only?: readonly string[];
  /** `font_families`, `radius_scale`: the tokens (or values, for a radius) that are allowed. */
  readonly allowed?: readonly string[];
  /** `palette_only`: colours allowed besides the palette (tokens or hexadecimal values). */
  readonly allow?: readonly string[];
  /** `no_gradient`: the selectors where a gradient is allowed. */
  readonly except?: readonly string[];
  /** `contrast`: the minimum for normal text, and the pairs of colour tokens to hold to it. */
  readonly min?: number;
  readonly pairs?: ReadonlyArray<readonly [string, string]>;
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------
// Tokens, flattened
// ---------------------------------------------------------------------------------------------

/** The leaves of the tokens by path (`color.accent`), their aliases (`{color.x}`) resolved. */
export function flattenTokens(raw: unknown): Map<string, string> {
  const leaves = new Map<string, string>();
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 6) return;
    if (isMap(node)) {
      for (const [key, value] of Object.entries(node)) {
        walk(value, path === "" ? key : `${path}.${key}`, depth + 1);
      }
    } else if (typeof node === "string" || typeof node === "number") {
      leaves.set(path, String(node).trim());
    }
  };
  walk(raw, "", 0);
  for (let pass = 0; pass < 5; pass += 1) {
    for (const [path, value] of leaves) {
      const alias = /^\{([^{}]+)\}$/.exec(value)?.[1];
      if (alias !== undefined && leaves.has(alias)) leaves.set(path, leaves.get(alias) ?? value);
    }
  }
  return leaves;
}

/** The colours of the palette: the leaves of `color` that spell a colour, by path. */
export function paletteOf(tokens: ReadonlyMap<string, string>): Map<string, Rgba> {
  const palette = new Map<string, Rgba>();
  for (const [path, value] of tokens) {
    if (!path.startsWith("color.")) continue;
    const color = parseColor(value);
    if (color !== undefined) palette.set(path, color);
  }
  return palette;
}

/** The font names of a family token: its value, or the `family` key of a group of tokens. */
function familyNames(tokens: ReadonlyMap<string, string>, path: string): string[] | undefined {
  const value =
    tokens.get(path) ?? tokens.get(`${path}.family`) ?? tokens.get(`${path}.font-family`);
  return value === undefined ? undefined : namesOf(value);
}

function namesOf(list: string): string[] {
  return list
    .split(",")
    .map((name) =>
      name
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase(),
    )
    .filter((name) => name !== "");
}

// ---------------------------------------------------------------------------------------------
// Reading the rules
// ---------------------------------------------------------------------------------------------

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SIMPLE_SELECTOR = /^[.#]?[A-Za-z_][\w-]*$/;
const LENGTH = /^(?:0|\d+(?:\.\d+)?(?:px|rem|em|%))$/;
const KEYS: Readonly<Record<BrandRuleKind, readonly string[]>> = {
  reserved_color: ["color", "only"],
  palette_only: ["allow"],
  font_role: ["family", "only"],
  font_families: ["allowed"],
  radius_scale: ["allowed"],
  no_gradient: ["except"],
  contrast: ["min", "pairs"],
  manual: [],
};

export interface RuleProblem {
  readonly rule: string;
  readonly detail: string;
}

function list(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? (value as string[]).map((item) => item.trim())
    : undefined;
}

/** The rules of the header, and what is wrong with them (each as a short detail). */
export function readRules(
  raw: unknown,
  tokens: ReadonlyMap<string, string>,
): { rules: BrandRule[]; problems: RuleProblem[] } {
  const rules: BrandRule[] = [];
  const problems: RuleProblem[] = [];
  const bad = (rule: string, detail: string) =>
    problems.push({ rule, detail: detail.slice(0, 80) });
  if (!Array.isArray(raw) || raw.length === 0) {
    bad("brand_rules", "expected a list of rules");
    return { rules, problems };
  }
  if (raw.length > BRAND_RULES_MAX) bad("brand_rules", `more than ${BRAND_RULES_MAX} rules`);
  const seen = new Set<string>();
  const colorToken = (path: unknown) =>
    typeof path === "string" &&
    parseColor(tokens.get(path) ?? "") !== undefined &&
    path.startsWith("color.");
  raw.slice(0, BRAND_RULES_MAX).forEach((entry, index) => {
    if (!isMap(entry)) {
      bad(`#${index + 1}`, "expected a map");
      return;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = SLUG.test(id) ? id : `#${index + 1}`;
    if (!SLUG.test(id)) bad(name, "id: lower-case words joined by hyphens");
    else if (seen.has(id)) bad(name, "id given twice");
    seen.add(id);
    const kind = (BRAND_RULE_KINDS as readonly unknown[]).includes(entry.kind)
      ? (entry.kind as BrandRuleKind)
      : undefined;
    if (kind === undefined) {
      bad(name, `kind: one of ${BRAND_RULE_KINDS.join(", ")}`);
      return;
    }
    const text = typeof entry.text === "string" ? entry.text.trim() : "";
    if (text === "" || /[\r\n]/.test(text) || text.length > 240) {
      bad(name, "text: one line, 240 characters at most");
    }
    for (const key of Object.keys(entry)) {
      if (!["id", "kind", "text", ...KEYS[kind]].includes(key))
        bad(name, `${key}: not for ${kind}`);
    }
    const only = list(entry.only);
    const allowed = list(entry.allowed);
    const allow = list(entry.allow);
    const except = list(entry.except);
    const selectors = (items: string[] | undefined, key: string, required: boolean) => {
      if (
        items === undefined ? required || entry[key] !== undefined : items.length === 0 && required
      ) {
        bad(name, `${key}: a list of simple selectors (.class, #id, tag)`);
      } else if (items?.some((item) => !SIMPLE_SELECTOR.test(item)) === true) {
        bad(name, `${key}: simple selectors only (.class, #id, tag)`);
      }
    };
    let token: string | undefined;
    if (kind === "reserved_color") {
      if (!colorToken(entry.color)) bad(name, "color: a colour token of the identity (color.…)");
      else token = entry.color as string;
      selectors(only, "only", true);
    } else if (kind === "font_role") {
      const family = entry.family;
      if (typeof family !== "string" || familyNames(tokens, family) === undefined) {
        bad(name, "family: a type token that holds a font family (type.…)");
      } else token = family;
      selectors(only, "only", true);
    } else if (kind === "font_families") {
      if (
        allowed === undefined ||
        allowed.length === 0 ||
        allowed.some((path) => familyNames(tokens, path) === undefined)
      ) {
        bad(name, "allowed: type tokens that hold a font family");
      }
    } else if (kind === "radius_scale") {
      if (
        allowed === undefined ||
        allowed.length === 0 ||
        allowed.some(
          (item) =>
            !LENGTH.test(item) &&
            !(item.startsWith("radius.") && LENGTH.test(tokens.get(item) ?? "")),
        )
      ) {
        bad(name, "allowed: radius tokens (radius.…) or lengths (18px, 50%)");
      }
    } else if (kind === "no_gradient") {
      selectors(except, "except", false);
    } else if (kind === "palette_only") {
      if (allow?.some((item) => !colorToken(item) && parseColor(item) === undefined) === true) {
        bad(name, "allow: colour tokens or colours");
      }
    } else if (kind === "contrast") {
      const min = entry.min;
      if (min !== undefined && (typeof min !== "number" || min < CONTRAST_AA || min > 21)) {
        bad(name, "min: a ratio from 4.5 (AA) to 21");
      }
      const pairs = entry.pairs;
      if (
        pairs !== undefined &&
        (!Array.isArray(pairs) ||
          pairs.some(
            (pair) =>
              !Array.isArray(pair) || pair.length !== 2 || !pair.every((path) => colorToken(path)),
          ))
      ) {
        bad(name, "pairs: pairs of colour tokens [text, background]");
      }
    }
    if (!SLUG.test(id)) return;
    rules.push({
      id,
      kind,
      text,
      ...(token === undefined ? {} : { token }),
      ...(only === undefined ? {} : { only }),
      ...(allowed === undefined ? {} : { allowed }),
      ...(allow === undefined ? {} : { allow }),
      ...(except === undefined ? {} : { except }),
      ...(typeof entry.min === "number" ? { min: entry.min } : {}),
      ...(Array.isArray(entry.pairs)
        ? {
            pairs: (entry.pairs as string[][]).map(
              (pair) => [pair[0] ?? "", pair[1] ?? ""] as const,
            ),
          }
        : {}),
    });
  });
  return { rules, problems };
}

/** The pairs of colour tokens a `contrast` rule declares that fall under its minimum. */
export function weakPairs(
  rule: BrandRule,
  tokens: ReadonlyMap<string, string>,
): Array<{ text: string; background: string; ratio: number; min: number }> {
  const min = rule.min ?? CONTRAST_AA;
  const weak: Array<{
    text: string;
    background: string;
    ratio: number;
    min: number;
  }> = [];
  for (const [text, background] of rule.pairs ?? []) {
    const fg = parseColor(tokens.get(text) ?? "");
    const bg = parseColor(tokens.get(background) ?? "");
    if (fg === undefined || bg === undefined) continue;
    const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
    const ground = over(bg, white);
    const shown = contrastRatio(over(fg, ground), ground);
    if (shown < min) weak.push({ text, background, ratio: shown, min });
  }
  return weak;
}

// ---------------------------------------------------------------------------------------------
// Applying the rules
// ---------------------------------------------------------------------------------------------

export interface BrandSource {
  readonly path: string;
  readonly text: string;
  readonly kind: "html" | "css";
}

export interface BrandFinding {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  /** The gap in one line: what was found, where, and what the rule says. */
  readonly detail: string;
}

export interface BrandRun {
  readonly findings: BrandFinding[];
  /** The rules no program can verify, listed as such. */
  readonly unverifiable: BrandRule[];
  /** By file: the blocks with a text colour or a background but not both (inherited). */
  readonly undetermined: Map<string, number>;
  /** By file: true when the nesting was too deep and the rest of the file was not read. */
  readonly tooDeep: Set<string>;
  /** By file: the declarations with more values than were looked at (the check is partial). */
  readonly truncated: Map<string, number>;
  /** The number of declarations read. */
  readonly declarations: number;
}

const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
]);

const trim = (text: string, size = 50) =>
  text.length > size ? `${text.slice(0, size - 1)}…` : text;

function familiesOf(declaration: Declaration, value: string): string[] | undefined {
  if (declaration.property === "font-family") return namesOf(value);
  if (declaration.property !== "font") return undefined;
  const tail =
    /(?:^|\s)(?:\d*\.?\d+(?:px|rem|em|%|pt|vw|vh)|xx?-small|small|medium|large|x{1,2}-large|smaller|larger)(?:\/\S+)?\s+(.+)$/i.exec(
      value,
    );
  return tail === null ? [] : namesOf(tail[1] ?? "");
}

/** Applies the rules to some files. */
export function checkBrandRules(
  rules: readonly BrandRule[],
  tokens: ReadonlyMap<string, string>,
  sources: readonly BrandSource[],
): BrandRun {
  const findings: BrandFinding[] = [];
  const undetermined = new Map<string, number>();
  const tooDeep = new Set<string>();
  const truncated = new Map<string, number>();
  const unverifiable = rules.filter((rule) => rule.kind === "manual");
  const palette = paletteOf(tokens);
  const paletteHex = new Set([...palette.values()].map(hexOf));
  const counts = new Map<string, number>();
  let read = 0;

  const report = (rule: BrandRule, path: string, line: number, detail: string) => {
    const key = `${rule.id} ${path}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const same = findings.some(
      (f) => f.rule === rule.id && f.path === path && f.line === line && f.detail === detail,
    );
    if (count <= BRAND_FINDINGS_PER_RULE && !same)
      findings.push({ rule: rule.id, path, line, detail });
  };

  const reserved = (rule: BrandRule) => {
    const color = parseColor(tokens.get(rule.token ?? "") ?? "");
    return color === undefined ? undefined : hexOf(color);
  };

  for (const source of sources) {
    const sheet: Sheet =
      source.kind === "html" ? readHtmlStyles(source.text) : readCss(source.text, source.text, 0);
    read += sheet.declarations.length;
    if (sheet.tooDeep) tooDeep.add(source.path);
    const where = (declaration: Declaration) =>
      `« ${declaration.property}: ${trim(declaration.value)} »`;
    for (const declaration of sheet.declarations) {
      const { values, truncated: cut } = valueVariants(declaration.value, sheet.customs);
      if (cut) truncated.set(source.path, (truncated.get(source.path) ?? 0) + 1);
      for (const rule of rules) {
        for (const value of values) {
          if (rule.kind === "reserved_color" || rule.kind === "palette_only") {
            const found = colorsIn(value, declaration.property);
            for (const text of found.unread) {
              report(
                rule,
                source.path,
                declaration.line,
                `${where(declaration)}: colour not readable (« ${trim(text, 30)} »), the rule cannot be verified here`,
              );
            }
            for (const color of found.colors) {
              if (color.a === 0) continue;
              const hex = hexOf(color);
              if (rule.kind === "reserved_color") {
                if (hex !== reserved(rule)) continue;
                const outside = declaration.selectors.find(
                  (selector) => !selectorIn(selector, rule.only ?? []),
                );
                if (outside !== undefined || declaration.selectors.length === 0) {
                  report(
                    rule,
                    source.path,
                    declaration.line,
                    `${hex} (${rule.token}) on « ${trim(outside ?? "(no selector)", 40)} »: reserved to ${(rule.only ?? []).join(", ")}`,
                  );
                }
              } else {
                const extra = (rule.allow ?? []).map((item) => {
                  const spelled = parseColor(tokens.get(item) ?? item);
                  return spelled === undefined ? "" : hexOf(spelled);
                });
                if (!paletteHex.has(hex) && !extra.includes(hex)) {
                  report(
                    rule,
                    source.path,
                    declaration.line,
                    `${hex} is not in the palette (${where(declaration)})`,
                  );
                }
              }
            }
          } else if (rule.kind === "font_role" || rule.kind === "font_families") {
            const names = familiesOf(declaration, value);
            if (names === undefined) continue;
            if (/var\(/i.test(value)) {
              report(
                rule,
                source.path,
                declaration.line,
                `${where(declaration)}: family not readable, the rule cannot be verified here`,
              );
            } else if (rule.kind === "font_role") {
              const primary = familyNames(tokens, rule.token ?? "")?.[0];
              const outside = declaration.selectors.find(
                (selector) => !selectorIn(selector, rule.only ?? []),
              );
              if (
                primary !== undefined &&
                names.includes(primary) &&
                (outside !== undefined || declaration.selectors.length === 0)
              ) {
                report(
                  rule,
                  source.path,
                  declaration.line,
                  `font « ${primary} » on « ${trim(outside ?? "(no selector)", 40)} »: reserved to ${(rule.only ?? []).join(", ")}`,
                );
              }
            } else {
              const allowed = new Set(
                (rule.allowed ?? []).flatMap((path) => familyNames(tokens, path) ?? []),
              );
              const unknown = names.find(
                (name) => !allowed.has(name) && !GENERIC_FAMILIES.has(name),
              );
              if (declaration.property === "font" && names.length === 0) {
                report(
                  rule,
                  source.path,
                  declaration.line,
                  `${where(declaration)}: family not readable, the rule cannot be verified here`,
                );
              } else if (unknown !== undefined) {
                report(
                  rule,
                  source.path,
                  declaration.line,
                  `font « ${trim(unknown, 30)} » is not one of the declared families`,
                );
              }
            }
          } else if (rule.kind === "radius_scale") {
            if (!/(?:^|-)radius$/.test(declaration.property)) continue;
            const scale = new Set(
              (rule.allowed ?? []).map((item) =>
                (tokens.get(item) ?? item).replace(/\s+/g, "").toLowerCase(),
              ),
            );
            if (value.includes("(")) {
              report(
                rule,
                source.path,
                declaration.line,
                `${where(declaration)}: radius not readable, the rule cannot be verified here`,
              );
              continue;
            }
            for (const length of value.split(/[\s/]+/).filter((part) => part !== "")) {
              const normal = length.toLowerCase();
              if (/^(?:inherit|initial|unset|revert|revert-layer)$/.test(normal)) continue;
              if (/^0(?:px|rem|em|%)?$/.test(normal) || scale.has(normal)) continue;
              report(
                rule,
                source.path,
                declaration.line,
                `radius ${trim(length, 20)} is not on the scale (${[...scale].join(", ")})`,
              );
            }
          } else if (rule.kind === "no_gradient") {
            if (!/gradient\s*\(/i.test(value)) continue;
            const outside = declaration.selectors.find(
              (selector) => !selectorIn(selector, rule.except ?? []),
            );
            if (outside !== undefined || declaration.selectors.length === 0) {
              report(
                rule,
                source.path,
                declaration.line,
                `gradient on « ${trim(outside ?? "(no selector)", 40)} »${(rule.except ?? []).length > 0 ? `, allowed on ${(rule.except ?? []).join(", ")} only` : ""}`,
              );
            }
          }
        }
      }
    }
    // Contrast: the blocks that give both the colour of the text and its background.
    const contrastRules = rules.filter((rule) => rule.kind === "contrast");
    if (contrastRules.length === 0) continue;
    const blocks = new Map<number, Declaration[]>();
    for (const declaration of sheet.declarations) {
      const group = blocks.get(declaration.block);
      if (group === undefined) blocks.set(declaration.block, [declaration]);
      else group.push(declaration);
    }
    for (const group of blocks.values()) {
      const textDeclaration = group.findLast((item) => ["color", "fill"].includes(item.property));
      const backgroundDeclaration = group.findLast((item) =>
        ["background-color", "background"].includes(item.property),
      );
      if (textDeclaration === undefined && backgroundDeclaration === undefined) continue;
      if (textDeclaration === undefined || backgroundDeclaration === undefined) {
        undetermined.set(source.path, (undetermined.get(source.path) ?? 0) + 1);
        continue;
      }
      // The pair is judged under each condition (a dark scheme, a narrow screen...) on its own:
      // a colour given for the dark scheme is never set against a background of the light one.
      const usesVariables = /var\(/i.test(textDeclaration.value + backgroundDeclaration.value);
      const contexts =
        usesVariables && group[0]?.context === ""
          ? customContexts(sheet)
          : [group[0]?.context ?? ""];
      const size = group.findLast((item) => item.property === "font-size")?.value ?? "";
      const weight = group.findLast((item) => item.property === "font-weight")?.value ?? "";
      const px = /^(\d*\.?\d+)px$/.exec(size.trim())?.[1];
      const em = /^(\d*\.?\d+)(?:rem|em)$/.exec(size.trim())?.[1];
      const pixels = px !== undefined ? Number(px) : em !== undefined ? Number(em) * 16 : 0;
      const bold = /^(?:bold|[7-9]00)$/.test(weight.trim());
      const large = pixels >= 24 || (bold && pixels >= 18.66);
      let unsure = false;
      let cut = false;
      for (const context of contexts) {
        const customs = customsIn(sheet, context);
        const colorsOf = (declaration: Declaration) => {
          const variants = valueVariants(declaration.value, customs);
          cut ||= variants.truncated;
          return variants.values.flatMap((value) =>
            /gradient|url\(/i.test(value) ? [] : colorsIn(value, declaration.property).colors,
          );
        };
        const textColors = colorsOf(textDeclaration);
        const backgroundColors = colorsOf(backgroundDeclaration);
        if (textColors.length === 0 || backgroundColors.length === 0) {
          unsure = true;
          continue;
        }
        for (const rule of contrastRules) {
          const base = rule.min ?? CONTRAST_AA;
          const min = large ? Math.round((base / 1.5) * 100) / 100 : base;
          for (const bg of backgroundColors) {
            for (const fg of textColors) {
              if (bg.a < 1) {
                unsure = true;
                continue;
              }
              const ratio = contrastRatio(over(fg, bg), bg);
              if (ratio < min) {
                report(
                  rule,
                  source.path,
                  textDeclaration.line,
                  `text ${hexOf(fg)} on ${hexOf(bg)}: contrast ${ratio.toFixed(2)}:1, minimum ${min}:1${large ? " (large text)" : ""}`,
                );
              }
            }
          }
        }
      }
      if (unsure) undetermined.set(source.path, (undetermined.get(source.path) ?? 0) + 1);
      if (cut) truncated.set(source.path, (truncated.get(source.path) ?? 0) + 1);
    }
  }
  return {
    findings,
    unverifiable,
    undetermined,
    tooDeep,
    truncated,
    declarations: read,
  };
}
