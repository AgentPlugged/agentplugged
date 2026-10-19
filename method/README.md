Agents and skills (SKILL.md) shipped by `agentplugged init`, and `models.yaml`: the model of each
tier for each AI tool, copied into `.agentplugged/models.yaml`.

## The team

Each agent has a single role and owns its deliverables, in `.agentplugged/`. One agent routes:
Noah, the creator's right hand, active in the main session of the AI tool without any command
to type (the "Main session: Noah" section of the constitution). The creator talks to him in plain
language, typed or dictated; he hands each request to the agent or skill that owns it, in the
conversation or as a sub-agent, reports back, and presents what waits for the creator as one stack. He writes
no document and no code. The other agents never call, direct or coordinate one another: they hand
back to Noah when their work is done, and the creator decides. Once `sync` has run, an agent can
still be called directly by its id in your AI tool (`/iris` in Claude Code, for example).

| Id | Agent | Domain | Phase | Model tier | Deliverables |
| --- | --- | --- | --- | --- | --- |
| `noah` | Noah, Main Session Assistant | product (serves every domain: never inactive by the profile) | every phase | reasoning | none: he hands the work over and reports back |

Noah is turned off with `npx agentplugged agent disable noah`: the constitution then loses his
section, and the main session reports as `main`.

The eighteen agents of the team, by domain:

| Id | Agent | Domain | Phase | Model tier | Deliverables |
| --- | --- | --- | --- | --- | --- |
| `iris` | Iris, Product Analyst | product | framing | reasoning | `docs/brief.md`, research notes in `docs/research/` |
| `maya` | Maya, Product Manager | product | planning | reasoning | `docs/prd.md` |
| `izzy` | Izzy, Scrum Master | product | build | fast | `epics/`, `stories/`, and the sprints, in the journal |
| `stella` | Stella, Product UX Designer | ux | planning | multimodal | `.agentplugged/docs/ux.md` (visual identity and behaviour) |
| `alex` | Alex, Architect | architecture | design | reasoning | `docs/architecture.md` |
| `sam` | Sam, Backend Developer | code (`backend`) | build | code | the code and tests of a story, in its branch, and its pull request |
| `ethan` | Ethan, Backend Developer | code (`backend`) | build | code | the same, for the server side and the data |
| `hugo` | Hugo, Frontend Developer | code (`frontend`) | build | code | the same, for the interface |
| `lina` | Lina, Frontend Developer | code (`frontend`) | build | code | the same, for the interface |
| `jade` | Jade, Mobile Developer | code (`mobile`) | build | code | the same, for the mobile applications |
| `quentin` | Quentin, QA Reviewer | quality | build | reasoning | QA reviews in `docs/qa-reviews/`, `docs/drift-report.md` |
| `tess` | Tess, Test Architect | quality | design | reasoning | `docs/test-strategy.md` |
| `chloe` | Chloé, Security Reviewer | security | build | reasoning | `docs/threat-model.md`, security reviews in `docs/security-reviews/` |
| `omar` | Omar, Delivery Engineer | delivery | delivery | code | `docs/runbook.md`, the CI and the deployment |
| `zoe` | Zoé, Documentation Writer | docs | build | fast | the knowledge base: `docs/index.md`, `vision.md`, `conventions.md`, `guides/`, `reference/`, `release-notes/` |
| `lou` | Lou, Creative Facilitator | creativity | framing | reasoning | ideation notes in `docs/ideas/` |
| `julien` | Julien, Launch, Marketing & SEO | marketing | launch | multimodal | positioning, pages, content and the search plan in `docs/launch/` |
| `milo` | Milo, Sales | sales | launch | reasoning | offer pages and email sequences in `docs/sales/` |

The product team works in this order: framing (Iris) → planning (Maya, then Stella) → design
(Alex, with Tess for the test strategy and its coverage map, and Chloé for the threat model) →
build (Izzy first: the breakdown and the sprint open the build phase; then the developers, and
Quentin and Chloé, who review each pull request separately) → delivery (Omar). Lou helps on
demand, above all during framing; Zoé keeps the knowledge base current; Julien and Milo work in
the launch phase. A document counts as approved when the checkpoint that cites it (its `document` point, or the end of its phase when it is the last document of the phase) is resolved `approved`
in `state.get` (`state.get { checkpoints: { status: "resolved" } }` lists the answered checkpoints, with the documents they cite).

Each phase ends with a `phase_end` checkpoint that the creator approves: Iris opens the end of
framing, Maya the end of planning, Alex the end of design, Izzy the end of build, Omar the end of
delivery and Julien the end of launch. When that agent is not active, another one closes the
phase: Lou for framing, Stella for planning, an active developer (Sam, Ethan, Hugo, Lina, then
Jade) for build, Milo for launch; without any of them, the creator's main session (agent `main`). Only
these agents may open the end of their phase, and the creator never waives it. The next phase starts only after that approval; `state.get`
gives the current phase in `phase`, and `npx agentplugged next` shows it with the agent to call.
The phases the profile turns off, or whose domains are all inactive, are skipped. After the last
phase, the method loops on the build (story by story), then delivery and launch again.

Quentin and Chloé each write their review and submit it (`story.result`) before reading or
posting any comment on the pull request, and neither opens the other's review folder before
submitting. When the profile has no quality agent, the creator does the review before merging.

The developers work in the story's branch and working copy, declare their progress,
and never merge: the engine does, once the creator approves the merge. Each developer has a specialty, a domain of the product and
never a language: `backend` (Sam and Ethan: the server side and the data), `frontend` (Hugo and
Lina: the interface), `mobile` (Jade: the mobile applications). None of them names a language, a
framework nor a stack: each one reads the product's stack in the architecture
(`.agentplugged/docs/architecture.md`) and the knowledge base, whatever it is, and follows it.
Each story is built by one instance of a developer, the pair (developer, story), shown as
"Sam · story 4-2": two stories may go to the same developer, never two developers to one story;
a story another developer started is refused (`started_by_other`).

Small changes take the quick lane, a mode of the developer the story goes to, carried by the
story and described in the shared `quick-lane` skill: there is no dedicated agent. A change fits
it only with one story, no public interface changed, no data migration, no dependency added,
fewer than 5 files touched (test files included, a renamed file counts twice). A quick change
always has a story, if only one line long — when none exists, the developer asks the creator to
have Izzy write it — built in the story's own branch like any other (`feat/<story>-<slug>`). The
developer enters the quick lane when the story starts (`story.start` with `fast_track`: the change
in one sentence and three declarations only they can make — the goal has one reading, nothing in
it is irreversible, no public interface changes); the story then carries the mode. The engine
reads what it can in the repository at every pull request and CI read — the number of files, the
dependency manifests and lockfiles, the migration files, the files of an interface's contract —
and sends the story back to the full lane when one no longer holds; the developer leaves on their
own (`story.leave_fast_track`) when its goal can be read two ways, a step could not be undone or the
change keeps spreading. Either way the way back is final, a `decision` checkpoint explains it to
the creator, and the story is blocked until they answer. The independent review and the creator's
validation before merging always apply. Noah proposes the quick lane when it fits; the creator
decides.

A story starts with the `story.start` MCP tool, or `npx agentplugged story start <id>`. The
engine checks that it may start: validated at its current content and on the main branch, in the
sprint in force when there is one, its dependencies done. It then creates the story's branch
(`feat/<id>-<slug>`) from the main branch and a Git worktree of its own next to the repository
(`../<repo>.worktrees/<id>`), records `story.started` and installs a `commit-msg` hook. Each
developer's AI tool is opened in that folder, so two stories advance side by side without
touching each other's files. On a story's branch, the hook refuses a commit whose message does
not cite the story and one of its requirements (`feat(2-3): sign-in form (EF-12)`); a hook the
creator already had is kept and runs first. Only the creator may skip it, with
`git commit --no-verify`: the constitution forbids it to agents.

