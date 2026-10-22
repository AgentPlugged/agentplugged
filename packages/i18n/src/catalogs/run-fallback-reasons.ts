/**
 * French texts of the fallbacks of Noah's run started by the bridge (the matrix of
 * `run-compatibility` in core): the cause in plain words, and under `.action` the one gesture the
 * creator can make. The English texts are the ones written in core.
 */

const VALIDATION_FR =
  "cet outil nomme lui-même ses sessions : la session d'une nouvelle conversation n'est connue qu'une fois le lancement fait, après que ton message a été remis à Noah, donc le moteur ne peut pas encore relier à ce message une validation dite avec des mots.";
const VALIDATION_ACTION_FR =
  "Valide le point avec le bouton de validation de la vue web ou du téléphone (un seul geste) : la décision est enregistrée et Noah est prévenu. À partir de son deuxième message d'une conversation, il peut l'enregistrer lui-même.";

const OWN_REFUSALS_FR =
  "cet outil donne aux agents qu'il lance les mêmes outils MCP qu'à la session qui les lance : les outils que Noah n'a pas à son contrat (`guard`, `checkpoint`, `story`, `review`, `plan`, `measure`, `memory`) ne peuvent pas être retirés à sa seule session. Seuls son rôle, la consigne et les contrôles du moteur le tiennent à son contrat.";
const OWN_REFUSALS_ACTION_FR =
  "Rien à faire pour un usage courant ; pour la garantie la plus forte, choisis Claude Code pour Noah : `npx agentplugged agent edit noah --tool claude-code`.";

const READ_FLOOR_FR =
  "le pont ne peut passer le plancher des fichiers qu'un agent ne lit jamais (clés, `.env` et fichiers secrets) que sur la ligne de commande de Claude Code. Pour cet outil il s'appuie sur les règles et les hooks que `sync` a écrits dans le projet, que l'outil n'applique que dans un dossier auquel il fait confiance, et le pont ne peut pas non plus restreindre les serveurs MCP du projet que l'outil démarre.";
const READ_FLOOR_ACTION_FR =
  "Lance `npx agentplugged sync` et approuve le projet une fois dans l'outil ; pour la garantie la plus forte, choisis Claude Code pour Noah : `npx agentplugged agent edit noah --tool claude-code`.";

const NO_COST_ACTION_FR =
  "Rien à faire : le travail continue. Lis la consommation sur la page d'usage de l'outil ; le moteur ne l'estime jamais.";

const CHOOSE_ANTIGRAVITY_FR =
  "Choisis Antigravity CLI pour Noah dans ce produit : `npx agentplugged agent edit noah --tool antigravity` (Claude Code accepte aussi un message pendant qu'il travaille).";

const KEPT_FR =
  "un message écrit pendant ce temps est gardé (« Noah est occupé, ta demande est gardée ») et remis à Noah en un seul message quand sa réponse se termine.";

