import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { NodeWorkspaceFiles } from "@agentplugged/adapters-git";
import { type Definition, readDefinitions, renderConstitutionReference } from "@agentplugged/core";
import { beforeAll, describe, expect, it } from "vitest";
import { withNoah } from "./__helpers__/noah-text.js";
import { SHARED_RULES_POINTER, sharedRules } from "./__helpers__/shared-rules.js";

/**
 * The whole team says « tu » to the creator, a question of choice waits for its open
 * point, a plain approval chooses the recommendation, and a finished document is validated once.
 */
const methodDir = dirname(
  createRequire(import.meta.url).resolve("@agentplugged/method/package.json"),
);

const flat = (text: string) => text.replace(/\s+/g, " ");
const read = withNoah(
  methodDir,
  (path: string) => flat(readFileSync(join(methodDir, path), "utf8")),
  flat,
);

/** Every text file of the method (Markdown, YAML, templates), with its absolute path. */
function methodFiles(dir = methodDir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : methodFiles(path);
    return /\.(md|ya?ml|tmpl)$/.test(entry.name) ? [path] : [];
  });
}

/** The formal forms of address: « vous », « votre », « vos », and « dites-vous » and the like. */
const FORMAL_PRONOUNS = /(?<!\p{L})(vous|votre|vos|vôtre|vôtres)(?!\p{L})|-vous(?!\p{L})/iu;

/** A word in `-ez` (formal imperative or present): « dites », « pouvez » are caught as « -ez ». */
const EZ_WORD = /(?<!\p{L})\p{L}{2,}ez(?!\p{L})/giu;
/** The formal verbs without the `-ez` ending. */
const IRREGULAR_FORMAL_VERBS = /(?<!\p{L})(dites|êtes|faites)(?!\p{L})/iu;
/** Words that end in `-ez` and are not a formal verb. */
const NOT_VERBS = new Set(["chez", "assez", "nez", "rez", "lez", "suez", "gonzalez", "alvarez"]);

/** The French examples of a text: what is between « … », or between straight quotes. */
function examples(text: string): string[] {
  return [
    ...[...text.matchAll(/«([^»]*)»/gu)].map((match) => match[1] ?? ""),
    ...[...text.matchAll(/"([^"]*)"/gu)].map((match) => match[1] ?? ""),
  ];
}

/** The formal verbs an example contains. */
function formalVerbs(example: string): string[] {
  const regular = (example.match(EZ_WORD) ?? []).filter(
    (word) => !NOT_VERBS.has(word.toLowerCase()),
  );
  const irregular = example.match(new RegExp(IRREGULAR_FORMAL_VERBS, "giu")) ?? [];
  return [...regular, ...irregular];
}

/** What is wrong with `text` when it addresses the creator formally, else an empty list. */
function vouvoiements(text: string): string[] {
  const found: string[] = [];
  const pronoun = FORMAL_PRONOUNS.exec(text);
  if (pronoun !== null) found.push(pronoun[0]);
  for (const example of examples(text)) found.push(...formalVerbs(example));
  return found;
}

/** The one sentence that names the forbidden forms, to forbid them. */
const FORBIDDEN_FORMS_RULE = "never « vous », « votre » nor « vos »";

let skills: Definition[];
let agents: Definition[];

beforeAll(async () => {
  const source = new NodeWorkspaceFiles(methodDir);
  const shippedSkills = await readDefinitions(source, "skills", "skill");
  const shippedAgents = await readDefinitions(source, "agents", "agent");
  if (!Array.isArray(shippedSkills) || !Array.isArray(shippedAgents)) {
    throw new Error("invalid shipped method");
  }
  skills = shippedSkills;
  agents = shippedAgents;
});

