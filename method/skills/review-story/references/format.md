# The shape of what you return

You work alone and return one answer; the engine refuses one that is not whole. Findings are
specific, located and few: no finding is a valid answer. Write them in the product's language.

**A lens answer** (one per lens in `lenses`, exactly that lens):

- `lens`: its name. `summary`: what you looked at, in a few lines.
- `covered`: what you checked, one short item each (at least one).
- `findings`: possibly none. Each has:
  - `severity`: `blocking` (must not merge as is), `should_fix`, `minor`.
  - `title`: one line. `evidence`: what you saw and why it matters, the proof (always).
  - `criterion`: the number of the acceptance criterion it threatens (as `review.start` numbers
    them), or `null` when none (always, even null).
  - `recommendation`: one line, what to do (always for `blocking` and `should_fix`).
  - `path` and `line` (new side of the diff) when it is about a line.

**The judge's answer:** `summary`; `criteria`, one entry per acceptance criterion of the story,
none missing nor twice: `criterion`, `status` (`met`, `partly`, `unmet`), `evidence`, and
`recommendation` unless met; `gap`: the distance between the story's intent and what was
delivered, or `null`; `findings`, one ruling per finding of the lens answers, each
`{finding, status, evidence, severity?, at?, cause?}`: `finding` is its name `<lens>#<rank>` (rank
from 1 in that lens's list), `status` is `confirmed`, `refuted` or `undecided`, `severity` goes with a
confirmed one, `at` (a file, with its line for a finding a reader called blocking) with a refuted
one; setting aside or lowering a blocking finding asks for at least 40 characters of `evidence`.
`cause: "story"` on a ruling or a criterion when the story itself is what is wrong.

**A lens (or the judge) that gave nothing:** `{"lens": "<name>", "silent": true}` in `lenses`
(`{"silent": true}` as `judge`) in its place, never a made-up report. The review then says it is
possibly incomplete.

Never put the verdict anywhere. Give the same finding once; the engine merges what two lenses
both saw, and keeps the strictest severity the judge gave.
