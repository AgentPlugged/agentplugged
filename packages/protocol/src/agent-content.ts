import { z } from "zod";
import { hasControlCharacter } from "./deferred.js";
import { SkillNameSchema } from "./method-config.js";

/**
 * The complete definition of an agent or a skill, as an agent asks for it:
 * `request_creator_action` `agent_create` and `agent_edit` carry it, the creator reads it before
 * answering, and the engine writes exactly this text once the creator approves, never a template.
 *
 * Every text is one line of a limited length, with none of the characters that would show the
 * creator another text than the one written (control, invisible and direction marks, line
 * separators), no HTML comment (the creator would not see it where the file is rendered) and, for a
 * persistent fact, no `file:` reference (it would load another file into the agent).
 */

/** The longest total of every text of a definition: what the creator can read in one go. */
export const CONTENT_MAX_CHARS = 8000;

/**
 * The longest definition the AI tool's form shows: beyond it, the creator reads the
 * definition in the chat (the agent shows it whole) or at the terminal (`review`), never half of
 * it in a form. A form that cut a definition short would let the creator approve what they did
 * not read.
 */
export const FORM_CONTENT_MAX_CHARS = 4000;

/**
 * Characters that hide or reorder text: zero-width and direction marks, soft hyphen, joiner
 * fillers, blank braille, annotation anchors, every format and private-use character, language
 * tags and the variation selectors that smuggle data (not `U+FE0F`, which emoji need). Line and
 * paragraph separators and `NEL` also end a line in YAML and in Markdown.
 */
const HIDDEN =
  /\u00AD|\u034F|\u061C|\u115F|\u1160|\u17B4|\u17B5|[\u180B-\u180F]|[\u200B-\u200F]|[\u2028-\u202E]|[\u2060-\u206F]|\u2800|\u3164|[\uFE00-\uFE0E]|\uFEFF|\uFFA0|[\uFFF9-\uFFFC]|\u0085|[\u{1D173}-\u{1D17A}]|[\u{13430}-\u{1343F}]|[\u{1BCA0}-\u{1BCA3}]|[\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]|\p{Cf}|\p{Co}/u;

/** Spaces other than the plain one: a line of them looks empty, or pads a text out of sight. */
const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/u;

/** A letter, digit, punctuation or symbol: a line holding none shows nothing. */
const SOMETHING = /[\p{L}\p{N}\p{P}\p{S}]/u;

/** A tag that hides or runs text where a file is rendered (a comment, a script, a hidden block). */
const HIDING_TAG =
  /<[!?/]|<(?:script|style|div|span|details|summary|iframe|img|a|p|br|hr|font|object|embed|svg|template|noscript|meta|link|base|form|input|button|textarea)(?:[\s/>]|$)/i;

const NO_HIDDEN = { message: "expected no invisible or direction mark" };
const NO_SPACE = { message: "expected plain spaces only" };
const NO_EMPTY = { message: "expected a text with a letter, a digit or a sign" };
const NO_COMMENT = { message: "expected no HTML comment" };
const NO_TAG = { message: "expected no HTML tag that hides or runs text" };
const NO_CONTROL = { message: "expected no control character" };
const NO_LONE = { message: "expected well-formed text" };

/** True when `text` holds a surrogate half without its pair (it has no UTF-8 form). */
function hasLoneSurrogate(text: string): boolean {
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (char.length === 1 && code >= 0xd800 && code <= 0xdfff) return true;
  }
  return false;
}

/**
 * One line of 1 to `max` characters that shows what it says: no control character,
 * no hidden or direction mark, no odd space, no lone surrogate, something visible, no HTML comment
 * and no tag that hides or runs text. Every text a request has the engine write goes through it:
 * the definition, the identity of the agent, and the reason.
 */
