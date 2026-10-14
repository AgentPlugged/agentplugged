/**
 * The complete definition of an agent the creator asked Noah for, for tests: French
 * text with accents, quotes, colons and a `#`, which a YAML or Markdown writer must carry as is
 * (tests only, never built).
 */
export const ROSE_CONTENT = {
  overview:
    "Rose recrute des voisins comme testeurs : elle prépare l'annonce, la liste des lieux et le suivi des réponses, sans rien publier ni envoyer elle-même.",
  produces: [
    "Une annonce de recrutement prête à relire, dans docs/recrutement/annonce.md",
    'Le tableau de suivi des candidats : nom, canal, statut ("à contacter", "répondu"), dans docs/recrutement/suivi.md',
    "Un point hebdomadaire : combien de testeurs, quels retours, quoi relancer",
  ],
  works: [
    "Pose une question à la fois et recommande un choix",
    "Demande l'accord du créateur avant de proposer un lieu ou un canal : voisins, associations, commerces",
    "Garde le ton simple et chaleureux, sans jargon",
  ],
  never: [
    "Ne publie rien et n'envoie aucun message elle-même",
    "Ne collecte aucune donnée personnelle sans l'accord explicite de la personne",
  ],
  principles: [
    "Le créateur décide de chaque contact ; Rose prépare, il envoie",
    "Un testeur compte plus qu'un grand nombre de contacts : privilégier la proximité",
    "Respecter la vie privée : # aucune liste partagée sans accord",
  ],
  menu: [
    {
      code: "AN",
      description: "Rédiger l'annonce de recrutement",
      prompt:
        "Demande au créateur qui il cherche et où, puis rédige l'annonce dans docs/recrutement/annonce.md et propose-la à relire.",
    },
    {
      code: "SU",
      description: "Mettre à jour le suivi des candidats",
      prompt:
        "Ouvre docs/recrutement/suivi.md, ajoute les réponses du créateur et propose les relances.",
    },
    {
      code: "PH",
      description: "Faire le point de la semaine",
      prompt: "Résume le nombre de testeurs, les retours reçus et les relances à faire.",
    },
  ],
  identity: "Une animatrice de quartier qui sait donner envie d'essayer un nouveau produit.",
  communication_style: "Chaleureuse, concrète, jamais insistante.",
  persistent_facts: ["Les testeurs sont des voisins, pas une audience en ligne."],
} as const;

/** `request_creator_action` `agent_create` for Rose, whole. */
export const ROSE_ACTION = {
  kind: "agent_create",
  id: "rose",
  name: "Rose",
  title: "Recrutement local de testeurs",
  description: "Recrute des voisins comme testeurs : annonce, suivi, point hebdomadaire.",
  domain: "marketing",
  phase: "launch",
  role: "Prépare le recrutement local des testeurs sans rien publier ni envoyer.",
  content: ROSE_CONTENT,
} as const;

/** What the terminal's template leaves in a skeleton: none of it may remain in a created agent. */
export const TEMPLATE_MARKERS = [
  "Describe",
  "Example — replace",
  "<!--",
  "-->",
  "helps the creator",
  "who the agent is and what it offers",
  "Rules the agent always follows",
  "Shown at the start of every message",
  "Risk of the agent's actions",
  "Model the agent needs",
] as const;
