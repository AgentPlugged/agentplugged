# Another tool, or another model, reviews

`review.export` takes what `review.start` takes and writes one text that stands alone (`prompt`):
criteria, lenses, passes, judge, the shape of the answer and the diff. Nothing is journaled nor
launched; the text leaves only where the creator sends it (say so when it has `sensitive`).

1. Give the creator the file and its size; never summarise it nor add findings.
2. The answer is one JSON object (`summary`, `lenses`, `judge`), taken as it comes.
3. `review.submit` with the `commit` the export gave and that object; refused as not whole: ask
   the other tool for that part only. Name the tool or model in your `summary`.
