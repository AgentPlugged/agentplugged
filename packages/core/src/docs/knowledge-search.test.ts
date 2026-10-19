import { describe, expect, it } from "vitest";
import type { DocumentFile } from "./docs-base.js";
import { knowledgeBaseView, passagesOf, selectPassages, verifyAnswer } from "./knowledge-search.js";

const header = (id: string, extra = ""): string =>
  `---\nid: ${id}\nkind: note\nowner: zoe\nlinks: []\n${extra}---\n`;

const VISION: DocumentFile = {
  path: ".agentplugged/docs/kb-vision.md",
  text: `${header("kb-vision", "last_story: 2-3\n")}# Vision du produit

Dernière mise à jour : 2026-10-01 — story 2-3

Kalo relance automatiquement les factures impayées des artisans.

## Relances

Les relances partent à J+7, J+15 et J+30 après l'échéance de la facture.
Le client peut répondre au courriel pour demander un délai.

## Paiements partiels

Un paiement partiel solde la facture au prorata et relance le reste à J+7.
`,
};

const ARCHI: DocumentFile = {
  path: ".agentplugged/docs/kb-architecture.md",
  text: `${header("kb-architecture")}# Architecture

Last updated: 2026-09-20 — first version

Le service de relance est une file de tâches planifiées, lue toutes les minutes.

## Stockage

Les factures sont stockées dans une base relationnelle, une ligne par facture.
`,
};

const PRD: DocumentFile = {
  path: ".agentplugged/docs/prd.md",
  text: `---\nid: prd\nkind: prd\nowner: maya\nlinks: []\n---\n# PRD\n\nEF-1 : relancer les factures.\n`,
};

const FILES = [ARCHI, PRD, VISION];

describe("the pages of the knowledge base", () => {
  it("lists only the pages Zoé owns, with what each says of itself", () => {
    const view = knowledgeBaseView(FILES);
    expect(view.pages.map((page) => page.path)).toEqual([ARCHI.path, VISION.path]);
    const vision = view.pages[1];
    expect(vision).toMatchObject({
      title: "Vision du produit",
      updated: "2026-10-01",
      story: "2-3",
    });
    expect(vision?.summary).toBe(
      "Kalo relance automatiquement les factures impayées des artisans.",
    );
    // Nothing is guessed: a page that gives no story gives none.
    expect(view.pages[0]?.story).toBeUndefined();
    expect(view.pages[0]?.updated).toBe("2026-09-20");
    expect(view.truncated).toBe(false);
  });

  it("puts the map of the base first and titles a page by its file when it has no heading", () => {
    const index: DocumentFile = {
      path: ".agentplugged/docs/index.md",
      text: `${header("kb-index")}Une carte sans titre de premier niveau.\n`,
    };
    const view = knowledgeBaseView([VISION, index]);
    expect(view.pages[0]).toMatchObject({ path: index.path, title: "index" });
  });

  it("does not take a date from a line that is not an update line", () => {
    const page: DocumentFile = {
      path: ".agentplugged/docs/kb-dates.md",
      text: `${header("kb-dates")}# Dates\n\nLancement prévu le 2026-12-01.\n`,
    };
    expect(knowledgeBaseView([page]).pages[0]?.updated).toBeUndefined();
  });
});