describe("no text of the method addresses the creator with « vous »", () => {
  it("reads the whole method, templates included", () => {
    const files = methodFiles();
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((file) => file.endsWith(join("maya", "agent.yaml")))).toBe(true);
    expect(files.some((file) => file.endsWith(".tmpl"))).toBe(true);
  });

  it("finds no « vous » nor formal verb in any file of method/", () => {
    for (const file of methodFiles()) {
      const text = flat(readFileSync(file, "utf8"));
      expect(vouvoiements(text), relative(methodDir, file)).toEqual([]);
    }
  });

  it("finds none either in the constitution the engine generates", () => {
    for (const text of [
      renderConstitutionReference(),
      renderConstitutionReference([], undefined, { tools: ["claude-code", "codex"] }),
    ]) {
      const french = flat(text).split(FORBIDDEN_FORMS_RULE).join("");
      expect(vouvoiements(french)).toEqual([]);
    }
  });

  it("catches a formal address, whatever the quotes", () => {
    for (const text of [
      "Qu'en dites-vous ?",
      "Votre brief est prêt.",
      "Voici vos choix.",
      "Dis-nous : VOUS êtes d'accord ?",
      "Ask: « Pouvez-vous confirmer ? »",
      'Ask: "Confirmez le choix."',
      'Say "Dites-moi ce que tu veux" to them.',
      "« Allez, validez » ",
    ]) {
      expect(vouvoiements(text), text).not.toEqual([]);
    }
  });

  it("does not mistake the informal forms nor an English or accented word for one", () => {
    for (const text of [
      "Qu'en dis-tu ?",
      "Ton brief est prêt.",
      "A voucher for the vote.",
      'Say "chez nous, assez souvent" to them.',
      "« Tu peux valider ? »",
      "Deux mots voisins : évous et vouséa.",
    ]) {
      expect(vouvoiements(text), text).toEqual([]);
    }
  });
});

describe("every agent says « tu »", () => {
  it("ships the whole team", () => {
    expect(agents.length).toBeGreaterThanOrEqual(15);
  });

  it("every skill that speaks with the creator carries the rule", () => {
    expect(skills.length).toBeGreaterThanOrEqual(12);
    // The rule is written once in the reference; each skill points to it and says « tu ».
    expect(sharedRules()).toContain(
      'In French, say « tu » to the creator, always, in the conversation and in every text addressed to them ("Talking with the creator", step 7).',
    );
    for (const skill of skills) {
      const text = flat(skill.text);
      expect(text, skill.name).toContain(SHARED_RULES_POINTER);
      expect(text, skill.name).toContain("in French say « tu »");
    }
  });

  it("Noah and Stella state it in their definition", () => {
    expect(flat(read("agents/noah/SKILL.md"))).toContain("he says « tu » to the creator, always");
    expect(read("agents/stella/SKILL.md")).toContain("she says « tu » to the creator, always");
  });
});

describe("a question of choice waits for its open point, and « ok » chooses", () => {
  it("every skill carries the strengthened rule and the plain approval", () => {
    const shared = sharedRules();
    expect(shared).toContain(
      'even a casual one ("qu\'en dis-tu ?", "which do you prefer?"), comes after its `decision` checkpoint is open',
    );
    expect(shared).toContain(
      'A plain approval ("ok", "oui", "vas-y", "d\'accord", "parfait") to a question that carried your recommendation is the creator choosing it',
    );
    expect(shared).toContain(
      "`option_chosen`, the recommendation's id, their whole message in `quote`",
    );
    for (const skill of skills) {
      expect(flat(skill.text), skill.name).toContain(SHARED_RULES_POINTER);
    }
  });

  it("Noah records « ok » as the recommended option or an approval, and no longer refuses it", () => {
    const noah = read("agents/noah/SKILL.md");
    expect(flat(noah)).toContain("to a question that carried his recommendation chooses it");
    expect(flat(noah)).toContain("`option_chosen`, the recommendation's id");
    expect(flat(noah)).toContain(
      'On a point without options (a document, the end of a phase), "ok" is `approved`',
    );
    expect(flat(noah)).toContain("a hesitation, a refusal or a question");
    expect(flat(noah)).toContain("One answer validates a point, whatever its type or its risk");
    expect(flat(noah)).toContain("he cannot open one");
    expect(noah).not.toContain("never picks his own recommendation for them");
  });

  it("the planning agents ask casual choices on an open point", () => {
    expect(read("agents/iris/agent.yaml")).toContain(
      "a choice is always asked on an open checkpoint",
    );
  });
});

