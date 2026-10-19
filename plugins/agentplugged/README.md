# AgentPlugged for Claude Code

AgentPlugged: a complete AI-agent method for your project, light on tokens. / AgentPlugged : une méthode complète d'agents IA pour ton projet, économe en jetons.

## English

AgentPlugged installs in your project a complete method for building software with AI agents (roles, rules, checkpoints), using as few tokens as possible. This plugin is a thin wrapper: it declares the engine and offers to run `init`.

- Install: `claude plugin marketplace add AgentPlugged/agentplugged`, then
  `claude plugin install agentplugged@agentplugged`.
- Then ask Claude Code to start AgentPlugged, or run `/agentplugged:start`: it offers to run
  `init` in the open project.
- The engine runs through npm (`npx -y agentplugged@1.2.0 mcp`); Node.js 24 or later is required.
- The method is installed in your project by `init` (`.agentplugged/`), never by this plugin.

## Français

AgentPlugged installe dans ton projet une méthode complète pour construire un logiciel avec des agents IA (rôles, règles, points de validation), en consommant le moins de jetons possible. Ce plugin est une enveloppe mince : il déclare le moteur et propose de lancer `init`.

- Installer : `claude plugin marketplace add AgentPlugged/agentplugged`, puis
  `claude plugin install agentplugged@agentplugged`.
- Ensuite, demande à Claude Code de démarrer AgentPlugged, ou lance `/agentplugged:start` : il
  propose de lancer `init` dans le projet ouvert.
- Le moteur passe par npm (`npx -y agentplugged@1.2.0 mcp`) ; Node.js 24 ou plus est requis.
- La méthode est installée dans ton projet par `init` (`.agentplugged/`), jamais par ce plugin.

Innovel Studio SASU - https://agentplugged.ai - FSL-1.1-MIT