export const RUN_FALLBACK_REASONS_FR: Readonly<Record<string, string>> = {
  "run.codex.live_messages": `\`codex exec\` lit sa consigne une seule fois et n'a pas d'entrée qui reste ouverte pendant qu'il travaille, et il attend ses sous-agents avant de répondre : ${KEPT_FR}`,
  "run.codex.live_messages.action": CHOOSE_ANTIGRAVITY_FR,
  "run.codex.validation_by_chat": VALIDATION_FR,
  "run.codex.validation_by_chat.action": VALIDATION_ACTION_FR,
  "run.codex.own_refusals": OWN_REFUSALS_FR,
  "run.codex.own_refusals.action": OWN_REFUSALS_ACTION_FR,
  "run.codex.read_floor": READ_FLOOR_FR,
  "run.codex.read_floor.action": READ_FLOOR_ACTION_FR,
  "run.codex.cost":
    "Codex rapporte les jetons à la fin d'un tour et aucun coût en argent (c'est l'abonnement du compte qui le facture).",
  "run.codex.cost.action": NO_COST_ACTION_FR,
  "run.antigravity.validation_by_chat": VALIDATION_FR,
  "run.antigravity.validation_by_chat.action": VALIDATION_ACTION_FR,
  "run.antigravity.own_refusals": OWN_REFUSALS_FR,
  "run.antigravity.own_refusals.action": OWN_REFUSALS_ACTION_FR,
  "run.antigravity.read_floor": READ_FLOOR_FR,
  "run.antigravity.read_floor.action": READ_FLOOR_ACTION_FR,
  "run.antigravity.cost": "Antigravity CLI rapporte les jetons et aucun coût en argent.",
  "run.antigravity.cost.action": NO_COST_ACTION_FR,
  "run.cursor.sub_agents":
    "la documentation de Cursor ne dit pas que les sous-agents marchent dans son mode non interactif, et ce mode ne peut écrire qu'avec `--force`, qui autorise toute commande non explicitement refusée : le pont ne le passe jamais. Noah tourne donc en lecture seule : il lit l'état, répond, enregistre la passation avec `agent.delegate`, et te dit quel agent prend la main et que l'étape continue dans le chat de l'outil (mode `conversation`).",
  "run.cursor.sub_agents.action":
    "Choisis Claude Code pour Noah dans ce produit : `npx agentplugged agent edit noah --tool claude-code`.",
  "run.cursor.live_messages": `le mode non interactif de Cursor n'a pas d'entrée qui reste ouverte pendant qu'il travaille : ${KEPT_FR}`,
  "run.cursor.live_messages.action": CHOOSE_ANTIGRAVITY_FR,
  "run.cursor.validation_by_chat": VALIDATION_FR,
  "run.cursor.validation_by_chat.action": VALIDATION_ACTION_FR,
  "run.cursor.own_refusals": OWN_REFUSALS_FR,
  "run.cursor.own_refusals.action": OWN_REFUSALS_ACTION_FR,
  "run.cursor.read_floor": READ_FLOOR_FR,
  "run.cursor.read_floor.action": READ_FLOOR_ACTION_FR,
  "run.cursor.usage":
    "Cursor ne rapporte ni jeton ni coût dans sa sortie et n'en garde aucun sur la machine : le moteur ne mesure rien d'un lancement et ne l'estime jamais.",
  "run.cursor.usage.action": NO_COST_ACTION_FR,
  "run.cursor.cost": "Cursor ne rapporte aucun coût en argent.",
  "run.cursor.cost.action": NO_COST_ACTION_FR,
  "run.kimi.live_messages": `Kimi Code CLI prend sa consigne en argument et n'a pas d'entrée qui reste ouverte pendant qu'il travaille : ${KEPT_FR}`,
  "run.kimi.live_messages.action": CHOOSE_ANTIGRAVITY_FR,
  "run.kimi.validation_by_chat":
    "Kimi Code CLI ne donne l'identifiant d'une nouvelle session qu'à la fin d'un tour réussi : le moteur ne peut donc pas relier à ce message une validation dite avec des mots, dans le premier message d'une conversation (ni dans une conversation dont le premier lancement a été coupé).",
  "run.kimi.validation_by_chat.action": VALIDATION_ACTION_FR,
  "run.kimi.read_floor":
    "le mode non interactif de Kimi Code CLI approuve tous les appels d'outils et sa ligne de commande ne prend aucune règle : le plancher des fichiers jamais lus (clés, `.env` et fichiers secrets) ne lui est pas passé. La session de Noah est tenue aux outils de lecture et au serveur MCP du moteur (jamais le shell), mais les agents qu'il lance travaillent sous leur propre définition, shell compris, et les garde-fous du produit ne les atteignent que par le hook des réglages Kimi du créateur. Le pont fait aussi confiance au dossier du produit pour ce lancement seulement : tous les serveurs MCP du projet démarrent.",
  "run.kimi.read_floor.action":
    "Installe les garde-fous une fois, toi-même : `npx agentplugged kimi-hooks install` ; pour la garantie la plus forte, choisis Claude Code pour Noah : `npx agentplugged agent edit noah --tool claude-code`.",
  "run.kimi.usage":
    "Kimi Code CLI n'écrit ni jeton ni coût dans sa sortie, et le format des sessions qu'il garde sur la machine n'est pas documenté : le moteur ne mesure rien d'un lancement et ne l'estime jamais.",
  "run.kimi.usage.action": NO_COST_ACTION_FR,
  "run.kimi.cost": "Kimi Code CLI ne rapporte aucun coût en argent.",
  "run.kimi.cost.action": NO_COST_ACTION_FR,
};
