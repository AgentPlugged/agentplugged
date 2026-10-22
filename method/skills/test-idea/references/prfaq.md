# The press release, written first

Write as though the product shipped, under a future date they pick. Their words and facts first;
what they do not know stays a question. Start from the reader (`forge.md`), their trouble, its cost,
the rough answer.

**The release**: headline (could the reader repeat it?) and subheading; opening; the problem felt,
without the solution; the solution as the reader's day changes; the creator's quote; how it works;
a reader's quote marked `[imagined]`, never passed off as real; how to start. Draft each part, pick holes in it
aloud; they correct, you never overwrite.

**Bars**: no jargon, no praise words (« unique », « innovative »): give the fact; no figure without a
source or `[assumption]`; a claim about rivals or the market with no source stays `[assumption]`, and
you offer once to look it up (skill `deep-research`); no requirement identifier; `npx agentplugged
docs check` reports nothing.

Then `faq.md` and the verdict. Once in, the `document` checkpoint (`type: document`, low risk,
no story, no blocks) cites `.agentplugged/docs/prfaq.md` with its `branch` and `blob_sha`.

## The verdict

A last section `## Verdict`, three lines the engine checks:

```
- Holds: what is clear, honest and defensible.
- Soft: what is promising but thin → what would firm it up.
- Breaks: a real risk, a contradiction or a hole → what facing it would take.
```

Each item of `Soft` and `Breaks` ends with `→` and a next move; a category with nothing says `none`; labels follow the language (`Tient`, `Fragile`, `Casse`). The call is the
worst category that has items, in one sentence; no score. `concept:` must be in the header or the
closed release is refused. `Soft`, `Breaks` and `[open]` become bets (`personas.md`). Never decide
for them what to do about a crack.