The developers build a story with the `develop-story` skill, from a fresh context: the story, the
documents it cites and the knowledge base pages about them, never a conversation. An ambiguous or
contradictory intent becomes a `decision` checkpoint, and the `## Intent` section is never edited.
The builder's `complete` result on a story `in_progress` moves the story to `in_review`: the
builder is the agent that started it (`story.started`), never a reviewer nor an agent that took it
over. `story.result` records the move in the same write, as an explicit `story.status_changed`.
Both this move and `story.status` `in_review` are refused while a checkpoint blocks the review
(`CHECKPOINT_OPEN`), or while the last
commit of the story's branch changes its approved intent (`STORY_INTENT_CHANGED`), the story
being found there by its id. `state.next` then proposes the review.

A story is delivered with the `story.pr` MCP tool, or `npx agentplugged story pr <id>`.
The engine renders the pull request's text with a fixed template — the story and a link to it,
its requirements, its acceptance criteria as checkboxes (checked by the developer), the tests'
result — pushes the story's branch, never the main branch and never forced,
then opens or updates the pull request with the forge's command-line tool the creator logged in
once: `gh` for GitHub, `glab` for GitLab, chosen from the address Git really pushes to. It
records `story.pr_opened`. It shows no cost: what the sessions consumed is measured by the engine
and kept in the journal, in case a module reads it.
Agents never run `gh` or `glab` to open, edit or comment a pull request themselves: the
constitution says it. The rules `sync` writes deny only what gives away or destroys: merging a
pull request by hand, `auth` (the token), `config get`, deleting the repository, and reading the
tools' login files, in Claude Code and Cursor. When the forge is not
linked (no remote, neither GitHub nor GitLab, the tool missing or not logged in), nothing is
pushed and the agent's call opens a checkpoint that tells the creator how to link it.

The CI checks every pull request. While the repository has none at its top (no workflow directly
in `.github/workflows/`, no `.gitlab-ci.yml` nor another system's file), `state.next` calls Omar during the
build, whatever stories are under way (`setup_ci`): his `setup-ci` skill runs
`npx agentplugged ci setup`, which writes the base CI for the forge (`--forge github|gitlab`, else
`ci.forge` in `method.yaml`, else the `origin` remote's host) from the templates of
`skills/setup-ci/assets/`: four jobs, one check each, `lint`, `test`, `build` and `audit`, adapted
to `package.json` (pnpm, npm or yarn, the Node version of `.nvmrc`). What it cannot guess is a
`TODO`: a step that fails on purpose, or a note in the header. It never writes over a CI, the file
is the product's, and it runs only at the repository's top: `state.next` never proposes it from a folder
of the repository. Once a story's pull request is open, its developer reads the CI with the
`story.ci` MCP tool, or anyone with `npx agentplugged story ci <id>`, through the forge's tool
(`gh`, `glab`) the creator signed in: only an open pull request of this repository counts, and only
checks run on the head of the story's branch. `story.ci_reported` records the status, the failed
checks, the commit and when it was read. A failed CI sends a story in review back to development,
and `state.next` relaunches its developer on the same branch (`ci_failed`, with the failed checks); a
story in review whose CI is not green and read since it was sent there is read first
(`ci_check`). When the CI cannot be read (no CI Omar can set up, no forge, no tool), `state.next` says
so and gives the creator's way out: asked in the chat (`guard.creator_action`, `ci_waive`, one
answer, the engine carrying it out once approved), valid for the branch's current commit only, and
with its reason recorded in the journal. `story ci <id> --waive
"<reason>"` stays the same acceptance for the `strict` level, signed by the creator's key.
A story's merge checkpoint (an open `story` checkpoint of a started story) is never asked of the
creator, by `state.next` nor `review`, and never approved, until its CI is green (or waived) on the
branch's head and its review is done (`MERGE_NOT_READY`); one that blocks stays in `waiting`.

Every story in review, its CI green, is reviewed independently before the creator sees its merge
(EF-32): by an agent of the quality domain, and by one of the security domain when the story
concerns security (its diff touches dependencies, CI, infrastructure, secrets, authentication,
rights or payment; its text speaks of them; its header names a security reviewer; or the quality
reviewer asks). Never by the story's developer, nor `main`, nor Noah. With the `review-story`
skill, each reviewer calls `review.start`, which writes the diff of the story's branch to
`.agentplugged/.cache/reviews/`, reads it with the story and what it cites, and nothing of the
other reviewer nor of the author's reasoning, then calls `review.submit` with its findings: the
engine computes the verdict (a blocking finding fails it). The engine also chooses, from the risk of the change, the lenses to run (adversarial, edge cases, verification gaps, structure, prose, relevance, security), each a short reference of the skill read when it runs, in a sub-agent that reads only its part of the diff; a judge in a fresh context checks each acceptance criterion; the engine refuses a report that is not whole, merges the same finding seen twice without ever dropping a blocking one, and shows the creator a short stack. The reviews of one stay in review make
a pass; once every review it needs is in, the pass is closed and the engine posts each review on
the pull request, one comment per finding on its line, with the forge's tool the creator logged
in (`review.publish` posts again a pass the forge did not take). A pass with a blocking finding
sends the story back to its developer, who sorts each finding with `review.triage` (fix, defer
with an item of deferred work, or reject with its reason) and its root cause; a pass without one
opens the story's merge checkpoint, shown to the creator once every finding is sorted. After 5
passes closed without agreement, a checkpoint asks the creator whether to go on. `state.get` shows
only the counts of a review; `review.get` gives the developer the findings, and each reviewer its
own. A deviation reported on a story with a pull request is posted there as a comment too.

Only the engine merges a story, and only once the creator approves its merge checkpoint
(`source: merge`, a medium risk: a `git revert` undoes a merge) at the level in force: with one
answer, in the AI tool's form (`chat.ask`) or in the chat (`chat.answer`), with no second
message and no sentence to repeat; at the `strict` level, a tool without the hook answers at the
terminal (`review`). A pull request the creator already merged on the forge, on the commit
reviewed, is recorded by the same answer (`already`). Once everything allows the answer (the quote, the merge
gate on the branch's head, the pull request, the forge's tool installed and logged in), the
engine merges the reviewed commit of the story's pull request with the forge's tool the creator
logged in (`gh`, `glab`; `pr.merge_method` in `method.yaml`: `merge` by default, `squash` or
`rebase`), never deleting its branch nor bypassing the forge's protections, then records the
answer and `story.merged` in one write, then removes the story's worktree (never forced: changes
not committed keep it, and so does a branch checked out in another folder). The story is then
delivered. When the forge refuses (a conflict, a protected branch, the pull request moved on or
closed: `MERGE_FAILED`) or is not linked (`FORGE_NOT_LINKED`), nothing is merged nor written
and the checkpoint stays open; a merge whose record was refused (`not_recorded`) is recorded,
without merging again, at the next answer. When the creator refuses the merge or asks for
changes, the story goes back to its developer with their note (`merge_feedback`, the
`merge_changes` step of `state.next`), and nothing is merged. No agent has a tool that merges.

