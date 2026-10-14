/**
 * A spec of the short path and the stories cut from it, the same sample for the unit
 * tests of the rules and for the flow that goes from the creator's choice to the first story.
 */

/** The scope a spec header declares, as lines of YAML. */
export interface SampleScope {
  readonly size?: string;
  readonly users?: number;
  readonly sensitive?: string;
  readonly integrations?: number;
  readonly platforms?: number;
  readonly asked?: string;
}

/** A small internal tool: one user, nothing sensitive, one external service. */
export function specText(scope: SampleScope = {}, extra: readonly string[] = []): string {
  const header = [
    "id: spec",
    "kind: spec",
    "owner: maya",
    "links: []",
    `size: ${scope.size ?? "small"}`,
    `users: ${scope.users ?? 2}`,
    `sensitive: ${scope.sensitive ?? "[]"}`,
    `integrations: ${scope.integrations ?? 1}`,
    `platforms: ${scope.platforms ?? 1}`,
    ...(scope.asked === undefined ? [] : [`asked: ${scope.asked}`]),
  ];
  return [
    "---",
    ...header,
    "---",
    "# Range-factures",
    "",
    "<!-- part: brief -->",
    "## Brief",
    "",
    "Un outil interne qui range les factures d'une petite société, sans compte ni service tiers.",
    "",
    "<!-- part: requirements -->",
    "## Exigences",
    "",
    "- EF-1 : Le gérant importe un dossier de factures en PDF.",
    "- EF-2 : Le gérant exporte la liste des factures en CSV.",
    "- ENF-1 : L'import de 1 000 factures prend moins de 5 secondes, mesuré par un banc d'essai.",
    "- ENF-2 : Aucun secret n'est écrit dans le code ni dans un journal, vérifié par une relecture.",
    ...extra,
    "",
    "<!-- part: decisions -->",
    "## Décisions",
    "",
    "### AD-1 — Un seul fichier de données",
    "",
    "- **Binds:** all",
    "- **Prevents:** deux sources de vérité pour les factures.",
    "- **Rule:** tout accès aux données passe par le module `store`.",
    "",
    "<!-- part: stories -->",
    "## Stories",
    "",
    "- 1-1 : Importer un dossier (EF-1, ENF-1)",
    "- 1-2 : Exporter en CSV (EF-2, ENF-2)",
    "",
  ].join("\n");
}

/** The epic and the two stories Izzy cuts from `specText`, valid for `docs check`. */
export function sampleBreakdown(): Record<string, string> {
  const story = (id: string, title: string, requirements: string) =>
    [
      "---",
      `id: ${id}`,
      "kind: story",
      "owner: sam",
      `title: ${title}`,
      "epic: epic-1",
      "reviewer: quentin",
      `requirements: [${requirements}]`,
      "budget_usd: 5",
      `branch: feat/${id}`,
      "depends_on: []",
      "---",
      `# ${title}`,
      "",
      "## Context",
      "",
      `The spec, ${requirements}.`,
      "",
      "## Intent",
      "",
      `${title}.`,
      "",
      "## Acceptance criteria",
      "",
      "- Given the tool, when the manager uses it, then the result is shown.",
      "",
      "## Out of scope",
      "",
      "- Anything the spec leaves out.",
      "",
    ].join("\n");
  return {
    ".agentplugged/epics/epic-1.md": "---\nid: epic-1\nkind: epic\nowner: izzy\n---\n# Epic 1\n",
    ".agentplugged/stories/1-1.md": story("1-1", "Importer un dossier", "EF-1, ENF-1"),
    ".agentplugged/stories/1-2.md": story("1-2", "Exporter en CSV", "EF-2, ENF-2"),
  };
}
