---
name: setup-ci
description: Set up the product's base CI (lint, tests, build, audit) for its forge, never over an existing one, for the creator to merge. Run by Omar.
metadata:
  agent: omar
  phase: build
---
# Set up the CI

> **The creator's Git workflow, not the method's.** Read `git` in `state.next` or `state.get` before you act: the branch a story lands on is `git.branches.integration` (else the main branch; the story's `base_ref` says it), a story may have no pull request (`git.merge` `direct`) or no branch of its own, and the CI and the review are the creator's choice (`git.ci` `none`, `git.review` false). Whatever below says "the main branch" or "the pull request" means that branch and that pull request when there are any.

The CI is what lets the creator see only green pull requests. Each check it runs is one name the
engine reads back (`story ci`, `story.ci`): a failed check sends the story to its developer, who
fixes it on the same branch. This skill writes that CI once, from the method's templates, and
leaves it to the product: the engine never writes it again.

This skill belongs to Omar. Run it as Omar, with `agent: omar` in every MCP call. Work in the
creator's language; keep commands, file names and check names as they are.

- **Inputs:** the product's `package.json` and lock file, `.nvmrc` when there is one, the
  architecture and the test strategy (`.agentplugged/docs/`), the runbook when it exists.
- **Output:** `.github/workflows/ci.yml` (GitHub) or `.gitlab-ci.yml` (GitLab), delivered in a
  branch of its own, pushed for the creator to open and merge, and its description in the runbook.
- The CI comes before the first story of the build: `state.next` proposes this skill then
  (`setup_ci`), even though Omar's own phase is the delivery.

Follow the steps in order. Each one ends with what it must have produced.

## Step 1 — Check where the product stands

1. Call `agent.status` (`working`, task "CI setup").
2. Call `state.get`: `phase.current` should be `build` (or null when the profile has no phases).
   In an earlier phase, say which phase is current and stop.
3. Look for an existing CI: `.github/workflows/*.yml`, `.gitlab-ci.yml`, or another system's file
   at the repository's top (`.circleci/`, `azure-pipelines.yml`, `Jenkinsfile`…). When one
   exists, never replace it: compare it with the four checks below, propose what is missing to
   the creator, and go to Step 4. `npx agentplugged ci setup` lists, as `Not checked by the CI`, the
   test scripts (`test:api`, `test:integration`, `test:e2e`) the CI does not run: add them to the
   `test` job (skill `api-e2e-tests`, reference `ci`).

**Produces:** the phase confirmed, and whether a CI already exists.

## Step 2 — Generate the workflow

1. Run `npx agentplugged ci setup` at the repository's top. The forge is `ci.forge` in
   `.agentplugged/method.yaml` when set, else the `origin` remote's host (`github.com`,
   `gitlab.com`, or a host starting with `github.` or `gitlab.`). When neither says it (a forge
   hosted under another name), ask the creator which one, then run
   `npx agentplugged ci setup --forge github` (or `--forge gitlab`), and propose to set
   `ci: { forge: … }` in `method.yaml` so that reading the CI finds it too.
2. Read what it says: the file written, the stack it recognised (pnpm, npm, yarn, or other), and
   every `TODO` left. It writes nothing when a CI exists (`exists`).

The workflow has four jobs, one check each, named `lint`, `test`, `build` and `audit`. Each one
installs the dependencies as locked and runs the product's own script (`lint`, then `typecheck`
when it exists; `test`, then `test:api`, `test:integration` and `test:e2e` when it has them; `build`), or the package manager's audit of high-severity advisories.

**Produces:** the workflow file, and the list of TODOs.

## Step 3 — Complete what the template could not guess

1. Read the file whole. Each `TODO` comment is followed by a step that fails on purpose: replace
   both with the real command — the script the product lacks, or the toolchain of a stack the
   template does not know (from the architecture: language, version, package manager).
2. Keep one job per check and keep their names: the engine reports failed checks by name.
3. Never weaken a check to make it pass: no `continue-on-error`, no `allow_failure`, no
   `|| true`, no skipped test. A check that cannot pass yet is a `decision` checkpoint for the
   creator, never a silent green.
4. Refer to secrets by name only (`${{ secrets.NAME }}`, `$NAME`), never by value. The base CI
   needs none.

**Produces:** a workflow without a `TODO`, each check meaningful.

## Step 4 — Deliver it

1. Create a branch of its own (`ci/base-workflows`), commit the workflow there and push that
   branch by its name (`git push origin ci/base-workflows`: never the main branch, never
   forced). Never run `gh` or `glab` yourself: no pull request by hand, no CI or repository
   setting (the engine delivers it). The creator types no command either:
   the engine delivers it once they approve.
   - When the product has no remote repository yet (no `origin`), ask the creator for it first
     (`guard.creator_action`, `forge_repo_create` {forge, name}: private by default), then,
     for the main branch that was never pushed, `forge_push_main` {}. Each is a request the
     creator approves in the chat, confirming the action ("yes, create the private repository
     shop on GitHub"); the engine does it with the forge's tool they connected.
   - Then ask for the merge: `guard.creator_action`, `forge_merge_ci` {branch:
     `ci/base-workflows`}. The engine opens the pull request (its title and text are fixed)
     when there is none, and merges it on the commit the creator saw, if only the CI's files and
     the product's documentation changed in the branch and the branch is at the remote exactly as
     it was read. Present the request as it asks: the repository, the branch and the commit it
     names; never merge anything yourself.
2. Describe the pipeline in `.agentplugged/docs/runbook.md` (create it with its YAML header when
   it does not exist: `id`, `kind: note`, `owner: omar`, `links`): each check, what it proves,
   and what to do when it fails. Run `npx agentplugged docs check` and fix what it reports.

**Produces:** the branch of the CI, pushed, and the runbook updated.

## Step 5 — Report

1. Call `story.result`: `complete`, a summary naming the workflow, its checks and the
   branch, your assumptions (a script you inferred, a version you chose), the open questions and
   the conflicts. `partial` when a TODO is left, saying which.
2. Call `agent.status` (`idle`).
3. Tell the creator what the engine did once they approved the merge (`executed` in the
   result): from then on, every story's pull request runs these checks, and a failed one goes
   back to its developer. When a request answers `FORGE_GESTURE_FAILED`, say what it says
   (the forge's tool not logged in, a branch not pushed, a remote ahead of the main branch…):
   the creator fixes it, you ask again.
   Then hand back to Noah, who proposes what comes next; the creator decides (without Noah, the
   creator picks the next agent).

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never write over an existing CI, and never edit a CI file the creator wrote without a pull
  request.
- Never merge, never push to the main branch, never deploy: the repository, the first push of
  the main branch and the CI's merge are requests the engine carries out for the creator, never
  commands you run nor ones the creator types.
- Never weaken, skip or re-run a check to turn it green.
- Never put a secret's value in the repository.