The merges are ordered (EF-29). Among the stories ready to merge (merge checkpoint open, merge gate
open), the engine orders them by the stories' dependency graph, then the sprint in force, then
the opening of their merge checkpoints, then their number: a story merges after its dependencies,
and after every earlier ready story that changes a file in common (stories with no file in common
merge in any order). `state.next` shows `merge_queue` when two or more wait, and presents their merge
checkpoints in that order; the engine refuses a merge out of it before the forge is asked
(`MERGE_FAILED`: `out_of_order`, `dependency_unmerged`, `dependency_cycle`). No tool takes an
order: it changes with the dependencies or the sprint, which the creator validates, or when the
creator sends a story back for changes (it leaves the queue). Izzy reads the queue with
`state.merge_order` (the `order-merges` skill) and tells the creator in words; she never merges nor
reorders.

A conflict with the main branch is read by the engine itself (Git, nothing written) and qualified
by the story's developer before it is resolved (`story.merge_conflict`, the
`resolve-merge-conflict` skill). The engine fixes a ceiling from what it can decide without
parsing any language: the same lines changed on both sides, a large addition, a deleted, renamed
or binary file are a conflict of substance; the same code up to spaces is text; added lines at the
same place are left to the developer's declaration. The developer may keep the ceiling or raise it,
never lower it. A **textual** conflict is resolved by the developer on the story's own branch, by
merging the main branch into it (never a rebase: the constitution forbids `git rebase` and `git pull
--rebase` to agents), keeping every line of both sides; the story goes back to review, so the CI
and the review cover the new commit, and the merge checkpoint left open is refreshed with that
pass and commit (`story.merge_refreshed`). A conflict **of substance** opens a `decision`
checkpoint with both versions of each block (never the lines of a sensitive file) and the
developer's recommendation: the creator chooses `keep_story`, `keep_main` or `combine` in the chat
(or the AI tool's form), and the developer applies the choice. At the merge
the engine reads the branch again and refuses (`MERGE_FAILED`) a branch still in conflict
(`conflict`), a conflict marker left (`conflict_markers`), a merge of the main branch that
resolved a conflict nobody qualified (`conflict_unqualified`: qualify it after the fact), a
resolution that lost a line it promised to keep (`conflict_dropped`) and a history it cannot read
or a branch rebased (`conflict_unverified`).

Every requirement of the PRD (`EF-n`, `ENF-n`) is traced, at read time, to the stories that cite
it, their pull requests and the tests that cite it, with a status: to do, in development, in
review, delivered, or deviation. `npx agentplugged trace` shows them all, `trace <EF-n>` one in
detail (`--json` for scripts), and the `state.trace` MCP tool gives agents the same. A test cites a
requirement in any language by writing its id in its name, in a comment or in its file's name,
`EF-18`, or `EF_18` where a name takes no dash, in a test file (a `test`, `tests`, `__tests__`,
`spec`, `specs` or `e2e` folder, or a name such as `*.test.*`, `*_test.*`, `test_*`, `*Test.*` or
`*.t`; never a document nor a data file); the tests are
read through Git in the working copy where `trace` runs. The quality reviewer compares a story's
work with its requirements with the `check-requirements` skill, during the build and at the
latest before the merge, and records each gap with the `story.deviation` MCP tool: a deviation
`V-…`, attached to the story, its pull request and the requirement. A story in review goes back
to its developer, and a story with an open deviation is never presented for its merge
(`MERGE_NOT_READY`). The agent that reported it lifts it with `story.lift_deviation` once the fix is
verified, never the story's developer; the creator may lift any, in the chat (`guard.creator_action`; `npx agentplugged trace resolve <V-id>
"<why>"` is the same at the `strict` level).

Omar never deploys to production without an approved `release` checkpoint. One exception: when
production is down, he may roll back to the last approved release at once, then immediately
opens a `release` checkpoint that reports it.

Julien and Milo never publish, send nor pay anything: each deliverable is ready to publish and
opens a `publication` checkpoint.

The positioning is the document the launch builds on. It lives in
`.agentplugged/docs/launch/positioning.md` (header: `id: positioning`, `kind: note`,
`owner: julien`, `links` naming the knowledge base pages it is drawn from, `language`; five
sections: audience, problem, promise, difference, evidence). It is **validated** when the last
*approved* `publication` checkpoint (`approved` or `approved_with_reservations`; never a waiver,
never an option picked) citing that file cites the very blob of the file as it stands: a draft, an open or refused checkpoint, or a file edited since the approval is not
validated, and `docs check` warns about a page that builds on one of those. Julien's contents
and Milo's offers read the validated positioning and never redefine it. Each page of the website
is a file of `.agentplugged/docs/launch/pages/`; its header carries `links` (with `positioning`),
`language` and `seo` (`intent`, `title`, `description`, `keywords`): `docs check` verifies those
fields and that a keyword either carries a volume with its source, its date and its provenance
(`untrusted` when read outside the product) or is marked `hypothesis: true`. When the knowledge
base lacks a fact the message needs, Julien opens a `decision` checkpoint instead of guessing.

Milo sells from that validated positioning and produces nothing without one. His offer pages are
files of `.agentplugged/docs/sales/offers/` (`id: offer-<slug>`) and his email sequences, files of
`.agentplugged/docs/sales/sequences/` (`id: sequence-<slug>`); the header of each carries `links`
(with `positioning`), `language` and a `sales` block: its `goal`, its `audience`, the blob of the
positioning it was written from and, for an offer, its `pricing` (`free`, `none`, or `stated` with
the creator's amount and the date of their decision: Milo never invents a price), for a sequence,
its `type` (`prospecting` or `follow_up`), how to opt out, the stop condition and, for every email,
its subject and its delay. A sequence is written ready to copy, and its **Before you send** section
reminds the creator of consent, opting out, the sender and the rules of the recipients' countries,
without legal advice. Milo never sends an email nor loads a sequence into a tool.

On a validated positioning, Julien also writes contents and campaign plans (skill
`write-content`). An article or a community post is a file of `.agentplugged/docs/launch/content/`
(`id: content-<slug>`), a campaign plan a file of `.agentplugged/docs/launch/campaigns/`
(`id: campaign-<slug>`). Each one links to `positioning` and to at least one page of the base (or
of the site) it uses, carries `language` and a `content` block (`type`, `channel` for an article or
a post, `positioning_blob` — the version of the positioning it was written on —, `goal` with a
metric, a target, a date and how it is observed, and `references`). A figure or an outside claim
has its entry in `references` (claim, source, provenance `untrusted`, `creator` or
`knowledge_base`, and the date read when it comes from outside): what was read outside is declared
before it is read, attributed in the text and never stated as the product's own claim. A campaign
plan has its objective, audience, channels, calendar, budget, measurement and creator actions,
and plans nothing for an agent to do: the creator publishes, sends, books and pays. `docs check`
verifies the header, the links and the sections, and warns about a figure with no source, a
content written on another version of the positioning than the one in the file, or on a
positioning that is not validated. Each deliverable opens a `publication` checkpoint.

### Developers by specialty

The developers are chosen by specialty, not counted. `profile.specialties` in
`.agentplugged/method.yaml` lists the active ones, without duplicates, among `backend`,
`frontend` and `mobile`: empty when the `code` domain is off, at least one when it is on. Only
the developers of the active specialties are active: `sam` and `ethan` for `backend`, `hugo` and
`lina` for `frontend`, `jade` for `mobile`. `init` and `npx agentplugged profile` propose the
specialties.

`profile.max_parallel_stories` (a whole number from 1 to 99, optional) caps the stories in
progress at once, all specialties together: while the stories started and not done reach it, one
more is refused (`parallel_limit`) and waits for an instance to free up. Without it, there is no
ceiling.

A developer is an agent of the `code` domain that carries `metadata.specialty` in its `SKILL.md`.
A custom agent of the `code` domain with a specialty of its own (embedded, data, games…) adds that
specialty: it is a developer like the others, and its stories go to it.

There are no clones of a developer: two stories given to Sam are two instances, "Sam · story 4-1"
and "Sam · story 4-2", each in its own branch and working copy. In Claude Code, `sync` gives each
developer `isolation: worktree`; in the other tools, the developer works in the working copy
`story.start` returns, and the fallback is reported in the compatibility matrix.

Requirement identifiers, each defined once in the product and never renumbered nor reused:
`EF` = functional requirement, `ENF` = non-functional requirement, `PU` = user journey, `MS` =
success metric (all in the PRD), `AD` = architecture decision (in the architecture). To retire
one, keep it in place with the marker first after the separator: `EF-2 : (retired) …`,
`### AD-3 — (retired) …`.

Izzy breaks the approved plan down with the `split-into-stories` skill: epics `epic-<n>` in
`epics/`, stories `<epic>-<story>` in `stories/` (numbers from 1), each with the full story header
and four sections, in English or in French (`## Context` or `## Contexte`, `## Intent` or
`## Intention`, `## Acceptance criteria` or `## Critères d'acceptation`, `## Out of scope` or
`## Hors périmètre`). `docs check` then refuses a section missing, empty or given twice
(`STORY_SECTION_INVALID`), a template marker `<…>` left behind (`DOC_PLACEHOLDER_LEFT`), an active
`EF-n` or `ENF-n` of the PRD that no story covers unless an epic lists it in `out_of_scope`
(`REQ_NOT_COVERED`), a dependency on a later story and a dependency loop. Izzy ends with a
`document` checkpoint per epic; the `review` card shows each intent it would freeze. Once the
creator approves it, the intent of each story it lists is frozen: `docs check` fails if it changes
(`STORY_INTENT_CHANGED`), until a new `document` checkpoint on the story is approved. What it
cannot verify (a blob Git does not hold, a journal it cannot read, a story this branch never had)
is a warning, never a failure.

Izzy then plans sprints with the `plan-sprint` skill: a goal, validated stories that are not done,
in an order where each dependency is done or comes first, and the capacity (the developer agents
and the humans who build them). She records the sprint with the `plan.sprint` MCP tool, which adds
up the stories' `budget_usd` against the ceiling the creator gives and refuses a story budgeted
more than three times off what the product measured, or off the method's reference
(`budget_out_of_range`); an invalid sprint is refused (`SPRINT_INVALID`) and nothing is
written. Otherwise the sprint goes to
the journal with a `document` checkpoint that shows it to the creator, and it is in force once
the creator approves that checkpoint; a sprint approved later replaces it. `state.next` then proposes
the stories of the sprint in force, in order, each to its owner, and calls Izzy again for the next
sprint once none is left to start. The creator may ask for the next sprint at any time.

When an epic is finished (all its stories done) or a sprint is (its stories done, or replaced by a
later sprint), `state.next` proposes its retrospective to Izzy (`run-retrospective`). She looks at the
evidence, reads the memory, and proposes lessons, retirements and actions with
`memory.retrospective`: the engine opens a `memory` checkpoint (counts only, the content is
encrypted with the product key) and the creator validates it in the chat, whole or with
reservations. `memory.record` then writes each approved lesson as an encrypted file of
`.agentplugged/memory/lessons/`, anchored in the journal by its digest. Every agent calls
`memory.read` at the start of a task and gets the approved, active lessons for it, plus the
creator's shared ones: advice that never overrides the constitution, the permissions or the
creator. Agents never write the memory directly (`guard.write_sensitive` refuses `lessons/` and
`retros/`). A lesson useful to all the creator's products is promoted, one checkpoint per
promotion, to `~/.agentplugged/memory/` on their machine, outside every repository, encrypted with
a key derived from the machine key: nothing is sent to a server, and the shared memory does not
follow the creator to another machine.

Each agent is a folder of `agents/`: `SKILL.md` (overview, mission, deliverables, way of working,
boundaries) and `agent.yaml` (persona, principles, persistent facts, menu and voice). `voice`
(`tone`, `pace`, `register`) describes how the agent sounds in the spoken briefing; a
customisation in `.agentplugged/overrides/agents/<id>.yaml` replaces it whole.

## Skills

Each skill is a folder of `skills/`: `SKILL.md` (the workflow, step by step), and its
`assets/` (document templates) and `references/` (checklists). `sync` renders it in every AI
tool, like an agent; the agent named in its `metadata.agent` calls it from its menu, and the
creator may also call it directly (`/write-brief` in Claude Code, for example). A skill never
calls another agent.

| Skill | Agent | Phase | Writes |
| --- | --- | --- | --- |
| `write-brief` | Iris (`BR`) | framing | `.agentplugged/docs/brief.md`, research notes in `.agentplugged/docs/research/`, then opens the end of framing |
| `write-prd` | Maya (`PR`) | planning | `.agentplugged/docs/prd.md` (`PU`, `EF`, `ENF`, `MS`), a `decision` checkpoint per ambiguity, then the end of planning when `state.next` gives it to Maya |
| `write-ux-spec` | Stella (`UX`) | planning | `.agentplugged/docs/ux.md` (visual identity and behaviour, linked to the requirements, with an accessibility check), then the end of planning when `state.next` gives it to Stella |
| `write-brand` | Julien (`BR`), Stella (`BI`) | launch | `.agentplugged/docs/launch/brand.md` (mission, values, voice, name), then `identity.md` and `identity.html` (logo drawn from shapes, palette, type, fixed rules the engine checks on the identity page, the mock-ups and the style files), each validated by a checkpoint |
| `write-architecture` | Alex (`AR`) | design | `.agentplugged/docs/architecture.md`, from its template: decisions `AD-n` with **Binds**, **Prevents** and **Rule**, every version checked or marked `to verify` |
| `security-review-architecture` | Chloé (`AA`) | design | `.agentplugged/docs/security-reviews/architecture.md`, the review attached to the end of the design phase |
| `split-into-stories` | Izzy (`BS`) | build | `.agentplugged/epics/epic-<n>.md` and `.agentplugged/stories/<epic>-<story>.md` from their templates, then a `document` checkpoint per epic |
| `plan-sprint` | Izzy (`SP`) | build | no file: the sprint (goal, stories in order, budget, capacity) recorded with `plan.sprint`, with the checkpoint the creator approves |
| `run-retrospective` | Izzy (`RT`) | build | no file: the lessons and actions of a finished epic or sprint, proposed with `memory.retrospective` and recorded with `memory.record` once the creator approves them (the memory of the product, encrypted, read by every agent with `memory.read`); a lesson promoted, one checkpoint each, to the memory shared by the creator's products on their machine (`memory.promote_propose`, `memory.promote`) |
| `improve-session` | Lou (`IS`) | any | no file: where a costly session or story spent its tokens (`npx agentplugged usage`, read from the measures the engine already took, never from the conversation), with the origin of each figure, and up to three proposed changes (a skill loaded again and again, a file read again, a tool that keeps failing), none applied alone: one gesture of the creator each |
| `order-merges` | Izzy (`OM`) | build | no file: the order of the merges, read with `state.merge_order` and put in words for the creator (the engine computes it from the dependency graph, the sprint in force and the opening of the merge checkpoints, and refuses a merge out of order) |
| `resolve-merge-conflict` | the developers | build | no file: the conflict with the main branch qualified with `story.merge_conflict`, then resolved on the story's own branch by merging the main branch into it, and the story sent to review again |
| `setup-ci` | Omar (`CI`) | build | `.github/workflows/ci.yml` or `.gitlab-ci.yml` (lint, tests, build, dependency audit) from its templates, never over an existing CI, pushed in a branch of its own for the creator to merge, and described in the runbook |
| `generate-knowledge-base` | Zoé (`KB`) | build (run in any phase) | the knowledge base: `.agentplugged/docs/index.md`, `vision.md`, `conventions.md`, `guides/`, `reference/`, `release-notes/`, from the method's documents or from the repository, then a `document` checkpoint to review it |
| `review-story` | Quentin (`RV`), Chloé (`SR`) | build | the independent review of a story's pull request, recorded with `review.submit` (the engine computes the verdict and posts the closed pass on the pull request), and the reviewer's note in `docs/qa-reviews/` or `docs/security-reviews/` |
| `check-requirements` | Quentin (`DR`) | build | no file: each deviation of a story from the requirements it cites, recorded with `story.deviation` (shown on the story, its pull request and the requirement), then lifted with `story.lift_deviation` once the fix is verified |
| `develop-story` | Sam, Ethan, Hugo, Lina, Jade (`MK`) | build | the code and the tests of one story, in its branch and working copy, from the story and the documents it cites; a `decision` checkpoint per ambiguity; a result that moves the story to review |
| `quick-lane` | Sam, Ethan, Hugo, Lina, Jade (`QL`) | build | a small change and its test, in the story's branch and its own working copy, then its pull request; the engine reads the changes against the limits of the quick lane, and a checkpoint explains the way back to the full lane |
| `diagnose-bug` | the developers | build | a bug's cause found with hypotheses (3 to 5, a confidence each, the evidence of each) that the engine keeps in the journal and refuses to see again once ruled out, a test seen red first, a minimal fix after the cause is confirmed, three failed fixes ending in a point for the creator, and no temporary probe left (the engine refuses the review while a line carries the marker `agentplugged:debug`); then the usual review and merge |
| `improve-code` | the developers | build | a cleanup, performance, security or architecture improvement of the code a finding (audit, duplicates, review of the tests, review) names, on one axis, in small steps, with the project's commands run by the engine before the first change and after the last to show behaviour unchanged; then the independent review and the merge |
| `api-e2e-tests` | the developers | build | the product's test framework (from its validated stack: `npx agentplugged tests setup` proposes the one command that runs a criterion's tests in `.agentplugged/proofs.yaml`, the creator accepts it once, the installation goes through the validation of installations) and the API and end-to-end tests of a feature, from its criteria and journeys, named by criterion and seen red then green by the engine |
| `write-positioning` | Julien (`PO`, `PG`) | launch | `.agentplugged/docs/launch/positioning.md` (audience, problem, promise, difference, evidence), then one page per file in `.agentplugged/docs/launch/pages/` with its search fields (intent, keywords, title, description); a `publication` checkpoint for each, never a publication |
| `write-sales` | Milo (`OF`, `SQ`) | launch | on a validated positioning only: one offer page per file in `.agentplugged/docs/sales/offers/` and one email sequence per file in `.agentplugged/docs/sales/sequences/`, each with its goal and its audience, ready to copy, never an invented price; a `publication` checkpoint for each, never a publication nor a sending |
| `write-content` | Julien (`CT`, `CP`) | launch | on a validated positioning only, one article or community post per file in `.agentplugged/docs/launch/content/` or one campaign plan per file in `.agentplugged/docs/launch/campaigns/`, each linked to the positioning and to the pages of the base it uses, with a measurable goal and every figure sourced; a `publication` checkpoint for each, never a publication |

