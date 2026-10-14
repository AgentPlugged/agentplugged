# A documentation that stays true

The five cases where Zoé's work differs from the usual run. Read the one that applies: `state.next` names it, except a page behind a merged story, which `docs check` warns about (`kb_story`).

## A page that says it is behind

When a page is behind a document the creator validated or a merged story, the engine itself
writes at the top of the page, right after its header, a late notice between two lines
`<!-- agentplugged:late since=<date> -->` and `<!-- /agentplugged:late -->`, in a commit of its
own (never a change left uncommitted): on the story's own branch when it opens its pull request
(so the notice reaches the main branch with the merge), or on the landing branch where the
creator merges without a pull request. Where nothing can be committed, nothing is written and
`state.next` lists the page in `late_pages`; look at it before you rely on any page.
Never write or edit a notice yourself, and change nothing of a page outside the passages your
update touches. A page that carries one, or that `late_pages` lists, is not true: never take a
fact from it, read the code it names.

**You remove the notice**, in the same commit as the update of the page: when the page is up to
date, delete the whole block (both lines and what lies between them), nothing else. Leave it when
you could not update the page.

When `state.next` gives a `background` (pages behind while a story is under way), do the update
in your own branch, beside the developers: it never makes a story wait, never touches the
branch of a story, and a page is rewritten by paragraph, never as a whole.

## A page behind a merged story

The engine merges a story once the creator approves it and records the files it changed
(`merged_order` in `state.get { full: true }` lists the merged stories by rank; `state.get
{ story: "<id>" }` gives `state.merged`, its rank and the files it changed). When a story merged
after the page's `last_story` (every merged story, when the page names none) changed a file of its
`code` (a path, or a folder ending with `/`), `docs check` warns `kb_story` with the page, the
story and the files. In that case:

- **What to update:** the pages each `kb_story` warning names, and nothing else.
- **What changed:** bring the main branch up to date first (`git pull`: the merge happened at
  the forge), then read what the story changed (`git log` and `git diff` of its merge, the
  story's file, and the files the warning names).
- **Write:** change only the passages those changes touch, set `last_story` to the story (the
  latest one, when several), and replace the `Last updated` line: today's date and the story
  ("story 4-3 merged"). A page that newly describes code adds its paths to `code`.
- **Check and review:** as in the update mode of the skill: `docs check` without `kb_story` left, commit, then the
  `document` checkpoint, its summary naming each story that caused a change.

## A new product

`state.next` gives `knowledge_base` on a product that did not exist before the method, once the
architecture is validated and before the first story. Keep it short and ask nothing:

- write only `index.md`, `vision.md` and `conventions.md` (a page of reference per area only when
  the architecture already settles it), each one screen long, from the approved documents, which
  the pages point to instead of copying;
- read no code (there is none yet) and put no question to the creator; what a document does not
  say is an open question in the page;
- `last_story` stays empty, `code` lists the folders the architecture plans;
- then open the review as step 9 says: the engine decides who answers it.

## A product with its own documentation

On a product that existed before the method, the README, `docs/`, the wiki exports and the
changelog are claims, not facts. Before writing any page, confront each of them with the code,
page by page:

- **true** — the claim is proved by a file: it enters the base, with that file as its source;
- **false or out of date** — the code says otherwise: it never enters the base. List it, with
  the document and line that claim it, what the code says and the file that proves it;
- **unverifiable** — no file proves it: a question for the creator, marked as such.

The review checkpoint's summary and the `story.result` carry this list, page by page, under
"Documentation found": a creator who reads it knows which of their documents to fix or delete.
Never edit their documentation yourself, except for the README when they ask (menu RD).

## A version delivered

When `state.next` gives `release_notes`, a release was approved and stories merged before it are
not in the notes yet. Write `.agentplugged/docs/release-notes/<version>.md` from those stories
(`merged_order`, then `state.get { story: "<id>" }`; in the users' words, breaking changes and
required actions first, each item linked to its story) and set its `last_story` to the newest
story it covers. Then update the user guides of `guides/` that the changes touch, only the
passages concerned, and add the version to `release-notes/index.md`. These pages are the source
of the future help centre: write what a user does, not what the code does.
