/** The hooks of Codex's project are not declared: the creator's `.codex/config.toml` is kept. */
const CODEX_HOOKS_KEPT_FR =
  "sync n'a pas pu écrire `.codex/config.toml` (le fichier est à toi) : les hooks du projet d'agentplugged (la preuve du chat, la trace des lectures extérieures, les installations) ne sont pas déclarés pour Codex. Ajoute-les toi-même à partir de `.codex/hooks/agentplugged-codex.mjs` (événements `UserPromptSubmit`, `PreToolUse`, `PostToolUse`), ou retire ton fichier et relance `npx agentplugged sync`.";

/** The hooks of Cursor's project are not declared: the creator's `.cursor/hooks.json` is kept. */
const CURSOR_HOOKS_KEPT_FR =
  "sync n'a pas pu écrire `.cursor/hooks.json` (le fichier est à toi) : les hooks du projet d'agentplugged (les règles de permission, la preuve du chat, la trace des lectures extérieures, les installations) ne sont pas déclarés pour Cursor, et le script et la politique du moteur n'ont pas été écrits. Les secrets restent hors de portée de l'agent par `.cursorignore` (et, dans la CLI, par `.cursor/cli.json`), le reste suit la constitution sans garde technique. Déplace ton fichier et relance `npx agentplugged sync`, puis refusionne tes propres hooks dans le fichier généré.";

/** The "model" fallback, the same for every tool. */
const MODEL_INHERIT_FR =
  "la table des modèles (`.agentplugged/models.yaml`, ou `models` dans `method.yaml`) donne `inherit` pour au moins un niveau de modèle : les agents de ce niveau utilisent le modèle de la session.";

/**
 * Translations of the fallback reasons, by fallback identifier (`codex.permissions`), or by
 * `*.` and the identifier without its client (`*.mcp.conflict`) for every client. English
 * has none: the reasons written in core's compatibility matrix are the single English text,
 * shown as is and copied into the constitution.
 */