`npx agentplugged docs check` refuses an active decision of a `kind: architecture` document
without its three fields (`AD_FIELDS_MISSING`). While Chloé is active, the end of the design phase
opens only with the architecture and her review in its `documents`, at the versions of the working
copy, the review being one she submitted during the phase for that very architecture: a `complete`
result without a story whose summary starts with `Architecture security review: verdict=…
findings=… blocking=… review=<id> architecture=<id>` (`SECURITY_REVIEW_MISSING` otherwise). `state.next`
calls her once the architecture exists, and again when it changes; the card of `review` shows her
verdict. The end of the design phase goes to the technical lead (the creator).

The `Phase` column is the skill's `metadata.phase`, the phase of its agent; a skill may still
run in another phase when its steps say so.

When `init` creates `.agentplugged/method.yaml` in a folder that already holds the product, it
writes `origin: existing`. Holding the product means an entry at the root other than: `.git`,
`.gitignore`, `.gitattributes`, `.gitmodules`, `.gitkeep`, `.github`, `.agentplugged`,
`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.claude`, `.agents`, `.codex`, `.cursor`,
`.cursorrules`, `.cursorignore`, `.gemini`, `.mcp.json`, `.windsurf`, `.windsurfrules`,
`.aider*`, `.continue`, `.editorconfig`, `.vscode`, `.vs`, `.idea`, `.fleet`, `.zed`,
`.devcontainer`, `.DS_Store`, `Thumbs.db`, `desktop.ini`, `README*`, `LICENSE*`, `LICENCE*`,
`COPYING*` (names compared without case) — nor what installing agentplugged alone leaves: a
`package.json` whose one dependency is `agentplugged`, its lock file and `node_modules`. A
folder it cannot read counts as empty. The `maintenance` profile counts as an existing product
too while `origin` is absent; `origin: new` says otherwise.

