/**
 * Colours for the fixed rules of the brand, as pure functions: reading a CSS colour
 * into red, green, blue and alpha, and the contrast ratio of WCAG 2. Only the forms that can be
 * read exactly are read: hexadecimal, `rgb()`, `hsl()` and the names of CSS. Anything else
 * (`oklch()`, `color-mix()`, `lab()`…) is `undefined`, and the rules say so rather than guess.
 */

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

// The 148 colour names of CSS, as "name:rrggbb" (hex without the sign).
const NAMED =
  "aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc " +
  "bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a " +
  "burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 " +
  "cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff darkblue:00008b " +
  "darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkgrey:a9a9a9 " +
  "darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 " +
  "darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b " +
  "darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 " +
  "deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dimgrey:696969 dodgerblue:1e90ff " +
  "firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc " +
  "ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f " +
  "grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 " +
  "khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd " +
  "lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 " +
  "lightgray:d3d3d3 lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a " +
  "lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightslategrey:778899 " +
  "lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 " +
  "magenta:ff00ff maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 " +
  "mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a " +
  "mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa " +
  "mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 " +
  "olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa " +
  "palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 " +
  "peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 " +
  "rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 " +
  "salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d " +
  "silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 slategrey:708090 " +
  "snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 " +
  "tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 " +
  "yellow:ffff00 yellowgreen:9acd32";

const NAMES: ReadonlyMap<string, string> = new Map(
  NAMED.split(" ").map((entry) => entry.split(":") as [string, string]),
);

/** Words that stand for "no colour of their own": a rule has nothing to check on them. */
export const NEUTRAL_COLOR_WORDS: ReadonlySet<string> = new Set([
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  "revert-layer",
  "none",
]);

/** True for a colour name of CSS. */
export function isColorName(word: string): boolean {
  return NAMES.has(word.toLowerCase());
}

const clamp = (value: number, max: number) => Math.min(max, Math.max(0, value));

function fromHex(digits: string): Rgba | undefined {
  if (!/^[0-9a-f]+$/i.test(digits)) return undefined;
  const full =
    digits.length === 3 || digits.length === 4
      ? [...digits].map((digit) => digit + digit).join("")
      : digits;
  if (full.length !== 6 && full.length !== 8) return undefined;
  const byte = (at: number) => Number.parseInt(full.slice(at, at + 2), 16);
  return { r: byte(0), g: byte(2), b: byte(4), a: full.length === 8 ? byte(6) / 255 : 1 };
}

/** A number or a percentage of `scale`. */
function component(text: string, scale: number): number | undefined {
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(%?)$/.exec(text.trim());
  if (match === null) return undefined;
  const value = Number(match[1]);
  return match[2] === "%" ? (value / 100) * scale : value;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue = (((h % 360) + 360) % 360) / 360;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => {
    const k = (n + hue * 12) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0) * 255, channel(8) * 255, channel(4) * 255];
}

/**
 * The colour a CSS value spells, or undefined when it spells none that can be read exactly. The
 * value is one colour (no other word), as `#FF7A2E`, `rgb(255 122 46 / 50%)`, `hsl(…)`, `coral`.
 */
export function parseColor(value: string): Rgba | undefined {
  const text = value.trim().toLowerCase();
  if (text.startsWith("#")) return fromHex(text.slice(1));
  if (text === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const named = NAMES.get(text);
  if (named !== undefined) return fromHex(named);
  const call = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(text);
  if (call === null) return undefined;
  const parts = (call[2] ?? "").split(/\s*[,/]\s*|\s+/).filter((part) => part !== "");
  if (parts.length < 3 || parts.length > 4) return undefined;
  const alpha = parts[3] === undefined ? 1 : component(parts[3], 1);
  if (alpha === undefined) return undefined;
  if (call[1]?.startsWith("rgb")) {
    const [r, g, b] = [0, 1, 2].map((at) => component(parts[at] ?? "", 255));
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return {
      r: clamp(Math.round(r), 255),
      g: clamp(Math.round(g), 255),
      b: clamp(Math.round(b), 255),
      a: clamp(alpha, 1),
    };
  }
  if (!/^[+-]?[\d.]+(?:deg)?$/.test(parts[0] ?? "")) return undefined;
  const hue = Number.parseFloat(parts[0] ?? "");
  const s = component(parts[1] ?? "", 1);
  const l = component(parts[2] ?? "", 1);
  if (s === undefined || l === undefined || !(parts[1] ?? "").endsWith("%")) return undefined;
  if (!(parts[2] ?? "").endsWith("%")) return undefined;
  const [r, g, b] = hslToRgb(hue, clamp(s, 1), clamp(l, 1));
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: clamp(alpha, 1) };
}

/** The colour as `#rrggbb`, its alpha left out: two colours of one hue compare equal. */
export function hexOf(color: Rgba): string {
  const byte = (value: number) => value.toString(16).padStart(2, "0");
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

/** The colour of `top` laid over an opaque `bottom`. */
export function over(top: Rgba, bottom: Rgba): Rgba {
  const mix = (a: number, b: number) => Math.round(a * top.a + b * (1 - top.a));
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a: 1 };
}

function luminance(color: Rgba): number {
  const linear = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** The contrast ratio of two opaque colours (WCAG 2, from 1 to 21). */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}