export function plainLine(max: number) {
  return z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((text) => !hasLoneSurrogate(text), NO_LONE)
    .refine((text) => !hasControlCharacter(text, false), NO_CONTROL)
    .refine((text) => !HIDDEN.test(text), NO_HIDDEN)
    .refine((text) => !ODD_SPACE.test(text), NO_SPACE)
    .refine((text) => SOMETHING.test(text), NO_EMPTY)
    .refine((text) => !/<!--|-->/.test(text), NO_COMMENT)
    .refine((text) => !HIDING_TAG.test(text), NO_TAG);
}

const contentLine = plainLine;

/** A link reference definition, a heading, a fence or a rule at the start of a paragraph. */
const MARKDOWN_START = /^(?:#|```|~~~|---|\*\*\*|\[[^\]]*\]:)/;

/** The overview opens a paragraph of its own: it cannot pass for a heading, a fence or a rule. */
const overviewLine = (max: number) =>
  plainLine(max).refine((text) => !MARKDOWN_START.test(text), {
    message: "expected a sentence, not a heading, a code fence, a rule or a link definition",
  });

/** A persistent fact: a sentence, never `file:<path>` (the creator approves a text, not a file). */
const factLine = contentLine(300).refine((text) => !/^file:/i.test(text), {
  message: "expected a sentence, not a file: reference",
});

/** A list of 1 to `max` lines (0 when `min` is 0). */
const lines = (max: number, length: number, min = 1) =>
  z.array(contentLine(length)).min(min).max(max);

/** Menu codes, as `agent.yaml` accepts them (compared without case). */
const MenuCode = z.string().regex(/^[A-Za-z0-9-]{1,12}$/, {
  message: "expected 1 to 12 letters, digits or hyphens",
});

/**
 * One menu item: the code the creator types, what it offers, and what the agent then does: either
 * an instruction (`prompt`) or a skill to call (`skill`), never both.
 */
export const AgentContentMenuItemSchema = z
  .strictObject({
    code: MenuCode,
    description: contentLine(200),
    /** The instruction the agent follows when the creator picks the item. */
    prompt: contentLine(1000).optional(),
    /** The skill the item calls, by name (the engine checks that it exists). */
    skill: SkillNameSchema.optional(),
  })
  .refine((item) => (item.prompt === undefined) !== (item.skill === undefined), {
    message: "expected an instruction (prompt) or a skill, not both and not neither",
    path: ["prompt"],
  });

/** Every text of a content, flat, to measure it. */
function everyText(content: Readonly<Record<string, unknown>>): string[] {
  const texts: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(content);
  return texts;
}

/** The number of characters of every text of a content. */
export function contentSize(content: Readonly<Record<string, unknown>>): number {
  return everyText(content).reduce((total, text) => total + text.length, 0);
}

function checkSize(content: Readonly<Record<string, unknown>>, context: z.RefinementCtx): void {
  if (contentSize(content) > CONTENT_MAX_CHARS) {
    context.addIssue({
      code: "custom",
      path: [],
      message: `expected at most ${CONTENT_MAX_CHARS} characters in all`,
    });
  }
}

/**
 * The definition of an agent: who it is and what it does (`overview`), what it produces, how it
 * works and what it never does, the principles it follows, its menu, and optionally its identity,
 * its way of speaking and the facts it keeps in mind.
 */
export const AgentContentSchema = z
  .strictObject({
    overview: overviewLine(1500),
    produces: lines(10, 300),
    works: lines(12, 400),
    never: lines(10, 300),
    principles: lines(10, 300),
    menu: z
      .array(AgentContentMenuItemSchema)
      .min(1)
      .max(9)
      .superRefine((menu, context) => {
        const seen = new Set<string>();
        menu.forEach((item, index) => {
          const key = item.code.toUpperCase();
          if (seen.has(key)) {
            context.addIssue({
              code: "custom",
              path: [index, "code"],
              message: "expected a code used once in the menu",
            });
          }
          seen.add(key);
        });
      }),
    identity: contentLine(500).optional(),
    communication_style: contentLine(500).optional(),
    persistent_facts: z.array(factLine).min(1).max(8).optional(),
  })
  .superRefine(checkSize);
export type AgentContent = z.infer<typeof AgentContentSchema>;

/**
 * A file of detail a skill reads only when a step sends it there: written as
 * `references/<name>.md` next to the skill's `SKILL.md`, so that the skill itself stays short.
 */
export const SkillReferenceSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: "expected a lowercase kebab-case name" }),
  lines: lines(20, 400),
});