describe("the passages", () => {
  it("cuts a page by section and tells the line of each", () => {
    const passages = passagesOf(VISION);
    expect(passages.map((passage) => passage.heading)).toEqual([
      "Vision du produit",
      "Relances",
      "Paiements partiels",
    ]);
    const relances = passages[1];
    expect(relances?.line).toBe(
      VISION.text.split("\n").findIndex((line) => line === "## Relances") + 1,
    );
    expect(relances?.text).toContain("J+7, J+15 et J+30");
  });

  it("leaves comments out and keeps code as text", () => {
    const page: DocumentFile = {
      path: ".agentplugged/docs/kb-x.md",
      text: `${header("kb-x")}# X\n\n<!-- guidance for the writer, not for readers -->\n\nUne phrase assez longue pour compter.\n\n\`\`\`\n# not a heading\n\`\`\`\n`,
    };
    const text = passagesOf(page)
      .map((passage) => passage.text)
      .join("\n");
    expect(text).not.toContain("guidance");
    expect(text).toContain("# not a heading");
  });

  it("cuts a very long section at a blank line", () => {
    const paragraph = `${"mot ".repeat(120)}\n\n`;
    const page: DocumentFile = {
      path: ".agentplugged/docs/kb-long.md",
      text: `${header("kb-long")}# Long\n\n${paragraph.repeat(8)}`,
    };
    const passages = passagesOf(page);
    expect(passages.length).toBeGreaterThan(2);
    for (const passage of passages) expect(passage.text.length).toBeLessThanOrEqual(2_100);
  });
});