On an existing product with the `docs` domain on and Zoé active, `state.next` calls Zoé to generate
the knowledge base (`knowledge_base`) while `.agentplugged/docs/index.md` is neither a non-empty
file of the working copy nor of the main branch. It comes after what waits for the creator (a
blocking checkpoint, a key, `sync`, an open end of phase), a refused end back to its agent, a
story under way and the delivery, and before the rest of the phase's work. While Zoé's
`document` checkpoint citing the map is open, the step is `knowledge_base_review`; while one of
her `decision` checkpoints waits, `knowledge_base_decision`: both for the creator, with
`review <G-id>`.

The knowledge base stays true to the validated documents. A page of the base (a document of
`.agentplugged/docs/` owned by Zoé) records in its header field `sources` each method document
it was built from, with the Git blob of the version read (`path`, `blob`). Its `links` to other
documents of `.agentplugged/docs/` count too. Only those documents are tracked: never the
stories, the epics, the other pages of the base or the files of the repository, and the release
notes, a dated history, track nothing. Paths are read from `.agentplugged/` and compared without
case. When the last `document` or `phase_end` checkpoint the creator approved that cites one of
them names another blob, or a blob the page never recorded, and the working copy holds that
version (a validation on a branch not merged yet counts only there), the page is behind:
`docs check` warns about it (`kb_stale`, `kb_source_unrecorded`), without failing, and `state.next`
calls Zoé to update those pages (`knowledge_base_update`) on any product, after the same steps
as `knowledge_base` and before the rest of the phase's work. While Zoé's review of the base is
open, the step is `knowledge_base_review`; refused and not superseded yet, it goes back to her
(`changes_requested`). `docs check` and `state.next` read the same documents. Each updated page
states its date and what changed it. A page also names, in `code`, the paths of the repository
it describes (a folder ends with `/`), and in `last_story` the last merged story it took in: a
story merged after it that changed one of those files (`story.merged` records the files a story
changed) makes the page behind it, with the same warning (`kb_story`) and step; the updated page
sets `last_story` to that story and names it in its `Last updated` line.

Every agent takes its context from the base: `AGENTS.md` (section "Knowledge base") and a
persistent fact of each agent say to read `.agentplugged/docs/index.md` first, then the pages
and documents the task needs, each in full, split only when it does not fit in the context.

## Validating with fewer gestures

