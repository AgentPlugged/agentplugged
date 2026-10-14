---
name: review-story
description: Review a story's pull request, or any change, independently with lenses the engine chooses and a judge in a fresh context, in one whole report. Run by the reviewers.
metadata:
  agent: quentin chloe
  phase: build
---
# Review a story

> **The creator's Git workflow, not the method's.** Read `git` in `state.next` or `state.get` before you act: the branch a story lands on is `git.branches.integration` (else the main branch; the story's `base_ref` says it), a story may have no pull request (`git.merge` `direct`) or no branch of its own, and the CI and the review are the creator's choice (`git.ci` `none`, `git.review` false). Whatever below says "the main branch" or "the pull request" means that branch and that pull request when there are any.

A story in review, its CI green on the head of its branch, gets an independent review before the
creator sees its merge: the quality review always (`kind: qa`, an agent of the quality domain),
and the security review when the story concerns security (`kind: security`, an agent of the
security domain). The engine chooses the lenses from the change's risk, merges the findings,
computes the verdict, closes the pass once every review is in and posts it on the pull request.

Run it under your own id: `agent: <your id>` in every MCP call. Work in the creator's language;
keep identifiers (`1-2`, `EF-n`, `AD-n`, `R-…`, `V-…`) as they are; write the findings in the
language of the product's documents.

- **Input:** one story in review, its pull request open and its CI green; or a change with no
  story (`references/free-review.md`).
- **Output:** your review recorded with `review.submit`, your review note in your folder of
  `.agentplugged/docs/` (`qa-reviews/<story>.md` or `security-reviews/<story>.md`), and a
  structured result. No code change, no push, no comment posted by you, no merge.

## Independence

- Never review a story you built: the engine refuses it (`not_independent`).
- Before you submit, read only the files `review.start` names, the story and the documents it
  cites (and, for security, the threat model). Never the other reviewer's note, never the
  comments of the pull request, never the developer's results or reasoning, never the journal
  nor `.agentplugged/.cache/` otherwise. `review.get` gives you your own reviews only.
- Never run `gh` or `glab`, nor post or read pull request comments: the engine posts.

## Steps

1. **Start.** `agent.status` (`working`, the story). `review.start` with the `story` and your
   `kind` (`more`: lenses the creator asked for). On `REVIEW_NOT_POSSIBLE`, say why in one line
   and go to step 7 with `partial`: `ci_not_green` or `head_moved` (read its CI first),
   `security_not_required` (nothing to review: end with `complete`).
2. **Read what the engine gives:** the diff file, the `files`, the story file and its numbered
   `criteria` with their `trace`, `requirements`, `security`, and `lenses` (each with why) and `readers`.
   `previous`: your findings of the earlier passes, sorted by the developer (`fix`, `defer`,
   `reject`).
3. **Run the readers.** For each entry of `readers` but the judge, start a sub-agent (a light
   model is enough), all at once when your tool allows it, else in turn. A reader carries its
   entry's `lenses`, one report per lens. Give it only its cut of the diff (the entry's `diff`),
   the story file, the decisions `AD-n`, the knowledge-base page covering the touched code (late:
   read the code), `format.md`, the `lens-<name>.md` of its lenses in
   `.agentplugged/skills/review-story/references/`, `judge.md` when `judge: true`; when it has
   `passes`, the `pass-<name>.md` of each, run last, and the `statements` file (their findings go in
   its `verification_gaps` report); when it has `reuse`, those lines (proved duplicates, which
   the engine records; suspected `twin?`: read both functions). It reads the diff once, lens
   after lens, the judge's check last. Never the developer's reasoning nor another reader's
   report. Never split or merge entries. The security lens is the security reviewer's; you
   carry it only when nobody can give that review. A reader silent after one more ask: its
   lenses go in as `{lens, silent: true}`, never an invented report.
4. **Judge** (quality only), once the readers are in: a sub-agent (the strongest model) in a
   fresh context with the story file, its part of the diff, `references/judge.md` and what each
   lens found, named `<lens>#<rank>` (no reader's reasoning). It rules on every finding and every
   criterion. With `judge: true` on the lens reader (small change), that reader judges the
   criteria and, if it found something, a short fresh judge rules on those findings alone. Take
   each report as it comes, add nothing, drop nothing. Your earlier findings still held: say them
   again, same words.
5. **Submit.** `review.submit` with the same `story`, `kind` and `commit`, a `summary`, the
   `lenses` reports and the `judge` report, `findings` empty (`format.md`). A
   report that is not whole is refused (`report_invalid`, and what is missing): fix it, submit
   again. The engine merges the same finding seen twice, takes each severity from the judge (a
   refuted finding is counted, not shown), links it to its criterion and computes the verdict (a
   blocking finding fails it). When the change touches something you think needs a security
   review the engine could not see, say so with `security: true`.
6. **Write the review note** in your folder (header `id`, `kind: note`, `owner: <your id>`,
   `links`): the lenses run, each finding and the verdict the engine computed.
7. **Report.** `story.result` with the review's id `R-…`, never its verdict nor its findings
   (the developer gets them through the engine), your assumptions and open questions. Then
   `agent.status` (`idle`), hand back to Noah.

No sub-agents, or another model's opinion wanted: `review.export` (`references/export.md`)
replaces steps 3 and 4.

## What happens next

- A pass closed with a blocking finding sends the story back to its developer, who sorts each
  finding (`review.triage`), fixes and sends it back: a new pass. A finding marked `story` is
  not a code defect: `references/amend-story.md`.
- A pass closed without one opens the merge checkpoint: the creator reads a short stack, blocking
  findings first with your advice ("review possibly incomplete": a lens stayed silent).
- After 5 passes closed without agreement, the engine asks the creator.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): checkpoint before the question, ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never change the code, the tests or the story: review, do not fix. Never approve nor merge.
- Never call, direct or wait for another agent but your readers: hand back to Noah.
