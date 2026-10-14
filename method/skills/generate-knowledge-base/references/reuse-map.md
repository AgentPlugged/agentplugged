# The map of what can be reused

One page, `.agentplugged/docs/reference/reusable.md` (`id: kb-reusable`, from `assets/page-template.md`),
that lets a developer, human or agent, find what exists before writing it again. Short: a table
a reader scans in a minute, not a catalogue of the code.

- **What goes in:** the modules that own a job (one line each: what it does, when to use it), the
  public functions and helpers that other code calls or should call (name, path, what it takes and
  gives), the shared types, the utilities (dates, text, paths, files, errors, logging, HTTP). Group
  by area, the areas the repository already uses.
- **What stays out:** private details, anything used in one place only, generated code, tests.
- **One row:** name and path (`src/text/slug.ts`), the job in a few words, the rule of use if there
  is one ("always this, never a local copy"). Aim for the twenty to sixty entries that matter.
- **Header:** `code` lists the folders the entries come from, so that a story that merges there
  makes the page late like any other; `last_story` as for every page. Update it by row, with the
  rows the merged stories touched: add what they created, remove what they deleted.
- **How to find the rows:** read the entry points and the shared folders first (`lib`, `utils`,
  `common`, `shared`, `core`, `helpers`, or the repository's own), then the names exported from
  them. Never invent a function: a row is a file you read.
- **Duplicates you meet:** list them in "Open questions" (two helpers doing one job) for the creator
  to settle; do not merge them.