One validation, one gesture. The creator answers each point with one word, one
click or one sentence of their own, in the chat, whatever its type or its risk: never a second
question, a sentence to copy, two messages in a given order, nor a terminal (the terminal is the
way of the `strict` level only). What stays is the trace: each answer is signed in the journal
with who answered, what, when, the proof (the hook's, or « unverified » in a tool without one) and
the channel (chat, form, question tool, or the terminal of the `strict` level). An action with an effect outside the product
that cannot be undone (a deployment, a publication, a message sent, a payment) is named, with its
effect, in the question itself, and the one answer is the creator's agreement. A merge into the
main branch is undone by a `git revert`: a plain validation, which enters the single stack of the morning.
Three things spare the creator the repeated yes and the command line.

**A stack to validate.** When several checkpoints wait and a plain approval answers them
(documents, the epics of a breakdown, a merge, a release, a publication, the end of a phase,
planned installations), the agent presents them together: `chat.stack_open` (2 to 16 points, numbered
1, 2, 3…, each checked by the engine; each line names its action when it has an outside effect,
and at the `strict` level only a high-risk point never enters), then `chat.stack_ask` in a tool that shows
the engine's forms (one form, a box per point, all ticked: the creator unticks what they do not
validate; the engine records one answer for each point left ticked, source `elicitation`), or, in
the chat, the numbered points and `chat.stack_answer` with the creator's whole message. The engine, not
the agent, reads that message in French or English: « j'approuve tout », « j'approuve les 3 » (the
count of the stack), « j'approuve 1, 2 et 4 », « j'approuve tout sauf le 2 », "I approve all", "I
approve 1, 2 and 4". It approves the points it names, and those alone; anything else (a « yes »
alone, a negation, a reservation, a question) is refused, and a « yes » alone still answers one
point at a time (`chat.answer`). The stack is written once (`stack.opened`) and cannot
grow, and only one is open at a time; the answer (`stack.answered`) cites it, the creator's message must come after its opening
and be a real one the AI tool's hook recorded, and one message answers a stack once. The same
structure serves any surface. A merge in the stack is done by the engine
itself: the stories the creator approved are merged one after the other in the order of the graph
of the stories (their dependencies first) and each `story.merged` is written in the same write as
the answer; a merge the forge refuses leaves its point open (`merge_failed` in the result) and
the other points go through.

**Git gestures by the engine.** The creator no longer types `gh repo create`, `git push -u origin
main` nor opens and merges the CI's pull request. An agent asks (`guard.creator_action`):
`forge_repo_create` (the remote repository, private by default, which becomes `origin`),
`forge_push_main` (the push of the main branch, the first one or the local commits not published
yet, never forced: only to an empty remote or one that is behind), `forge_merge_ci` (the pull request of the CI branch `ci/…`, opened when there is
none, then merged on the commit the creator saw, if only CI files and documentation changed). Each
one is the creator's one answer, in the tool's form or in the chat (recorded « unverified » in a
tool without the hook), and the engine does it with the forge's tool they connected (`gh`,
`glab`), after reading the repository again (a newer commit, another `origin`: refused). The
agents do not do it themselves: the constitution forbids it, and `sync` keeps denying a push of the
main branch and a merge by hand.

**Installations.** The architecture's header lists, in `dependencies`, the
packages and the tools of the chosen services the product is built on, by ecosystem (`npm`,
`pypi`, `crates`, `go`, `rubygems`, `packagist`). The engine reads that list on the main
branch, in the version the creator approved. The creator chooses once how installations go
(`installs.mode` in `method.yaml`, asked by `init`, changed by `profile --installs` or in the chat):
`visible` (the default: no validation; each installation is recorded in the journal, shows in
`state.get` and says whether the architecture plans it) or `validate` (one validation each; a
planned one, or one the engine reads without any doubt as plain names of the official registry in a
project that redirects nothing and runs no script when installing, is at a medium risk a stack can
group; anything else stays high). In Claude Code, the install patterns are written as `allow` and a
hook records them (or asks, at `validate`); it works there and in Antigravity CLI only: in another
tool, with no such hook, installations are neither recorded nor validated. An installation written
with a variable, `env` or `sudo` before it, with anything else on the same line (an `echo` into a
config file, `npm run`), run from a folder that is neither the project's root nor a working copy of
one of its stories, or with an option the engine does not read, is not planned. A creator who wants
the tool to ask before every installation sets the rule `install_dependency` to `ask`
(`rules set`).

**Installations without a round trip.** A developer is launched in the main
repository and writes `cd <working copy of its story> && npm install …` (or `npm --prefix`,
`pnpm -C`, `yarn --cwd`): the engine reads the command as run in that copy, when it is a working
copy `story.started` records for this product (a real folder, never a link, never `..`, one `cd`,
first, joined by `&&`, followed by installations only), and reads that copy's manifest and
lockfiles. How the output is shown (`2>&1`, `| tail -15`, `> /dev/null`) is no part of the
installation. What the creator approved is the installation's **identity** (the family of the
action, for the story): the ecosystem and the names of the packages, and for the manifest's own
dependencies the working copy (`npm install`, `npm ci` and `pnpm install` of one copy are one
approval, with any option the engine reads); for a package runner the tool and its version, not
what it is told. Another version of the same packages, another working copy of the product, the
same line cut another way, another manager or verb: the approval holds, for the whole story, not
for an hour. A package added, another source or another tool: a new point. At `validate`, an
installation the architecture does not declare, but that the engine reads without any doubt (plain
names of the official registry, a project that redirects nothing and runs nothing when installing),
is a point of a **medium** risk a stack can group; anything else stays high. The permission point of
an installation (at `validate`) is also answered in the tool's
form, unless a hook of the tool could answer in the creator's place (then the chat answers it), or the
`strict` level keeps a high risk for the terminal. `state.next` gives agents `validation.elicitation` and `validation.channels`, read fresh at each call.

### Decisions to click: the form, the question tool, the chat

The engine asks the creator a decision (`chat.ask`, `chat.stack_ask` for a stack) in the first channel that works, in this order, and says which in `validation.channels`:

1. **The client's form** (the MCP "elicitation"): the engine sends it itself and records the click, with nothing for the agent to quote. It works in the command-line version of Claude Code. The VS Code extension of Claude Code refuses it at once (version 2.1.289): the engine notes it for the session and does not send another.
2. **The AI tool's question tool** (`AskUserQuestion` in Claude Code, which works in the extension's conversation window): the engine dictates the exact questions (the recommendation first, marked "(Recommended)", at most four questions; a stack longer than four points is split in screens); the agent asks them word for word, and a hook `sync` writes in `.claude/settings.json` (`PostToolUse` on `AskUserQuestion`) records the creator's answer in a store of the machine. The agent then calls `chat.answer` (or `chat.stack_answer`) with `via: "question_tool"` and the session id: no quote, no decision. The engine reads the click from the hook's record, and accepts it only when the questions are the ones it dictated for this checkpoint in this session, once. A decision is one question and one click, whatever its risk (an irreversible action is named in it); the `strict` level keeps a high risk at the terminal. Without the hook (`sync` not run) or without the tool, the engine falls back to the chat and says so.
3. **The chat**: "a, b or c?", then `chat.answer` with the creator's whole message quoted.

## Your points of validation, and the night without you

You choose which points wait for you; the agents go on without you for everything
else, even at night. In the morning you find one short summary and one stack, you answer once, and
the work goes on.

**Choosing.** `init` and `profile` ask the list once (or `--points framing,architecture`,
`--points none`), and you change it in a word in the chat ("ne me demande plus les fusions":
`guard.creator_action` `profile` `{ points }`). The points: `framing` (the brief, the PRD, the UX
specification and the end of those phases), `architecture` (and the end of the design phase),
`breakdown` (epics, stories, sprints), `merge` (the merge of a story), `release` (a deployment, the end of
the delivery phase) and `publication` (a deliverable of the launch). Proposed by default: framing,
architecture, release, publication. Until you choose, every point waits for you, as before. Like the
validation level, the choice is read on the main branch (`validation.points` of `method.yaml`), so an
agent cannot widen it on its own branch.

