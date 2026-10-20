---
name: start
description: Install the AgentPlugged method in the open project, or check it. Use when the user asks to install, start, set up or check AgentPlugged. Installer, démarrer, mettre en place ou vérifier AgentPlugged dans le projet ouvert.
---

# AgentPlugged: welcome / accueil

Answer in the language of the user (English or French).

This plugin installs nothing in the project by itself: it declares the AgentPlugged engine (an MCP
server, version 1.3.0) and brings you here. The method (agents, rules, hooks) is installed in
the project by `init`, in `.agentplugged/`. Nothing is sent anywhere, and nothing is published.

## Steps

1. Look for `.agentplugged/method.yaml` in the open project.
2. If it exists, the method is already installed. Run `npx -y agentplugged@1.3.0 doctor`,
   report what it says in a few lines (it tells how the method was installed and what is left to
   fix), and stop. Never run `init` again unless the user asks for it.
3. If it does not exist, offer to install it, in one sentence, and wait for the answer. Then ask
   which profile fits the project, once:
   - `new-product`: a product that does not exist yet;
   - `maintenance`: a product that already exists and that you maintain;
   - `launch-only`: a finished product that only needs its launch;
   - `prototype`: an experiment.
4. Run, in the project folder (replace `<profile>`):

   ```
   npx -y agentplugged@1.3.0 init --channel claude-plugin --profile <profile> --yes
   ```

   It is the same `init` as `npx agentplugged init`; `--channel claude-plugin` only notes, on this
   machine, that the method came from this plugin, so that `doctor` can say it.
5. Report the result in a few lines, then tell the user to talk to Noah, the main assistant, to
   start (the files of the tools are written by `init --yes`).

## Rules

- Node.js 24 or later is required; if `npx` is missing, say so and stop.
- Do not edit `.agentplugged/` by hand, and do not copy anything of the method elsewhere.
- Never publish, push or send anything.
