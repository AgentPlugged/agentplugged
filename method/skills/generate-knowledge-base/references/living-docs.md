# A documentation that stays true

## A page that says it is behind

The engine commits under a late page's header a notice between
`<!-- agentplugged:late since=<date> -->` and `<!-- /agentplugged:late -->`; else
`state.next` lists the page in `late_pages`. Never write a notice. A page with one is not
true: read the code it names. **You remove the notice**, whole block, in the commit that updates the page; leave it if you could not.

When `state.next` gives a `background`, update in your own branch: it never
makes a story wait nor touches a story's branch; rewrite by paragraph.

## A page behind a merged story

A story merged after the page's `last_story` that changed a file of its `code` (path or folder)
makes `docs check` warn `kb_story`; only those pages. `git pull`, read what the
story changed (`state.get { story: "<id>" }`, `git diff`), change only the touched passages, set
`last_story`, write the date and story in `Last updated`; `docs check`, commit, the `document`
checkpoint naming each story.

## A new product

`state.next` gives `knowledge_base` after the architecture is validated: ask nothing and read no
code. Write only `index.md`, `vision.md` and `conventions.md`, one screen each, pointing to the
approved documents; what they do not say is an open question. `last_story` empty, `code` the
planned folders.

## A product with its own documentation

README, `docs/`, wiki and changelog are claims. Confront each with the code: **true** (a file
proves it) enters the base with that file as source; **false or out of date**: it never enters the
base, list it with its document and line, what the code says and the proving file;
**unverifiable**: a question for the creator. The review summary and `story.result` carry the list
under "Documentation found".

## A version delivered

`state.next` gives `release_notes`: write `.agentplugged/docs/release-notes/<version>.md` from the
stories merged since (`merged_order`, `state.get { story: "<id>" }`), in the users' words,
breaking changes first, each item linked to its story. Then update the user
guides the changes touch, add the version to `release-notes/index.md`. These pages feed the
future help centre.
