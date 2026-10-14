# The shape of the audit report

One answer, whole; the engine refuses one that is not and lists what is missing.

- `results`: one entry per audited pillar, none twice.
  - `pillar`: `quality`, `architecture`, `security`, `dependencies`, `performance`, `tests`,
    `interface` or `accessibility`.
  - `verdict`: `pass` (no finding), `issues` (at least one finding), `not_applicable` (the product
    has nothing of this pillar: say why in `summary`; `reads` may be empty).
  - `reads`: the files you read for this pillar (at least one, 40 at most), relative paths.
  - `summary`: one or two lines. `verified`: the requirements that expect a review, which you checked and found held (verdict `pass`, with reads).
- `findings`: possibly none. Each has:
  - `pillar` (one you audited), `severity` (`blocking`, `should_fix`, `minor`).
  - `where`: `path` or `path:line`. `what`: one line, the proof included. `fix`: one line,
    required unless minor.
  - `action`: `gap` (it fails a requirement: give `requirement`), `story` (work to propose),
    `note` (a minor finding only, nothing to do now).

A requirement is either `verified` or failed by a `gap` finding, never both. Never copy a secret
into a report. Never put a verdict on the product as a whole: the engine does not read one.
