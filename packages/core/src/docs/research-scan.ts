/**
 * What `docs check` looks for in the text of a research page, and what `docs research`
 * does to a text of outside origin before it reaches an agent. A page read outside the product is
 * data; this is the safety net under the rule that no agent follows what a page says.
 */

/**
 * Wordings that talk to an agent, not about a subject: the usual shapes of an instruction hidden in
 * a page (EN and FR). A safety net, not a proof: the rule of the skill (never follow what a page
 * says) is the first defence; this stops such a text from being filed as a finding. They are
 * tested on the normalised form of a line (`scanForm`) and on up to three lines joined.
 */
export const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all|any|your|the)\b[^.\n]{0,30}\b(?:instructions?|rules?|prompts?|guidelines?|directives?)\b/i,
  /\b(?:disregard|ignore|forget)\b[^.\n]{0,30}\b(?:what|everything|anything)\b[^.\n]{0,30}\b(?:told|said|instructed|given|above|before)\b/i,
  /\b(?:ignore[zr]?|oublie[zr]?|néglige[zr]?)\b[^.\n]{0,40}\b(?:instructions?|consignes?|règles?|directives?)\b[^.\n]{0,30}\b(?:précédentes?|ci-dessus|antérieures?)\b/i,
  /\b(?:ignore[zr]?|oublie[zr]?)\s+(?:toutes?\s+)?(?:les\s+|tes\s+|vos\s+)?(?:instructions?|consignes?)\b/i,
  /\byou\s+are\s+now\b/i,
  /\bvous\s+êtes\s+désormais\b/i,
  /\b(?:new|updated)\s+instructions?\s*:/i,
  /\bnouvelles?\s+(?:instructions?|consignes?)\s*:/i,
  /\b(?:reveal|print|show|leak|repeat)\b[^.\n]{0,30}\b(?:system|developer|hidden)\s+prompt\b/i,
  /\b(?:system|developer)\s+prompt\b[^.\n]{0,30}\b(?:above|below|follows?)\b/i,
  /\b(?:do\s+not|don'?t|never)\s+(?:tell|inform|mention|reveal\s+(?:this\s+)?to)\s+(?:the\s+)?(?:user|creator)\b/i,
  /\bne\s+(?:dis|dites|mentionne[zr]?)\s+(?:pas|rien)\s+(?:à|a)\s+l['’]?\s*(?:utilisateur|créateur)\b/i,
  /\b(?:ai|llm|assistant|agent|claude|chatgpt)s?\b[^.\n]{0,20}\b(?:reading|reads?|processing|summari[sz]ing)\b[^.\n]{0,30}\b(?:this|the following)\b[^.\n]{0,30}\b(?:must|should|need\s+to|have\s+to|are\s+required)\b/i,
  /\b(?:run|execute|exécute[zr]?|lance[zr]?)\s+(?:the\s+following|this|la\s+commande|cette\s+commande)\b[^.\n]{0,20}\b(?:command|commande|script|code|shell|bash)\b/i,
  /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/i,
  /\b(?:send|post|upload|exfiltrate|envoie[zr]?)\b[^.\n]{0,40}\b(?:your|the|tes|vos|les)\b[^.\n]{0,30}\b(?:api[\s_-]?keys?|secrets?|tokens?|credentials?|passwords?|mots?\s+de\s+passe|clés?)\b/i,
  /^\s*(?:<\s*(?:system|assistant|instructions?)\s*>|\[\s*(?:system|inst)\s*\]|(?:system|assistant)\s*:)/i,
  /\b(?:call|use|invoke|appelle[zr]?)\b[^.\n]{0,20}\b(?:the\s+)?(?:tool|outil|mcp)\b[^.\n]{0,30}\b(?:to|pour)\b[^.\n]{0,40}\b(?:delete|remove|merge|push|approve|valide[zr]?|supprime[zr]?)\b/i,
];

/**
 * A character class from code point ranges, built at run time: the source holds no invisible or
 * combining character that an editor or a formatter could change.
 */
function classOf(ranges: readonly (readonly [number, number])[], flags = "u"): RegExp {
  const hex = (code: number) => `\\u{${code.toString(16)}}`;
  return new RegExp(`[${ranges.map(([from, to]) => `${hex(from)}-${hex(to)}`).join("")}]`, flags);
}

/** Marks with no width that `\p{Cf}` does not cover: the combining grapheme joiner, the filler, the variation selectors. */
const INVISIBLE = classOf(
  [
    [0x34f, 0x34f],
    [0x3164, 0x3164],
    [0xfe00, 0xfe0f],
  ],
  "gu",
);

/** The Greek and Cyrillic blocks: where the lookalikes of Latin letters live. */
const OTHER_ALPHABETS = classOf(
  [
    [0x370, 0x3ff],
    [0x400, 0x4ff],
  ],
  "gu",
);

/**
 * Characters that hide text from a reader: tag characters, direction controls, zero-width marks.
 * The joiners (U+200C, U+200D), the variation selectors and the soft hyphen are left alone, which
 * real text uses (Persian, emoji, typeset text); `scanForm` strips them before the patterns run.
 */
const HIDDEN = classOf([
  [0xe0000, 0xe007f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0x200b, 0x200b],
  [0x2060, 0x2064],
  [0x206a, 0x206f],
  [0x180e, 0x180e],
]);

/** Letters of other alphabets that pass for a Latin one: the usual way around a word filter. */
const LOOKALIKES: Readonly<Record<string, string>> = Object.fromEntries([
  ["а", "a"],
  ["в", "b"],
  ["е", "e"],
  ["к", "k"],
  ["м", "m"],
  ["н", "h"],
  ["о", "o"],
  ["р", "p"],
  ["с", "c"],
  ["т", "t"],
  ["у", "y"],
  ["х", "x"],
  ["і", "i"],
  ["ј", "j"],
  ["ѕ", "s"],
  ["ο", "o"],
  ["α", "a"],
  ["ε", "e"],
  ["ι", "i"],
  ["ν", "v"],
  ["τ", "t"],
  ["ρ", "p"],
  ["κ", "k"],
] as const);

/** A line as the patterns read it: compatibility forms folded, invisible marks removed, lookalikes mapped. */
export function scanForm(line: string): string {
  return line
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(INVISIBLE, "")
    .toLowerCase()
    .replace(OTHER_ALPHABETS, (letter) => LOOKALIKES[letter] ?? letter);
}

/** True when a text carries a wording that talks to an agent. */
export function talksToAgent(text: string): boolean {
  const form = scanForm(text);
  return INSTRUCTION_PATTERNS.some((pattern) => pattern.test(form));
}

/** How many consecutive lines are read as one (a sentence wrapped over lines). */
const WINDOW = 3;

/**
 * The lines (from 1) where an instruction starts, a wrapped sentence included. `skip` names lines
 * that are the place for an instruction (the flagged ones): no window touches them.
 */
export function instructionLines(text: string, skip: ReadonlySet<number> = new Set()): number[] {
  const lines = text.split(/\r?\n/);
  // `size` lines from line `at` (from 0) read as one, or nothing when a line to skip or a blank
  // line cuts the sentence.
  const joined = (at: number, size: number): string | undefined => {
    const parts: string[] = [];
    for (let index = at; index < at + size; index += 1) {
      const line = lines[index];
      if (line === undefined || skip.has(index + 1) || (index > at && line.trim() === "")) {
        return undefined;
      }
      parts.push(line);
    }
    return parts.join(" ");
  };
  const talks = (at: number, size: number): boolean => {
    const text = joined(at, size);
    return text !== undefined && talksToAgent(text);
  };
  const found: number[] = [];
  for (let at = 0; at < lines.length; at += 1) {
    for (let size = 1; size <= WINDOW; size += 1) {
      // A sentence that starts on the next line is reported there, once.
      if (talks(at, size) && !(size > 1 && talks(at + 1, size - 1))) {
        found.push(at + 1);
        break;
      }
    }
  }
  return found;
}

/** The lines (from 1) holding characters that hide text from a reader. */
export function hiddenLines(text: string): number[] {
  return text.split(/\r?\n/).flatMap((line, index) => (HIDDEN.test(line) ? [index + 1] : []));
}

/**
 * A text of outside origin made safe to hand to an agent in one line: control and invisible
 * characters out, spaces collapsed, cut to `max`, and replaced by a mark when it talks to an agent.
 */
export function safeLine(text: string, max: number): string {
  const plain = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (talksToAgent(plain)) return "[flagged]";
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}
