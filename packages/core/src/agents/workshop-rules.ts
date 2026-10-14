import { type AgentContent, isSkillContent, type SkillContent } from "@agentplugged/protocol";
import type { DefinitionKind } from "../method/definitions.js";
import { REFERENCES_DIR } from "./content-render.js";
import { displayName } from "./templates.js";

/**
 * The rules of the workshop, pure: what the engine checks in an agent or a skill the
 * creator adds, before it writes a file (`agent create` and `agent edit` with a definition), when
 * it analyses one that exists, and when it runs the small suite of verifications of a creation. One
 * place holds them, so a creation, an analysis and a verification never disagree.
 *
 * The method shipped with the engine is never an input that changes: a creator's agent is a folder
 * of their own, and a customisation of a shipped agent only adds (see `overrides.ts`).
 */

/** Longest description a name-and-description list may carry: it is read at every request. */
export const DESCRIPTION_CAP = 180;

/** Longest body (`SKILL.md` as an agent or a session reads it) before it is split. */
export const BODY_CAP = 16_700;

/** One token is about four characters (a working hypothesis). */
export const CHARS_PER_TOKEN = 4;

/** The most findings or problems one answer lists: the creator reads a few lines, not a report. */
export const MAX_LISTED = 12;

export type WorkshopRule =
  | "name_taken"
  | "display_name_taken"
  | "field_missing"
  | "description_too_long"
  | "trigger_missing"
  | "unsafe_instruction"
  | "skill_unknown"
  | "reference_unknown"
  | "reference_unused"
  | "body_too_large"
  | "body_heavy"
  | "section_missing"
  | "menu_prompt_long"
  | "description_overlap"
  | "persona_thin"
  | "override_invalid"
  | "override_too_large";

/** What is wrong, where, and in a few words how. */
export interface Problem {
  readonly rule: WorkshopRule;
  /** The field it concerns: `description`, `content.menu.1.prompt`, `id`… */
  readonly field: string;
  readonly detail: string;
}

/** What the engine already knows of the product when it judges a draft. */
export interface Known {
  /** Identifiers taken by an agent or a skill (shipped, catalog, installed). */
  readonly taken: ReadonlySet<string>;
  /** Display name (lower case) of each agent, by agent id. */
  readonly agentNames: ReadonlyMap<string, string>;
  /** The skills an agent's menu may call (active ones). */
  readonly skills: ReadonlySet<string>;
}

/** What the creator gives for an addition. */
export interface Draft {
  readonly kind: DefinitionKind;
  readonly id: string;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly domain?: string | undefined;
  readonly phase?: string | undefined;
  readonly icon?: string | undefined;
  readonly role?: string | undefined;
  readonly content: AgentContent | SkillContent;
}

// ---------------------------------------------------------------------------------------------
// Texts

interface Text {
  readonly field: string;
  readonly text: string;
}

/**
 * The texts of a definition that tell the agent what to do, with their field: everything except
 * the lines of « never » (they forbid, and may name what they forbid).
 */
export function instructionTexts(content: AgentContent | SkillContent): Text[] {
  const texts: Text[] = [];
  const list = (field: string, lines: readonly string[] | undefined) => {
    for (const [index, text] of (lines ?? []).entries()) {
      texts.push({ field: `content.${field}.${index}`, text });
    }
  };
  if (isSkillContent(content as Record<string, unknown>)) {
    const skill = content as SkillContent;
    list("steps", skill.steps);
    list("outputs", skill.outputs);
    list("rules", skill.rules);
    for (const [index, reference] of (skill.references ?? []).entries()) {
      list(`references.${index}.lines`, reference.lines);
    }
    return texts;
  }
  const agent = content as AgentContent;
  texts.push({ field: "content.overview", text: agent.overview });
  list("produces", agent.produces);
  list("works", agent.works);
  list("principles", agent.principles);
  list("persistent_facts", agent.persistent_facts);
  if (agent.identity !== undefined) texts.push({ field: "content.identity", text: agent.identity });
  if (agent.communication_style !== undefined) {
    texts.push({ field: "content.communication_style", text: agent.communication_style });
  }
  for (const [index, item] of agent.menu.entries()) {
    texts.push({ field: `content.menu.${index}.description`, text: item.description });
    if (item.prompt !== undefined) {
      texts.push({ field: `content.menu.${index}.prompt`, text: item.prompt });
    }
  }
  return texts;
}