export const FALLBACK_REASONS: Readonly<Record<"fr", Readonly<Record<string, string>>>> = {
  fr: {
    "codex.permissions.config-kept":
      "sync n'a pas pu écrire `.codex/config.toml` (le fichier est à toi) : agentplugged ne règle aucun bac à sable et ne déclare aucun hook pour Codex, donc aucun chemin n'est bloqué techniquement (les règles de commandes de `.codex/rules/agentplugged.rules` s'appliquent quand même).",
    "codex.chat_proof.config-kept": CODEX_HOOKS_KEPT_FR,
    "codex.untrusted.config-kept": CODEX_HOOKS_KEPT_FR,
    "codex.installs.config-kept": CODEX_HOOKS_KEPT_FR,
    "codex.untrusted":
      "les hooks de Codex enregistrent une lecture faite par une commande réseau (`curl`, `wget`, `gh`, `git pull`…) ou par un outil d'un autre serveur MCP. La recherche web propre à Codex est un outil hébergé que les hooks ne voient pas : après une recherche web, l'agent appelle `guard.external_read` pour que le journal en garde la trace (source, heure, agent) ; rien n'est bloqué. Les actions faites par les outils de fichiers (lire, modifier, écrire) ne passent pas par un hook de lecture : seules les règles de permission les encadrent (`read_secrets` est toujours refusé). Seul Claude Code contrôle aussi une écriture avant qu'elle ait lieu (un secret, un fichier hors de la story, une décision d'architecture) : pas cet outil.",
    "codex.isolation":
      "les fichiers d'agents de cet outil ne savent pas lancer un développeur dans une copie de travail à lui : chaque développeur travaille seulement dans le `workdir` que renvoie `story.start`, la copie de travail propre à la story, une par story. Le bac à sable de Codex garde aussi les écritures dans le dossier du projet, et la copie de travail d'une story est à côté (`<projet>.worktrees/<id>`) : un développeur n'y écrit que si `sandbox_workspace_write.writable_roots` de Codex la liste par son chemin absolu (observé sur Codex 0.160.1, le 2026-10-06 : un chemin relatif est lu depuis le dossier du projet et son `..` est ignoré ; `~/` fonctionne), ce que `sync` n'écrit pas parce que le moteur ne sait pas où se trouve le projet sur cette machine. Sous Windows, Codex ne laisse écrire dans le projet qu'une fois son bac à sable Windows installé (le mode élevé, une approbation d'administrateur, proposée par l'extension d'éditeur) : sinon la session retombe en silence en lecture seule, et le mode non élevé refuse un projet dont `.git` et `.codex` sont protégés.",
    "codex.decisions":
      "Codex n'envoie à son client les formulaires qu'un serveur MCP demande (« elicitation ») que si sa politique d'approbation les laisse passer : un `never` seul les refuse en silence, d'où la forme granulaire que `sync` écrit et qui refuse tout le reste (observé sur Codex 0.160.1, le 2026-10-06, par son serveur d'application : la demande arrive au client, dont le moteur enregistre la réponse). `codex exec` les refuse, et aucun n'a été vu affiché à l'écran de l'extension d'éditeur : les décisions te sont posées en texte dans le chat (« a, b ou c ? »), et l'agent enregistre ta réponse avec `chat.answer`, en la citant. Le moteur essaie quand même le formulaire d'abord (`chat.ask`) et passe au chat quand l'outil ne peut pas l'afficher.",
    // Cursor: the creator's own `.cursor/hooks.json` is kept, sync wrote no hook.
    "cursor.permissions.hooks-kept":
      "sync n'a pas pu écrire `.cursor/hooks.json` (le fichier est à toi) : aucun hook n'applique les chemins et les commandes protégés dans l'éditeur Cursor. `.cursorignore` garde les secrets hors de portée de l'agent, et `.cursor/cli.json` bloque les chemins interdits dans la CLI de Cursor seulement (l'éditeur ne le lit pas).",
    "cursor.rules":
      "les hooks de Cursor refusent ce que le produit refuse (push sur la branche principale, force push, suppression en masse, écriture des fichiers protégés du produit, lancement d'un autre agent Cursor) et demandent pour une commande qu'une règle demande (`ask`), dans l'éditeur et dans la ligne de commande quand elle envoie le hook. Ils ne demandent pas avant l'écriture d'un fichier ni avant un accès au web (`preToolUse` ignore `ask`) : une règle qui demande d'abord pour une modification de fichier (`edit_code: ask`) ou pour le web (`internet: ask`) n'est pas demandée par Cursor, donc avant une telle action l'agent te demande dans le chat ; `internet: deny` et `edit_code: deny` sont refusés. Les outils de Cursor qui lisent un fichier ne passent pas par un hook : `.cursorignore` garde les secrets (`.env` et ses semblables) hors de portée de l'agent, et une commande qui en lit un est refusée. Le texte saisi dans une console déjà ouverte n'est pas vu non plus. Les hooks ne tournent que dans un dossier auquel tu fais confiance.",
    "cursor.rules.hooks-kept": CURSOR_HOOKS_KEPT_FR,
    "cursor.untrusted.hooks-kept": CURSOR_HOOKS_KEPT_FR,
    "cursor.chat_proof.hooks-kept": CURSOR_HOOKS_KEPT_FR,
    "cursor.installs.hooks-kept": CURSOR_HOOKS_KEPT_FR,
    "cursor.decisions":
      "Cursor range les formulaires qu'un serveur MCP demande (« elicitation ») parmi ce qu'il sait faire, mais des rapports de son propre forum (Windows 11, Cursor 3.10.20, le 2026-07-07, encore vus sur 3.17.8) montrent le formulaire non affiché et l'appel d'outil qui reste en attente, et aucun n'a été vu affiché dans une session de ce produit (Cursor 3.23.12, le 2026-10-07) : les décisions te sont posées en texte dans le chat (« a, b ou c ? »), et l'agent enregistre ta réponse avec `chat.answer`, en la citant. Le moteur essaie quand même le formulaire d'abord (`chat.ask`) ; dans Cursor il attend 90 secondes un premier signe de vie, et sans rien il pose la question dans le chat pour le reste de la session. Un formulaire déjà répondu une fois est attendu aussi longtemps que dans n'importe quel autre outil.",
    "cursor.usage":
      "Cursor ne garde aucun nombre de jetons nulle part sur la machine : ses transcriptions (`~/.cursor/projects/<projet>/agent-transcripts/`) contiennent les messages et les appels d'outils, sans jetons, sans modèle et sans date par ligne. Le moteur ne mesure donc rien d'une session Cursor (`measure.usage` répond `available: false`) et ne l'estime jamais ; la page d'usage de Cursor (le tableau de bord de ton compte) est la seule source. Le hook `stop` de l'éditeur porte peut-être des jetons (vu dans le code de Cursor lui-même, non vérifié rempli) : il n'est pas utilisé.",
    "*.usage":
      "le moteur ne lit aucune trace de cet outil : il ne mesure rien de ses sessions (`measure.usage` répond `available: false`) et ne l'estime jamais.",
    "codex.mcp.config-kept":
      'sync n\'a pas pu écrire `.codex/config.toml` (le fichier est à toi) : le serveur MCP `agentplugged` n\'est pas déclaré pour Codex. Ajoute toi-même `[mcp_servers.agentplugged]` avec `command = "npx"` et `args = ["-y", "agentplugged@<engine_version>", "mcp"]`.',
    // Any client's MCP file holding a server of yours: `{path}` is the file, given by core.
    "*.mcp.conflict":
      "`{path}` déclare déjà un serveur MCP `agentplugged` qui n'est pas celui qu'écrit sync : il est laissé tel quel. Vérifie qu'il lance `npx -y agentplugged@<engine_version> mcp`.",
    ...Object.fromEntries(
      ["claude-code", "codex", "antigravity", "cursor"].map((client) => [
        `${client}.model`,
        MODEL_INHERIT_FR,
      ]),
    ),
    "codex.rules":
      "les hooks de Codex répondent `allow` ou `deny`, jamais `ask` : une règle de permission qui demande d'abord (`ask`, que toi seul poses) est écrite en règle `prompt` dans `.codex/rules/agentplugged.rules` seulement tant que Codex demande des approbations (niveau `strict`, modifications qui demandent d'abord) : sans approbation (par défaut, écrite en forme granulaire qui laisse quand même passer les formulaires), Codex ne peut pas demander, rien n'est écrit, et le hook laisse l'appel passer. Avant une telle action, l'agent te demande dans le chat. Ce que le produit refuse (push sur la branche principale, force push, suppression en masse, lecture de secrets, écriture de ses fichiers protégés) est refusé par le hook et, pour les commandes, par les règles propres à Codex. `internet: ask` désactive la recherche web et garde le bac à sable hors ligne ; `edit_code: ask` ou `deny` donne un bac à sable en lecture seule avec approbation sur demande. Les hooks ne tournent qu'une fois que tu les as approuvés (`/hooks` dans Codex, une seule fois).",
    "codex.rules.config-kept":
      "sync n'a pas pu écrire `.codex/config.toml` (le fichier est à toi) : aucun hook n'applique les règles de permission pour Codex ; seules les règles de commandes de `.codex/rules/agentplugged.rules` le font.",
    // Claude Code, Antigravity CLI, Codex and the Cursor editor have the hook.
    "*.chat_proof":
      "agentplugged n'écrit pour cet outil aucun hook qui retienne tes messages : une réponse que tu donnes dans le chat est enregistrée « non vérifiée » (`chat_unverified`) et affichée ainsi partout, quel que soit le point (le journal garde la trace de chaque réponse). Pour que chaque réponse soit vérifiée, travaille dans Claude Code ; pour que les points à risque élevé passent par ta clé, choisis le niveau `strict`.",
    // Every tool but Claude Code.
    "*.isolation":
      "les fichiers d'agents de cet outil ne savent pas lancer un développeur dans une copie de travail à lui : chaque développeur travaille seulement dans le `workdir` que renvoie `story.start`, la copie de travail propre à la story, une par story.",
    // Antigravity CLI: the plugin's folder is the creator's, sync wrote nothing there.
    ...Object.fromEntries(
      ["permissions", "rules", "untrusted", "chat_proof", "installs", "mcp"].map((capability) => [
        `antigravity.${capability}.plugin-kept`,
        "`.agents/plugins/agentplugged/` est à toi : sync n'y a rien écrit, donc le serveur MCP `agentplugged` et les hooks du plugin (les règles de permission, les lectures de contenu extérieur, la preuve du chat) ne sont pas déclarés pour Antigravity CLI. Renomme ou supprime ce dossier, ou ajoute-les toi-même, puis relance `npx agentplugged sync`.",
      ]),
    ),
    // Antigravity CLI: the client announces forms, which only a headless run cancelled.
    "antigravity.decisions":
      "Antigravity CLI annonce qu'il affiche les formulaires qu'un serveur MCP demande (« elicitation »), mais cela n'a été vérifié que dans son mode sans terminal, où il les annule : tant qu'aucune session n'en a affiché un, les décisions te sont posées en texte dans le chat (« a, b ou c ? »), et l'agent enregistre ta réponse avec `chat.answer`, en la citant. Le moteur essaie quand même le formulaire d'abord (`chat.ask`) et passe au chat quand l'outil ne peut pas l'afficher.",
    // Any other tool; Codex has its own reason.
    "*.decisions":
      "cet outil n'affiche pas les formulaires qu'un serveur MCP demande (« elicitation »), ou pas dans tous les modes : les décisions te sont posées en texte dans le chat (« a, b ou c ? »), et l'agent enregistre ta réponse avec `chat.answer`, en la citant. Le moteur essaie toujours d'abord le formulaire (`chat.ask`) et repasse au chat quand l'outil ne sait pas l'afficher.",
    // Claude Code, Antigravity CLI, Codex and Cursor have hooks.
    "*.untrusted":
      "agentplugged n'écrit aucun hook pour cet outil : une lecture par l'accès web de l'outil ou par un autre serveur MCP n'est pas enregistrée toute seule. Après une lecture externe, l'agent appelle `guard.external_read` pour que le journal en garde la trace (source, heure, agent) ; rien n'est bloqué. Les actions faites par les outils de fichiers (lire, modifier, écrire) ne passent pas par un hook de lecture : seules les règles de permission les encadrent (`read_secrets` est toujours refusé). Seul Claude Code contrôle aussi une écriture avant qu'elle ait lieu (un secret, un fichier hors de la story, une décision d'architecture) : pas cet outil.",
    // Claude Code, Antigravity CLI, Codex and Cursor have the hook.
    "*.installs":
      "cet outil n'a aucun hook qui voie une installation avant qu'elle s'exécute : le moteur ne l'inscrit pas dans l'activité, et `installs.mode: validate` ne peut pas te demander de valider ici. Ce sont les permissions de l'outil qui décident.",
  },
};
