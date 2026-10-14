# A review of a change that belongs to no story

A fix outside a story, a contribution from someone else, a range of commits, work not committed
yet. Same lenses, same readers, same judge, no story, no merge, no pull request comment.

- **Ask for the intent in one sentence** if the creator did not give it: what is this change
  meant to do? It is the judge's only criterion.
- `review.start` with `kind: qa`, your id and `free`: its `intent`, and one of `source` or `diff`:
  `uncommitted` (the work in the tree, new files included, the method's own `.agentplugged/` folder left out), `<from>..<to>` (a range of commits),
  `branch:<name>` (against the main branch), `pr:<number>` (the engine reads it through the
  forge's tool), or `diff` (a pasted diff, as text). Never run `git` or `gh` for it.
- Only the quality review is free, and by an agent of the quality domain. The security lens is
  carried by this review when the paths call for it.
- The answer is like a story's: `lenses`, `readers`, `criteria` (the intent, as criterion 1),
  `commit` (names the diff read, not a Git commit), `statements` (the commit messages, when there are
  any). Run the readers and the judge as the steps say.
- Steps 6 and 7 of the skill need a story: no review note, no `story.result`; tell Noah what the
  review found and give him its `R-…` id.
- `review.submit` with no `story`, the `commit` you were given, `kind: qa`. The engine writes the
  review in the journal with no story, and answers with its `stack` to tell the creator: blocking
  first, the refused ones counted. Nothing is sorted, nothing merged: the creator decides what to
  do with the findings; a fix is a story or a quick lane.