describe("a finished structuring document is committed, validated, then asked once", () => {
  const identity = '(constitution, "Talking with the creator", step 5)';

  it("the brief: one phase_end carries it, with no document point on top", () => {
    const text = read("skills/write-brief/SKILL.md");
    expect(text).toContain(`with the Git identity the creator gave ${identity}`);
    expect(text).toContain(
      "This one point is both the validation of the brief and the end of framing",
    );
    expect(text).toContain("never open a separate `document` point for it");
    expect(text).toContain(
      "any other case in framing: open the end (below), whatever else `state.next` says",
    );
    expect(text).toContain(
      "a later update of the brief): commit it and open a `document` checkpoint instead",
    );
    // No case leaves the brief without its point.
    expect(text).not.toContain(
      "Any other step: tell the creator what `state.next` says, and open nothing.",
    );
  });

  it("the PRD: a document point while the UX specification is to come, one phase_end otherwise", () => {
    const text = read("skills/write-prd/SKILL.md");
    expect(text).toContain("**Commit the PRD and validate it.**");
    expect(text).toContain("**A UX specification is still to come**");
    expect(text).toContain("the PRD does not close the planning. Open a `document` checkpoint");
    expect(text).toContain("Never open a second `document` point on the same `blob_sha`");
    expect(text).toContain("it approves the PRD, even though the planning goes on");
    expect(text).toContain("it will not ask again about this PRD");
    expect(text).toContain("**Nothing else is left in the planning**");
    expect(text).toContain("never open a `document` point as well");
    expect(text).toContain(
      "Whatever `npx agentplugged next --json` says, never leave the PRD without its point",
    );
    expect(text).toContain("`DOCUMENT_REVIEW_OPEN`");
    expect(text).toContain("`supersedes` set to the refused one's id");
    // The old instruction to open nothing while the UX specification is to come is gone.
    expect(text).not.toContain("Tell the creator that Stella writes it, and open nothing");
    const maya = read("agents/maya/agent.yaml");
    expect(maya).toContain("Never leave the PRD without its point, whatever `state.next` says");
  });

  it("the UX specification: Stella opens the single phase_end, Maya active or not", () => {
    const text = read("skills/write-ux-spec/SKILL.md");
    expect(text).toContain("**Commit the specification and validate it, with one point.**");
    expect(text).toContain("you open it yourself, whether Maya is active or not");
    expect(text).toContain(
      "any other case in planning: open the end (below), whatever else `state.next` says",
    );
    expect(text).toContain("`DOCUMENT_REVIEW_OPEN`");
    expect(text).toContain("never ask for it again");
    expect(text).not.toContain("Maya closes the planning");
    expect(read("agents/stella/SKILL.md")).toContain("whether Maya is active or not");
  });

  it("the architecture: Alex opens the single phase_end without Chloé, a document point with her", () => {
    const text = read("skills/write-architecture/SKILL.md");
    expect(text).toContain("Commit the architecture on the working branch");
    expect(text).toContain(
      "so the architecture is not the last document yet: open a `document` checkpoint",
    );
    expect(text).toContain(
      "without Chloé (and while `phase.current` is `design`), the architecture is the last document of the phase: open the single `phase_end` yourself",
    );
    expect(text).toContain(
      "without asking again about an architecture already validated and unchanged",
    );
    expect(text).toContain("Open the end of the phase from this skill only without Chloé");
    expect(text).not.toContain("Never open the end of the phase from this skill");
    expect(read("agents/alex/agent.yaml")).toContain(
      "`git rev-parse HEAD:<path>`, both files committed",
    );
  });

  it("an approved document point counts as an approval in the agents' definitions and the README", () => {
    for (const id of ["iris", "maya", "stella", "alex"]) {
      expect(read(`agents/${id}/SKILL.md`), id).toContain(
        "the checkpoint that cites it (a `document` point, or the end of its phase)",
      );
    }
    expect(read("README.md")).toContain("(its `document` point, or the end of its phase");
  });
});