// ---------------------------------------------------------------------------------------------
// Safety: an addition cannot tell its agent to go round a rule

/** A way of going round a rule of the method, in English and in French. */
interface Unsafe {
  readonly id: string;
  readonly pattern: RegExp;
  /** False when « never » or « jamais » in the sentence does not make it harmless. */
  readonly negatable: boolean;
}

const RULES_WORDS =
  "rules?|instructions?|guardrails?|safeguards?|safety|security|permissions?|hooks?|checkpoints?|approvals?|validations?|reviews?|AGENTS\\.md|constitution|règles?|consignes?|sécurité|garde-fous|validations?|relectures?|accords?|points? de validation";

/**
 * What a definition must never tell its agent: go round the rules, the creator's word, the
 * secrets or the repository's protections. A floor, not a proof: the rules themselves (AGENTS.md,
 * the hooks, the permissions, the publication boundary) are written by `sync`, outside any text of
 * the creator's, so an addition can only add to the agent's instructions, never take a rule away.
 */
const UNSAFE: readonly Unsafe[] = [
  {
    id: "goes round the rules (ignore, bypass, disable or skip a rule, a review or an approval)",
    pattern: new RegExp(
      `\\b(?:ignor\\w*|disregard\\w*|forget\\w*|bypass\\w*|overrid\\w*|disabl\\w*|skip\\w*|circumvent\\w*|turn(?:s|ing)? off|switch\\w* off|contourn\\w*|désactiv\\w*|outrepass\\w*|saut\\w*|passe\\w* outre)\\b[^.\\n]{0,60}(?<![\\p{L}\\p{N}])(?:${RULES_WORDS})(?![\\p{L}\\p{N}])`,
      "iu",
    ),
    negatable: true,
  },
  {
    id: "acts without the creator's word (without asking them, their approval, confirmation or review)",
    pattern:
      /\bwithout\s+(?:asking\s+(?:the\s+creator|them|first|for\s+(?:approval|permission|confirmation))|(?:telling|checking\s+with)\s+the\s+creator|(?:the\s+)?(?:creator'?s?\s+)?(?:approval|permission|consent|confirmation|validation|review))\b|\bsans\s+(?:demander\s+(?:(?:l['’]\s*)?(?:accord|autorisation|permission|confirmation)|au\s+cr[ée]ateur|d['’]abord)|(?:en\s+parler\s+au|pr[ée]venir\s+le)\s+cr[ée]ateur|(?:l['’]\s*)?(?:accord|autorisation|validation|confirmation|relecture))/iu,
    negatable: true,
  },
  {
    id: "runs a command that breaks a protection (force push, skipped hooks, push to the main branch, destructive or piped shell)",
    pattern:
      /--force\b|--no-verify\b|\bpush\b[^.\n]{0,30}\b(?:main|master)\b|\brm\s+-rf\b|\bsudo\b|\bchmod\s+777\b|\bcurl\b[^|\n]*\|\s*(?:sh|bash)\b|\bgit\s+reset\s+--hard\b|\bgit\s+push\b[^.\n]*\s-f\b|\bpush\b[^.\n]{0,40}\s\+[\w/-]+/iu,
    negatable: true,
  },
  {
    id: "reads, shows or sends a secret (key, token, password, .env, credentials)",
    pattern:
      /\b(?:read|open|print|show|display|send|share|copy|log|upload|dump|lis|lire|ouvr\w+|affich\w+|envoi\w*|partag\w+|copi\w+)\b[^.\n]{0,50}(?:\.env\b|\bsecrets?\b|\bpasswords?\b|mots? de passe|\bapi[ _-]?keys?\b|\bcl[ée]s? (?:priv[ée]e|api|secr[èe]te)|\bprivate keys?\b|\btokens?\b|\bjetons?\b|\bcredentials?\b|\bidentifiants?\b)/iu,
    negatable: true,
  },
  {
    id: "publishes, sends or pays by itself, on the creator's behalf",
    pattern:
      /\b(?:publish\w*|post\w*|send\w*|e-?mail\w*|tweet\w*|pay\w*|purchas\w*|buy\w*|book\w*|deploy\w*|publie\w*|envoi\w*|envoie\w*|poste\w*|paie\w*|pay[eé]\w*|ach[eè]te\w*|d[ée]ploie\w*)\b[^.\n]{0,60}\b(?:automatically|on (?:the )?creator'?s behalf|on their behalf|by (?:it|him|her)self|automatiquement|[àa] la place|lui-m[êe]me|elle-m[êe]me|toute seule?)\b/iu,
    negatable: true,
  },
  {
    id: "decides or answers in place of the creator (approves a point, a checkpoint or a gesture itself)",
    pattern:
      /\b(?:approv\w*|validat\w*|accept\w*|decid\w*|answer\w*|confirm\w*|waiv\w*|sign\w*)\b[^.\n]{0,40}\b(?:on behalf of|in place of|instead of|for) the creator\b|\b(?:approv\w*|validat\w*|answer\w*)\b[^.\n]{0,30}\b(?:it|them|the checkpoint|the point)\s+(?:yourself|itself|himself|herself)\b|\b(?:valid\w*|approuv\w*|d[ée]cid\w*|r[ée]pond\w*)\b[^.\n]{0,40}(?:[àa] la place du cr[ée]ateur|[àa] sa place|toi-m[êe]me|lui-m[êe]me|elle-m[êe]me)|\b(?:approv\w*|accept\w*|waiv\w*|valid\w*)\b[^.\n]{0,40}\b(?:automatically|systematically|always|by default|yourself|automatiquement|syst[ée]matiquement|toujours)\b|\b(?:mark|treat|consider|count|record|set)\w*\b[^.\n]{0,30}\b(?:checkpoints?|reviews?|approvals?|validations?)\b[^.\n]{0,30}\b(?:approved|passed|validated|accepted)\b[^.\n]{0,40}\b(?:automatically|systematically|always|every|all|yourself)\b/iu,
    negatable: true,
  },
  {
    id: "changes a protected file (AGENTS.md, the hooks, the settings of an AI tool, the method's own files)",
    pattern:
      /\b(?:edit\w*|modif\w*|chang\w*|rewrit\w*|overwrit\w*|delet\w*|remov\w*|truncat\w*|patch\w*|replac\w*|append\w*|[ée]dit\w*|[ée]cri\w*|supprim\w*|remplac\w*|r[ée][ée]cri\w*)\b[^.\n]{0,40}(?:AGENTS\.md|CLAUDE\.md|GEMINI\.md|\.claude\/(?:settings|hooks)|settings(?:\.local)?\.json|\.codex\/|\.cursor\/|\.gemini\/|\.git\/hooks|\.agentplugged\/(?:method\.yaml|overrides|agents|skills|\.gitignore))/iu,
    negatable: true,
  },
  {
    id: "stops asking or waiting for the creator (no more validation, approval or review)",
    pattern:
      /\b(?:stop|cease|quit)\s+(?:asking|waiting|checking|verifying|requesting)\b[^.\n]{0,40}\b(?:creators?|validations?|approvals?|permissions?|reviews?)\b|\b(?:no longer|no more|no need to)\s+(?:ask|wait|check|verif|request)\w*\b[^.\n]{0,40}\b(?:creators?|validations?|approvals?|permissions?|reviews?)\b|\b(?:arr[êe]te\w*\s+de|plus besoin de)\s+(?:demander|v[ée]rifier|attendre)\b[^.\n]{0,40}\b(?:cr[ée]ateurs?|validations?|accords?|permissions?|relectures?)/iu,
    negatable: true,
  },
  {
    id: "hides something from the creator",
    pattern:
      /\b(?:do not|don't|never)\s+(?:tell|mention|show|inform)\b[^.\n]{0,30}\bcreator\b|\bhide\b[^.\n]{0,30}\bfrom the creator\b|\b(?:keep|conceal)\b[^.\n]{0,30}\b(?:secret|hidden) from the creator\b|\bne (?:le )?dis(?:ez)? (?:pas|rien) au cr[ée]ateur\b|\bcache\w*\b[^.\n]{0,30}\bau cr[ée]ateur\b/iu,
    negatable: false,
  },
];

/**
 * A word of refusal in a clause: « never run git push --force » or « aucune liste partagée sans
 * accord » forbid, they do not instruct. Read clause by clause, so a « not » in one clause does not
 * excuse an instruction in the next.
 */
const NEGATION =
  /(?<![\w-])(?:never|not|none|nothing|nobody|cannot|can't|nor|refus\w*|declin\w*|forbid\w*|prohibit\w*|avoid\w*|jamais|interdi\w*|[ée]vit\w*|ne|aucun\w*|ni|rien|personne)(?![\w-])|(?<!\w)n['’]|n't\b/iu;

/**
 * A clause that goes on a list (« you never run gh, glab, a pull request or a push ») and not on a
 * new instruction: it starts with a link word, a noun marker or a quoted name, not with a verb.
 */
const CONTINUES =
  /^\s*(?:(?:or|nor|ou|ni|a|an|the|your|his|her|its|any|un|une|le|la|les|ton|ta|tes|son|sa|ses|votre)(?=\s)|`)/iu;

/** « do not hesitate to », « n'hésite pas à »: a push to act, not a refusal. */
const HESITATE =
  /\b(?:(?:do not|don't|must not|never)\s+hesitate\s+(?:to\s+)?|n['’]h[ée]site\w*\s+pas\s+(?:[àa]\s+)?)/giu;

/** A word that mixes Latin letters with Cyrillic or Greek ones. */
const MIXED_ALPHABETS = /(?=\S*\p{Script=Latin})(?=\S*[\p{Script=Cyrillic}\p{Script=Greek}])\S+/u;

interface Clause {
  readonly text: string;
  /** A word of refusal is in it, or in the clause before it that it goes on. */
  readonly negated: boolean;
}

/**
 * The clauses of a line. A full stop, a semicolon, a colon, a dash, a line break or a « but » ends a
 * sentence; a comma or a bracket ends a clause. A refusal reaches the clauses that go on its list
 * and stops at the first that starts a new instruction (« do not wait, skip the review »).
 */
function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  for (const sentence of text.split(
    /[.!?]+(?=\s|$)|[;\n]+|:\s+|\s[—–]\s+|\s+(?:but|however|then|mais|puis)\s+/iu,
  )) {
    let carried = false;
    for (const clause of sentence.split(/[,()]+/u)) {
      if (clause.trim() === "") continue;
      const negated: boolean = NEGATION.test(clause) || (carried && CONTINUES.test(clause));
      carried = negated;
      out.push({ text: clause, negated });
    }
  }
  return out;
}

/** The problems a text holds: one per kind of instruction that goes round a rule. */
export function unsafeProblems(texts: readonly Text[]): Problem[] {
  const problems: Problem[] = [];
  for (const { field, text: raw } of texts) {
    // Full-width and compatibility forms are read as the letters they imitate; « do not hesitate to »
    // and « n'hésite pas à » encourage, they do not forbid.
    const text = raw.normalize("NFKC").replace(HESITATE, " ");
    if (MIXED_ALPHABETS.test(text)) {
      problems.push({
        rule: "unsafe_instruction",
        field,
        detail: "a word mixes alphabets (Latin with Cyrillic or Greek): it hides what it says",
      });
    }
    for (const { text: sentence, negated } of clauses(text)) {
      for (const rule of UNSAFE) {
        if (!rule.pattern.test(sentence)) continue;
        if (rule.negatable && negated) continue;
        const quote = sentence.length > 80 ? `${sentence.slice(0, 77)}...` : sentence;
        problems.push({
          rule: "unsafe_instruction",
          field,
          detail: `${rule.id}: « ${quote.trim()} »`,
        });
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// The description: the only part read at every request

/** Words that say when a description is called (or by whom): « for », « when », « run by »… */
const TRIGGER_MARKERS =
  /\b(?:when|whenever|if|for|during|before|after|once|while|run by|called by|used by|on request|quand|lorsque|si|pour|pendant|avant|apr[èe]s|d[èe]s|une fois|lanc[ée]e? par|appel[ée]e? par|à la demande)\b/iu;

/** A description is a sentence, not a label: at least four words (the engine refuses less). */
export function hasTrigger(description: string): boolean {
  return description.trim().split(/\s+/u).filter(Boolean).length >= 4;
}

/** True when the description says when it is called (a situation, a phase, who runs it). */
export function namesWhen(description: string): boolean {
  return TRIGGER_MARKERS.test(description);
}

/** Words too common to tell two descriptions apart. */
const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "when",
  "agent",
  "skill",
  "creator",
  "les",
  "des",
  "une",
  "pour",
  "dans",
  "avec",
  "que",
  "qui",
  "sur",
  "par",
  "est",
  "son",
  "ses",
]);

/** The significant words of a text: lower case, four letters or more, not a common word. */
export function significantWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [];
  return new Set(words.filter((word) => !STOP.has(word)));
}

/** Share of the words two texts have in common, over the smaller of the two (0 to 1). */
export function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const word of a) if (b.has(word)) common += 1;
  return common / Math.min(a.size, b.size);
}

/** Descriptions this close are read as one by the model that chooses: sharpen their triggers. */
export const OVERLAP_LIMIT = 0.6;

// ---------------------------------------------------------------------------------------------
// Links

/** The `references/<file>.md` a text names (a step sends the skill there). */
export function referencesNamed(text: string): string[] {
  // A path that goes through another folder (`.agentplugged/skills/x/references/y.md`) is not ours.
  const pattern = new RegExp(`(?<![\\w/.-])${REFERENCES_DIR}/([a-z0-9][a-z0-9-]*)\\.md`, "gu");
  return [...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

// ---------------------------------------------------------------------------------------------
// The draft

/** What an addition costs, in characters and tokens. */
export interface Cost {
  /** Name and description: listed at every request of every session. */
  readonly loaded_chars: number;
  readonly loaded_tokens: number;
  /** The body, as a session reads it: only the session that runs it pays it. */
  readonly body_chars: number;
  readonly body_tokens: number;
}

const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/** The cost of an addition from its id, its description and the size of its rendered body. */
export function costOf(id: string, description: string | undefined, bodyChars: number): Cost {
  const loaded = id.length + (description ?? "").length;
  return {
    loaded_chars: loaded,
    loaded_tokens: tokens(loaded),
    body_chars: bodyChars,
    body_tokens: tokens(bodyChars),
  };
}

/** The problem of a body over the ceiling, as a list of zero or one. */
export function bodyProblems(bodyChars: number): Problem[] {
  return bodyChars <= BODY_CAP
    ? []
    : [
        {
          rule: "body_too_large",
          field: "content",
          detail: `${bodyChars} characters once rendered, at most ${BODY_CAP}: move detail to references`,
        },
      ];
}

/** The field and its rule, for a field a creation cannot do without. */
const REQUIRED: Readonly<Record<DefinitionKind, readonly string[]>> = {
  agent: ["title", "description", "domain", "phase"],
  skill: ["description"],
};

/**
 * Everything wrong with an addition, at once (not the first fault only): the creator or the agent
 * fixes the list in one go. Empty: the engine accepts it.
 */
export function draftProblems(
  draft: Draft,
  known: Known,
  /** `edit` completes a thing that exists: its identity is not what changes. */
  scope: "create" | "edit" = "create",
): Problem[] {
  return [
    ...(scope === "create" ? identityProblems(draft, known) : []),
    ...contentProblems(draft, known),
  ];
}

/** A display name compared without case, accents or margins (« Irıs » and « iris » collide). */
function plainName(name: string): string {
  return name.trim().normalize("NFKD").replace(/\p{M}/gu, "").replace(/ı/g, "i").toLowerCase();
}

/** The name, the fields and the description (the part read at every request). */
function identityProblems(draft: Draft, known: Known): Problem[] {
  const problems: Problem[] = [];
  const add = (rule: WorkshopRule, field: string, detail: string) =>
    problems.push({ rule, field, detail });

  if (known.taken.has(draft.id)) {
    add("name_taken", "id", `"${draft.id}" is already used by an agent or a skill`);
  }
  if (draft.kind === "agent") {
    const shown = plainName(draft.name ?? displayName(draft.id));
    for (const [id, name] of known.agentNames) {
      if (plainName(name) === shown || id === shown) {
        add("display_name_taken", "name", `"${shown}" is the name of the agent ${id}`);
        break;
      }
    }
  }
  const given = draft as unknown as Record<string, unknown>;
  for (const field of REQUIRED[draft.kind]) {
    const value = given[field];
    if (typeof value !== "string" || value.trim() === "") {
      add("field_missing", field, `give the ${field}`);
    }
  }
  problems.push(
    ...unsafeProblems(
      (["name", "title", "description", "role"] as const).flatMap((field) => {
        const text = draft[field];
        return text === undefined ? [] : [{ field, text }];
      }),
    ),
  );
  const description = draft.description?.trim() ?? "";
  if (description !== "") {
    if (description.length > DESCRIPTION_CAP) {
      add(
        "description_too_long",
        "description",
        `${description.length} characters, at most ${DESCRIPTION_CAP} (it is listed at every request)`,
      );
    }
    if (!hasTrigger(description)) {
      add(
        "trigger_missing",
        "description",
        "say in at least four words what it is for and when it is called (the situation, the phase, who runs it)",
      );
    }
  }
  return problems;
}

/** The definition itself: safe instructions, skills that exist, references that exist. */
function contentProblems(draft: Draft, known: Known): Problem[] {
  const problems: Problem[] = [];
  const add = (rule: WorkshopRule, field: string, detail: string) =>
    problems.push({ rule, field, detail });
  problems.push(...unsafeProblems(instructionTexts(draft.content)));

  if (draft.kind === "agent") {
    const agent = draft.content as AgentContent;
    for (const [index, item] of agent.menu.entries()) {
      if (item.skill !== undefined && !known.skills.has(item.skill)) {
        add(
          "skill_unknown",
          `content.menu.${index}.skill`,
          `no active skill named "${item.skill}"`,
        );
      }
    }
  }
  const declared = new Set(
    isSkillContent(draft.content as Record<string, unknown>)
      ? ((draft.content as SkillContent).references ?? []).map((reference) => reference.name)
      : [],
  );
  const cited = new Set<string>();
  for (const { field, text } of instructionTexts(draft.content)) {
    if (field.includes(".references.")) continue;
    for (const name of referencesNamed(text)) {
      cited.add(name);
      if (!declared.has(name)) {
        add("reference_unknown", field, `${REFERENCES_DIR}/${name}.md does not exist`);
      }
    }
  }
  for (const name of declared) {
    if (!cited.has(name)) {
      add(
        "reference_unused",
        `content.references.${name}`,
        `no step sends to ${REFERENCES_DIR}/${name}.md: name it where it is needed, or drop it`,
      );
    }
  }
  return problems;
}

/** The refusal's list, one line per problem. */
export function listProblems(problems: readonly Problem[]): string {
  const shown = problems.slice(0, MAX_LISTED).map((p) => `${p.field}: ${p.detail}`);
  if (problems.length > MAX_LISTED) shown.push(`and ${problems.length - MAX_LISTED} more`);
  return shown.join(" | ");
}