**What the agents decide.** Any other point is decided by the agent responsible for it
(`checkpoint.decide`, never Noah): `state.next` gives the step `point_decision` and the agent (a reviewer of
the work, never its author when another is active). The decision carries its reason, is written as
the agent's (source and assurance `agent`, never as your answer) and shown in the history. The merge of
a story is done by the engine as when you approve it, once its CI is green and its review done. You
can reopen any decision (`reopen`, in a word); a merge already done is undone by a `git revert`. An
agent that cannot decide hands the point back to you (`escalate`, with its reason). Never decided by
an agent, whatever you chose: an action of yours (`guard.creator_action`), a change of the memory, an
installation you validate, a blocked result, a conflict of substance, a review loop, the fast track,
and, at the `strict` level, a high risk.

**How `state.next` and Noah organise the night.**

1. `state.next` first looks for a point nobody decided yet that you did not keep: `point_decision`, to the
   agent it names.
2. A point you kept that is open does not stop the agents. `state.next` looks again for the work as if
   those points were not there, leaving out the stories they concern, and gives what does not depend
   on them (`independent: true`): building, reviewing, fixing a CI, a refusal, a conflict, the
   retrospective, the knowledge base, planning the next stories. What comes after a document or
   the end of a phase waits for its approval: the next document, the next phase are not independent.
3. When nothing independent is left, `state.next` says `stop: true` and the agents stop: no polling, no
   question at night. Everything is in the journal.
4. Noah hands the independent tasks over in parallel (sub-agents), calls `state.next` again after each
   return, and ends the run at `stop`.

**In the morning.** Noah opens with the summary (`morning` in `state.next`): what was done (stories merged,
by whom), what the agents decided alone with each reason, what the engine closed alone because it was
settled, what an agent handed back, and what waits for you. Then one stack of everything that
waits (`pile`, up to 16 points: documents, decisions with a recommendation, merges, releases,
publications, ends of phase; an action of yours or a memory change keeps its own presentation), each
line with the recommendation and, when it has an outside effect, the action it does. You answer in
one message ("oui à tout", "oui sauf 3") or one form; the engine merges the approved stories in the
order of the graph in the same write, and the work resumes without another question. All of it is
in the journal (`npx agentplugged history`, `state.get`).

**What each tool allows today, honestly.** The engine does the same in every tool: it decides what
is next and where to stop. Whether a session keeps working while you sleep depends on the tool, and
no tool relaunches a session that ended by itself in this version.

| | Claude Code | Cursor | Codex |
|---|---|---|---|
| Keeps working while there is work | One session: Noah calls `state.next` until `stop`. | One session in the editor or its command line, the same way. | One session, the same way. |
| Independent tasks in parallel | Sub-agents (`.claude/agents/`), several launches in one message. | Sub-agents (`.cursor/agents/`). | Sub-agents (`.codex/agents/`), several at once. |
| No prompt at night | Your permission mode (an automatic mode, outside the engine); the rules `sync` writes refuse only what is destructive. | Your Cursor run mode (Auto-review, or an allowlist), outside the engine: a project file cannot lift Cursor's approval of a command or of an MCP tool in the editor, and a hook that answers `allow` lifts nothing. `sync` writes `.cursor/cli.json` so that the Cursor command line asks nothing for the engine's tools, and the project's hooks refuse only what is destructive. | `sync` writes `.codex/config.toml` with the sandbox inside the project's folder and no approval (`approval_policy` written as a granular policy that refuses every approval request but the forms of decisions, except at the `strict` level, where Codex keeps asking), the engine's tools approved, the product's rules as Codex's own rules of commands and as a hook: Codex asks nothing and stays in its sandbox. |
| Your answer in the morning | Proved by the hook of the chat, or a click. | Proved by the project's hook of the Cursor editor (`.cursor/hooks.json`, once you trust the folder), or a click; recorded « unverified » in the Cursor command line, which does not emit that hook: the journal says so. | Proved by the project's hook of Codex once you approved it (once: the "Review hooks" icon under the input box of the VS Code extension, or `/hooks` in the terminal), or a click. |
| Stops when | The session ends (context, usage limits, the machine sleeps): start another, `state.next` says where things stand. | Same. | Same. |

Without the creator's settings above, the tool itself stops at each permission prompt: the engine
cannot lift it. What an optional module can add: relaunching the agents alone, when
you answer from your phone or on a schedule, in a session the bridge starts on your machine. Until
then, the creator (or Noah on "pick up where we stopped") starts the next session.

## Your Git workflow, not the method's

How you work with Git is yours to choose, at `init` (or `profile`, or in a word in the chat), each
choice with the recommended option and one sentence that says why; « keep the recommendation » answers
them all (`--workflow recommended`). A product that already has its own way of working keeps it: `init`
reads its branches, its CI files, its pull requests and the protection of its main branch, and proposes
that as the default.

- **Base branches:** `main` alone (recommended for one person), `main` + `dev`, or two names of yours.
  With `main` + `dev`, stories land on `dev` (staging, your own tests) and `main` is what the public
  sees. Noah follows what waits in staging and proposes the release (« 5 stories en staging depuis 3
  jours, CI verte : on met en production ? »): one « oui », the engine puts `dev` into `main`.
- **A branch per story:** yes (recommended: each story is isolated and undone alone) or no (the work is done
  on the branch the stories land on, with no pull request).
- **CI:** none, on your machine (a self-hosted runner) or on the forge (recommended on a forge).
- **Merge:** by pull request (recommended on a forge) or by the engine itself, without a pull request (it
  never pushes).
- **A review before the merge:** yes (recommended) or no.

The choice lives in `git` of `method.yaml` and in the journal, which the engine reads. Changing it is one
answer and loses no work: the stories in progress land on the new branch, and the engine says in a sentence
what the change implies.

## The journey is proposed, never imposed

