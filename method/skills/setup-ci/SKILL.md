---
name: setup-ci
description: Set up the product's base CI (lint, tests, build, audit) for its forge, never over an existing one; the creator merges it. Run by Omar.
metadata:
  agent: omar
  phase: build
---
# Set up the CI

> **The creator's Git workflow, not the method's.** Read `git` in `state.next` or `state.get`: stories land on `git.branches.integration` (else the main branch), may have no pull request (`git.merge` `direct`), and the CI is the creator's choice (`git.ci` `none`). "The main branch" and "the pull request" below mean those.

## Overview

- **Step:** before the first story of the build (`state.next` proposes it, `setup_ci`), as Omar
  (`agent: omar` in every MCP call). A failed check (`story.ci`) sends the story to its developer.
- **Produces:** `.github/workflows/ci.yml` or `.gitlab-ci.yml` from the templates in `assets/`, in a
  branch of its own for the creator to merge; its description in `.agentplugged/docs/runbook.md`.
- **Reads:** `package.json`, the lock file, `.nvmrc`.
- **Validation point:** the creator action `forge_merge_ci` (step 4).

## Steps

1. **Start.** `agent.status` (`working`). `state.get`: `phase.current` should be `build` (or null);
   earlier: stop. An existing CI (`.github/workflows/`, `.gitlab-ci.yml`,
   `.circleci/`, `azure-pipelines.yml`, `Jenkinsfile`…) is never replaced: compare it with the four
   checks, propose what is missing, go to step 4. `npx agentplugged ci setup` lists as `Not checked
   by the CI` the test scripts (`test:api`, `test:integration`, `test:e2e`) it skips: add them to
   the `test` job (skill `api-e2e-tests`, reference `ci`).
2. **Generate.** `npx agentplugged ci setup`. Forge: `ci.forge` in `.agentplugged/method.yaml`, else
   the `origin` host; if neither says it, ask, run `--forge github|gitlab`, propose setting
   `ci: { forge: … }`. Read every `TODO`. Four jobs named `lint`, `test`,
   `build`, `audit`, running the product's own scripts and the package manager's audit.
3. **Complete.** Replace each `TODO` and the step that fails on purpose after it with the real
   command. Keep one job per check, with its name. Never weaken a check (`continue-on-error`,
   `allow_failure`, `|| true`, a skipped test): one that cannot pass yet is a `decision`
   checkpoint, never a silent green. Secrets by name only (`${{ secrets.NAME }}`).
4. **Deliver.** Branch `ci/base-workflows`, commit, `git push origin ci/base-workflows` (never the
   main branch, never forced). Never `gh` or `glab`, no pull request by hand: the engine delivers
   once the creator approves in the chat; they type no command.
   - No `origin`: `guard.creator_action` `forge_repo_create` {forge, name} (private by default),
     then `forge_push_main` {}.
   - Then `forge_merge_ci` {branch: `ci/base-workflows`}: the engine opens the pull request and
     merges it on the commit the creator saw, if only CI files and documentation changed. Present
     the repository, branch and commit it names.
   - Runbook: each check, what it proves, what to do when it fails (header `id`, `kind: note`,
     `owner: omar`, `links`); `npx agentplugged docs check`.
5. **Report.** `story.result` `complete` (workflow, checks, branch, assumptions; `partial` with a
   `TODO` left); `agent.status` `idle`. Tell the creator what the engine did (`executed`); on
   `FORGE_GESTURE_FAILED` say what it says, they fix it, you ask again. Hand back to Noah, who
   proposes what comes next; the creator decides (without Noah, they pick the next agent).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never write over an existing CI, nor edit a CI file the creator wrote without a pull request.
- Never merge, never push to the main branch, never deploy: the repository, the first push and the merge are requests the engine carries out.
- Never weaken, skip or re-run a check to turn it green; never put a secret's value in the repository.
