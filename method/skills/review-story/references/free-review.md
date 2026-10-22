# A change that belongs to no story

Same lenses, readers and judge; no story, no merge, no pull request comment.

- Ask the creator for the intent in one sentence: it is the judge's only criterion.
- `review.start` with `kind: qa`, `free`: its `intent` and one `source` (`uncommitted`,
  `<from>..<to>`, `branch:<name>`, `pr:<number>`) or a pasted `diff`. Never run `git` or `gh`
  for it. Only the quality review is free.
- Run the readers and the judge as the skill says; `review.submit` with no `story`, the `commit`
  given, `kind: qa`. No note, no `story.result`: tell Noah what it found and its `R-…`.
- Nothing is sorted nor merged: a fix is a story, or the quick lane.