The method proposes a complete journey (the phases, their documents, the reviews, the
CI, the retrospective). Nothing forbids you to follow only a part of it: it is your product, your way
of working, and you bear the consequences of what you skip. You say it in a word in the chat (« pas de
PRD, on passe à l'architecture », « pas de revue sécurité pour cette story », « fusionne sans CI »,
« je ferai l'UX moi-même »); your agent asks it (`guard.creator_action` `step_skip`), tells you once,
in one sentence, what rests on that step and the lightest option (a minimal architecture rather than
none), and your one answer records it. The engine writes in the journal what was skipped, who said it
and why, recomputes what follows, and never insists. An agent can never skip a step by itself.

| What the method proposes | The step | What it becomes when you skip it |
|---|---|---|
| The framing, planning, design, build, delivery and launch phases, each closed by your approval | `phase_framing` … `phase_launch` | The phase counts as passed, its end needs no approval, the point of its end closes itself. |
| The brief, the PRD, the UX specification, the architecture, each validated | `brief`, `prd`, `ux`, `architecture` | Not asked for, not waited for; their point closes; `docs check` lists their problems as skipped (warnings). |
| The security review of the architecture before the end of design | `architecture_security` | The end of design no longer waits for it. |
| The readiness gate before the stories are cut and before the first one | `readiness` | Not proposed; the documents are not checked as a whole before building. |
| Epics and stories, validated; the sprint, validated | `breakdown`, `sprint_planning` | Not proposed; a story starts outside a sprint, and any developer may take it. |
| The knowledge base, the positioning, the retrospective, the CI's base workflows | `knowledge_base`, `positioning`, `retrospective`, `ci_setup` | Not proposed, their points close. |
| `docs check` failing on a malformed document | `docs_check` | Every problem becomes a warning. |
| A story valid, validated at its current content, its intent kept | `story_contract` | The story starts and goes to review as it is; its problems are warnings. |
| Dependencies done first, merges in the order of the graph | `story_order` | Neither the start nor the merge waits for the order. |
| Open deferred work locking a story | `story_deferred` | The lock is lifted for that story. |
| The independent review and the sorting of its findings | `story_review` | The story goes straight to its merge point (the engine opens it). |
| The security review of a story | `story_security` | The quality review closes the pass. |
| A green CI before the review and the merge | `story_ci` | The CI is never waited for nor fixed; reviews are not bound to a CI's commit. |
| An open deviation holding a merge | `story_trace` | The deviation no longer holds the merge. |
| The fast track's check that the change is small | `story_fast_track` | The story merges as it is (a story you stopped stays stopped). |

You take a step up again in a word (`step_resume`); nothing already done is undone. `state.next` and
`state.get` show what you skipped (`journey.skipped`) as your choice, never as an error, and do not
propose it again. What stays, because it is not a step of the journey: the proof of your answers, the
permission rules, the secrets, and what keeps the code and the journal sound (a conflict with the main
branch, a conflict marker left, a cited document not committed), and the limits you set yourself (the
budget, the ceiling of stories at once, the validation level).

## The engine updates itself

You never reconnect anything to move to a newer engine, from your computer or from your
phone. The server your AI tool starts (`agentplugged mcp`) is a small, stable launcher: it runs the
engine of one version in a process of its own, and between two calls it moves your session to a newer
version when your product pins one. Each version lives in its own folder (`~/.agentplugged/engines/<version>/`
or the cache of `npx`): nothing is ever replaced in place, so nothing is locked (on Windows a running
engine locks its native keychain module, which is why a version cannot overwrite the previous one).
The connection with your AI tool never closes and a call in flight is never cut.

- **It looks, once or twice a day.** The engine asks the npm registry for the latest published version:
  one request for the package name, nothing of your project, the answer kept on your machine. A
  registry that cannot be reached, or a package that does not exist yet, is silence.
- **Noah proposes it once**, in one sentence, with what the release says: « Une version 0.2.0
  d'AgentPlugged est sortie. Je l'installe ? ». Your « oui » installs that exact version in its own
  folder, brings the product to it, and your session moves to it at its next call. A « non » or « plus
  tard » is not asked again for that version.
- **Two settings, on your machine** (`~/.agentplugged/settings.json`, or in the chat: « arrête de
  chercher les mises à jour », « mets à jour tout seul »; or `npx agentplugged update --check off` and
  `--auto on`): `check` (on by default) stops the look at the registry; `auto` (off by default)
  installs a new version without asking, and Noah says it once. By default nothing is installed
  without your word.
- **From the terminal** (yours, interactive: never an agent's), `npx agentplugged update` does what your « oui » does.
- A session that still runs an older engine than the one your product pins never works with the old
  code in silence: it says so, and your one « oui » to Noah fixes it.

## Model tier and preferred tool of an agent

Each agent has a model tier: `reasoning`, `code`, `fast` or `multimodal`. `sync` writes the model
of that tier, for each AI tool, into the agent's generated files.

The tier used is, in order:

1. `agents.settings.<id>.model_tier` in `.agentplugged/method.yaml`;
2. `model_tier` in the agent's customisation, `.agentplugged/overrides/agents/<id>.yaml`;
3. `metadata.model_tier` in the agent's `SKILL.md`.

`agents.settings.<id>` is written by `npx agentplugged agent edit <id> --tier <tier> --tool <tool>`:

```yaml
agents:
  settings:
    iris:
      model_tier: fast
      tool: codex
```

- `--tier default` removes `model_tier`: the agent goes back to its own tier (2, then 3).
- `--tool none` removes the preferred tool.
- The preferred tool (`claude-code`, `codex`, `antigravity` or `cursor`) is only shown: at the end
  of the agent's description ("Preferred tool: Codex.") and in the summary of `sync`. It never
  limits generation: the agent is generated for every tool listed in `tools`. A preferred tool
  missing from `tools` is reported by `sync`.

## Changing the models

Do not edit `.agentplugged/models.yaml`: it is generated, and `init` and `sync` use the table
shipped with the engine while the copy carries its header. Put your values in the `models`
section of `method.yaml` instead, tool by tool and tier by tier. They win over the table, field
by field:

```yaml
models:
  codex:
    code:
      model: gpt-6.2-sol
  claude-code:
    reasoning:
      model: haiku
      effort: none
```

- Tools: `claude-code`, `codex`, `antigravity`, `cursor`.
- `effort` exists for Claude Code (`low`, `medium`, `high`, `xhigh`, `max`) and Codex (`minimal`,
  `low`, `medium`, `high`, `xhigh`, `max`, `ultra`). `effort: none` removes the effort of the
  table: no effort line is written.
- `model: inherit` keeps the model of the session; `sync` reports it as a "model" fallback, in
  the terminal and in the constitution.

If you remove the header of `.agentplugged/models.yaml`, the file becomes yours: `init` no longer
updates it and `sync` reads it instead of the shipped table. It must then stay complete, every
tool and every tier, and you follow later changes of the shipped table yourself.

## When something fails on your machine

`npx agentplugged doctor` looks at your machine (Node, Git, the forge's tool, your AI tools, the
keychain, Docker, the free room on the disk, the PATH…) and says each point as a fact, never as an
accusation: « gh is installed in C:\…, your system knows that folder, but this program was opened
before ». When a command fails, give its message to the engine:

```text
npx agentplugged doctor --error "<the message>" --exit-code 137
```

It answers with three things kept apart: what the failure says by itself, what the engine **saw on
your machine** just now, and what it only **supposes**. When nothing explains the failure, it says
the cause is not established instead of guessing. Your agents do the same through
`state.environment` with a `failure`: no new tool, and no « install X » or « it is the memory »
without proof.

To ask for help, attach the report of your machine:

```text
npx agentplugged doctor --report > report.md
```

It holds the system, the versions and the result of every check, and nothing personal: no account
name, no personal path (your home and your product's folder are shown as `[home]` and `[project]`),
no server name unless it is public, no e-mail, no token or password, and nothing from the content of
your product. The list of what it removes is printed at its end, and a test keeps that list true.
It only looks: nothing is repaired and nothing is asked.

The install itself is tried on every change to the package, and again on each published version, on
clean Windows, macOS and Linux machines, under several versions of Node.js, in the usual terminals,
and on imperfect machines (no GitHub CLI, no network, no Git identity, Docker stopped, a long path
with spaces and accents, a proxy). On your
own machine, `pnpm trials` in the repository of the engine runs the same trials in a folder of
their own, and `pnpm trials sandbox` in a clean, disposable Windows (Windows Sandbox).

The checks are data (`doctor.yaml`, next to `models.yaml`): the detectors are a closed set, and a
new trap is a new entry (a `check`, and a `signature` that says which failure reads it), in English
and in French, with a test on a simulated machine. Nothing in it is tied to a language or a stack.

## License

The method (the agents, skills, templates and `models.yaml` of this folder) is under the MIT license
([LICENSE](LICENSE)), copyright 2026 Innovel Studio SASU, so that it spreads freely. The engine that
installs it, the `agentplugged` npm package, is under the Functional Source License
(`FSL-1.1-MIT`); the apps built on top of it are not published here.