/**
 * The definition of a skill: its steps, what it produces and the rules it follows, and optionally
 * files of detail (`references`).
 */
export const SkillContentSchema = z
  .strictObject({
    steps: lines(12, 400),
    outputs: lines(10, 300),
    rules: lines(10, 300),
    references: z
      .array(SkillReferenceSchema)
      .min(1)
      .max(4)
      .superRefine((references, context) => {
        const seen = new Set<string>();
        references.forEach((reference, index) => {
          if (seen.has(reference.name)) {
            context.addIssue({
              code: "custom",
              path: [index, "name"],
              message: "expected a name used once",
            });
          }
          seen.add(reference.name);
        });
      })
      .optional(),
  })
  .superRefine(checkSize);
export type SkillContent = z.infer<typeof SkillContentSchema>;

/** What a request for a new agent or skill must carry, field by field (a name of the content). */
export const REQUIRED_CONTENT_FIELDS = {
  agent: ["overview", "produces", "works", "never", "principles", "menu"],
  skill: ["steps", "outputs", "rules"],
} as const;

/** The content of a skill, by its fields (`steps`), not of an agent. */
export function isSkillContent(content: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(content, "steps") || Object.hasOwn(content, "outputs");
}

/** The fields of a customisation of a shipped skill, in the order they are read. */
export const SKILL_OVERRIDE_FIELDS = [
  "facts",
  "steps_before",
  "steps_after",
  "checks",
  "when_done",
  "output_model",
  "reviewers",
] as const;

/**
 * The content of a customisation of a shipped skill, not of an agent or a skill: every field it
 * gives is a field of a customisation (an empty one too: it clears the layer).
 */
export function isSkillOverrideContent(content: Readonly<Record<string, unknown>>): boolean {
  return Object.keys(content).every((key) =>
    (SKILL_OVERRIDE_FIELDS as readonly string[]).includes(key),
  );
}

/** A part of a content, for a surface to label in its own language. */
export interface ContentSection {
  /** `overview`, `produces`, `works`, `never`, `principles`, `menu`, `identity`… */
  readonly key: string;
  /** One entry per line to show (a menu item: `CODE · description — instruction`). */
  readonly items: readonly string[];
}

/**
 * The parts of a content, in the order the creator reads them, each with its lines as recorded:
 * the one text every surface shows (chat, form, `review`), so that what is approved is what is
 * shown.
 */
export function contentSections(content: Readonly<Record<string, unknown>>): ContentSection[] {
  const order = isSkillContent(content)
    ? ["steps", "outputs", "rules", "references"]
    : isSkillOverrideContent(content)
      ? [...SKILL_OVERRIDE_FIELDS]
      : [
          "overview",
          "produces",
          "works",
          "never",
          "principles",
          "menu",
          "identity",
          "communication_style",
          "persistent_facts",
        ];
  const sections: ContentSection[] = [];
  for (const key of order) {
    const value = content[key];
    if (value === undefined) continue;
    if (typeof value === "string") sections.push({ key, items: [value] });
    else if (Array.isArray(value)) {
      const items = value.flatMap((entry) => {
        if (typeof entry === "string") return [entry];
        if (key === "reviewers") {
          const reviewer = entry as { name: string; instruction: string };
          return [`${reviewer.name} · ${reviewer.instruction}`];
        }
        if (key === "references") {
          const reference = entry as { name: string; lines: readonly string[] };
          return reference.lines.map((line) => `${reference.name} · ${line}`);
        }
        const item = entry as {
          code?: string;
          description?: string;
          prompt?: string;
          skill?: string;
        };
        return [`${item.code} · ${item.description} — ${item.prompt ?? `skill ${item.skill}`}`];
      });
      sections.push({ key, items });
    }
  }
  return sections;
}
