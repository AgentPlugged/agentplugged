# Another tool, or another model, reviews

For a review without sub-agents, or when the creator wants a second opinion from another model:
`review.export` instead of steps 3 and 4. It takes what `review.start` takes (a story, or a
`free`) and writes one text that stands alone, `prompt`: the criteria,
the lenses and passes to run, the judge, the shape of the answer, the commit messages and the
diff itself. It writes nothing in the journal and never launches anything. The text holds the
whole diff and the story: it leaves this session only where the creator sends it, and when the
answer has `sensitive` (paths or words of a security concern) you say so before they do.

1. Tell the creator the file (`prompt`) and its size; give its text to the other tool, or run it
   in a fresh session of another model. Do not summarise it, do not add your own findings.
2. What comes back is one JSON object: `summary`, `lenses`, `judge`. Take it as it
   comes, add nothing, drop nothing.
3. `review.submit` with the `commit` `review.export` gave, your `kind`, and that object's fields.
   The engine checks it like any other review: a report that is not whole is refused with what is
   missing; ask the other tool to complete that part only, then submit again.

The answer is independent because it did not come from this session: say which tool or model gave
it in your `summary`.