describe("the local search", () => {
  it("ranks the passage that talks about the question first", () => {
    const found = selectPassages(FILES, "Quand partent les relances ?");
    expect(found.passages[0]?.heading).toBe("Relances");
  });

  it("matches the words of the heading and the forms of a word", () => {
    const found = selectPassages(FILES, "Comment est stocké une facture");
    expect(found.passages[0]?.heading).toBe("Stockage");
    const partial = selectPassages(FILES, "paiements partiels");
    expect(partial.passages[0]?.heading).toBe("Paiements partiels");
  });

  it("selects nothing for a question the base does not come near", () => {
    expect(selectPassages(FILES, "Quelle est la recette du cassoulet ?").passages).toEqual([]);
    expect(selectPassages(FILES, "?!").passages).toEqual([]);
    expect(selectPassages([], "relances").passages).toEqual([]);
  });

  it("stays within the number and the size it is given", () => {
    const many: DocumentFile = {
      path: ".agentplugged/docs/kb-many.md",
      text: `${header("kb-many")}${Array.from(
        { length: 20 },
        (_, index) =>
          `## Relances ${index}\n\nLes relances du cas ${index} partent à J+7 et la facture reste due.\n`,
      ).join("\n")}`,
    };
    const found = selectPassages([many], "relances facture", { passages: 3, chars: 100 });
    expect(found.passages.length).toBeLessThanOrEqual(3);
    const size = found.passages.reduce((sum, passage) => sum + passage.text.length, 0);
    expect(size).toBeLessThanOrEqual(100);
  });
});

describe("the check of an answer", () => {
  const given = () => selectPassages(FILES, "Quand partent les relances ?").passages;
  const reply = (claims: unknown) => JSON.stringify({ claims });

  it("keeps a statement whose citation is a real quotation, with the line from the page", () => {
    const passages = given();
    const at = passages.findIndex((passage) => passage.heading === "Relances");
    const checked = verifyAnswer(
      reply([
        {
          text: "Les relances partent à J+7, J+15 et J+30.",
          cites: [{ source: `S${at + 1}`, quote: "partent à J+7, J+15 et J+30 après l'échéance" }],
        },
      ]),
      passages,
      FILES,
    );
    expect(checked.dropped).toBe(0);
    expect(checked.claims).toHaveLength(1);
    const citation = checked.claims[0]?.citations[0];
    expect(citation?.path).toBe(VISION.path);
    expect(citation?.heading).toBe("Relances");
    expect(citation?.line).toBe(
      VISION.text.split("\n").findIndex((line) => line.startsWith("Les relances partent")) + 1,
    );
  });

  it("removes a statement quoting words the page does not hold, and counts it", () => {
    const passages = given();
    const checked = verifyAnswer(
      reply([
        {
          text: "Elles partent à 9 h.",
          cites: [{ source: "S1", quote: "les relances partent chaque jour à 9 h" }],
        },
      ]),
      passages,
      FILES,
    );
    expect(checked.claims).toEqual([]);
    expect(checked.dropped).toBe(1);
    expect(checked.readable).toBe(true);
  });

  it("removes a statement citing a passage that was never given, or without any citation", () => {
    const passages = given();
    const checked = verifyAnswer(
      reply([
        {
          text: "A.",
          cites: [{ source: "S99", quote: "Kalo relance automatiquement les factures" }],
        },
        { text: "B.", cites: [] },
        { text: "C." },
        "not even an object",
      ]),
      passages,
      FILES,
    );
    expect(checked.claims).toEqual([]);
    expect(checked.dropped).toBe(4);
  });

  it("checks the quotation against the page as it is now, not as it was given", () => {
    const passages = given();
    const changed = FILES.map((file) =>
      file === VISION ? { ...file, text: file.text.replace("J+15", "J+14") } : file,
    );
    const checked = verifyAnswer(
      reply([{ text: "J+15.", cites: [{ source: "S1", quote: "partent à J+7, J+15 et J+30" }] }]),
      passages,
      changed,
    );
    expect(checked.claims).toEqual([]);
    expect(checked.dropped).toBe(1);
  });

  it("accepts a quotation without the page's emphasis marks, and refuses a trivial one", () => {
    const page: DocumentFile = {
      path: ".agentplugged/docs/kb-bold.md",
      text: `${header("kb-bold")}# Gras\n\nLes **relances** partent à \`J+7\` seulement.\n`,
    };
    const passages = selectPassages([page], "relances partent").passages;
    const good = verifyAnswer(
      reply([{ text: "A.", cites: [{ source: "S1", quote: "Les relances partent à J+7" }] }]),
      passages,
      [page],
    );
    expect(good.claims).toHaveLength(1);
    const trivial = verifyAnswer(
      reply([{ text: "A.", cites: [{ source: "S1", quote: "Les" }] }]),
      passages,
      [page],
    );
    expect(trivial.claims).toEqual([]);
  });

  it("does not take a figure for another one, nor a short phrase for a quotation", () => {
    const page: DocumentFile = {
      path: ".agentplugged/docs/kb-figures.md",
      text: `${header("kb-figures")}# Chiffres\n\nLe plafond mensuel est de 10_000 factures par compte.\n`,
    };
    const passages = selectPassages([page], "plafond mensuel factures").passages;
    const claim = (quote: string) =>
      verifyAnswer(reply([{ text: "A.", cites: [{ source: "S1", quote }] }]), passages, [page]);
    expect(claim("Le plafond mensuel est de 10000 factures par compte").claims).toEqual([]);
    expect(claim("Le plafond mensuel est de 10_000 factures par compte").claims).toHaveLength(1);
    expect(claim("par compte").claims).toEqual([]);
  });

  it("keeps a single underscore in a title, so that a secret in it can still be recognised", () => {
    const page: DocumentFile = {
      path: ".agentplugged/docs/kb-token.md",
      text: `${header("kb-token")}# Jeton npm_AAAABBBBCCCCDDDD\n\nUne page.\n`,
    };
    expect(knowledgeBaseView([page]).pages[0]?.title).toBe("Jeton npm_AAAABBBBCCCCDDDD");
  });

  it("reads a reply in a code fence or after a few words, and says when it cannot read one", () => {
    const passages = given();
    const claims = reply([
      { text: "A.", cites: [{ source: "S1", quote: "Les relances partent à J+7" }] },
    ]);
    expect(verifyAnswer(`\`\`\`json\n${claims}\n\`\`\``, passages, FILES).readable).toBe(true);
    expect(verifyAnswer(`Voici : ${claims} Voilà.`, passages, FILES).readable).toBe(true);
    expect(verifyAnswer("Je ne sais pas.", passages, FILES).readable).toBe(false);
    expect(verifyAnswer(JSON.stringify({ none: true }), passages, FILES).readable).toBe(false);
  });
});
