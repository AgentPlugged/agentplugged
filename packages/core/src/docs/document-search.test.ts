import { FindDataSchema } from "@agentplugged/protocol";
import { describe, expect, it } from "vitest";
import type { DocumentFile } from "./docs-base.js";
import { searchDocuments, searchTerms } from "./document-search.js";

const header = (id: string, owner: string, extra = ""): string =>
  `---\nid: ${id}\nkind: note\nowner: ${owner}\nlinks: []\n${extra}---\n`;

const VISION: DocumentFile = {
  path: ".agentplugged/docs/kb-vision.md",
  text: `${header("kb-vision", "zoe")}# Vision du produit

<!-- a comment
that spans lines -->

Kalo relance automatiquement les factures impayées des artisans.

## Relances

Les relances partent à J+7, J+15 et J+30 après l'échéance de la facture.
Le client peut répondre au courriel pour demander un délai.

## Paiements partiels

Un paiement partiel solde la facture au prorata et relance le reste à J+7.
`,
};

const PRD: DocumentFile = {
  path: ".agentplugged/epics/relances.md",
  text: `---\nid: epic-1\nkind: epic\nowner: john\nlinks: []\ntitle: Les relances\n---\n# Relances\n\nLe créateur choisit le ton de la relance.\n`,
};

const LONG: DocumentFile = {
  path: ".agentplugged/docs/long.md",
  text: `# Notes\n\nrelance ${"mot ".repeat(200)}relance fin\n`,
};

describe("the words of a search", () => {
  it("ignores case and accents, one-letter words and repeats", () => {
    expect(searchTerms("Échéance  échéance, J+7 a 8")).toEqual(["echeance", "7", "8"]);
  });

  it("finds nothing in a search without a usable word", () => {
    expect(searchTerms("  , ; ")).toEqual([]);
    expect(searchDocuments([VISION], " ; ").hits).toEqual([]);
  });
});

describe("searching documents", () => {
  it("finds the section and the real line of the words, in a file with a comment above", () => {
    const { hits } = searchDocuments([VISION], "échéance facture");
    expect(hits).toHaveLength(1);
    const hit = hits[0];
    expect(hit?.heading).toBe("Relances");
    const lines = VISION.text.split("\n");
    expect(lines[(hit?.line ?? 0) - 1]).toContain("échéance");
    expect(hit?.snippet).toContain("Les relances partent");
    expect(hit?.kb).toBe(true);
  });

  it("matches without accents or case and inside a word", () => {
    expect(searchDocuments([VISION], "ECHEANCE").hits).toHaveLength(1);
    expect(searchDocuments([VISION], "partiel").hits[0]?.heading).toBe("Paiements partiels");
  });

  it("requires every word, in one section or the title", () => {
    expect(searchDocuments([VISION], "échéance cassoulet").hits).toEqual([]);
    // « vision » is in the title, « courriel » in a section.
    expect(searchDocuments([VISION], "vision courriel").hits).toHaveLength(1);
  });

  it("lists one place per document, the best first, and says when it cuts", () => {
    const result = searchDocuments([VISION, PRD], "relance");
    expect(result.hits.map((hit) => hit.path)).toContain(PRD.path);
    expect(result.hits).toHaveLength(2);
    expect(searchDocuments([VISION, PRD], "relance", 1)).toMatchObject({ truncated: true });
    expect(searchDocuments([VISION, PRD], "relance", 1).hits).toHaveLength(1);
    // The epic is not a page of the knowledge base.
    expect(result.hits.find((hit) => hit.path === PRD.path)?.kb).toBeUndefined();
  });

  it("cuts a long line around the words and stays within what the protocol accepts", () => {
    const { hits } = searchDocuments([LONG], "fin");
    const parsed = FindDataSchema.safeParse({ op: "find", hits, truncated: false });
    expect(parsed.success).toBe(true);
    expect(hits[0]?.snippet.length).toBeLessThanOrEqual(240);
  });

  it("finds nothing in a document without the words", () => {
    expect(searchDocuments([VISION, PRD], "cassoulet")).toEqual({ hits: [], truncated: false });
  });

  it("reads a heading with thousands of blanks in linear time", () => {
    const hostile: DocumentFile = {
      path: ".agentplugged/docs/hostile.md",
      text: `# a${" ".repeat(5_000)}b\n\n## ${"\t".repeat(5_000)}x\n\nrelance ici\n`,
    };
    const started = Date.now();
    searchDocuments([hostile], "relance");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
