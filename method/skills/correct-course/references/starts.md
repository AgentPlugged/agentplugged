# Naming what a change touches

`starts`: 1 to 8 entries, each one of these forms. The engine refuses one it does not find (`EF-9:
not found`) and writes nothing.

- A requirement or a decision: `EF-3`, `ENF-2`, `AD-4`, `PU-1`, `MS-2`.
- A story: `4-3`. A criterion of a story: `4-3#2` (its number in the list).
- A passage of a document: `prd#Public cible`, `ux#Parcours d'achat`, `architecture#Données`
  (`brief`, `prd`, `ux`, `architecture`, `spec`; a heading of the document, or an identifier it
  holds). The identifiers a passage names are followed too.

Name the least that says the change: the engine follows the trace from there (stories that cite an
identifier, tests, proofs, hypotheses, documents and pages of the base). A change that touches
several things names several starts, one call. A new requirement is not a start: write it, then
change course on what it replaces.

`summary` is the change in one line, in the creator's terms; `quote` is their sentence as they
said it. One course at a time: finish the one that is open (`step: show`) before another.
