# The map of what can be reused

`.agentplugged/docs/reference/reusable.md` (`id: kb-reusable`, from `assets/page-template.md`): a
table scanned in a minute.

- **In:** modules that own a job, public helpers other code calls, shared types, utilities.
  Grouped by the repository's areas; twenty to sixty rows.
- **Out:** private details, one-place code, generated code, tests.
- **Row:** name and path, the job in a few words, the rule of use if any.
- **Header:** `code` lists the source folders; update by row after a merged story.
- **Find rows** in the entry points and shared folders (`lib`, `utils`, `common`, `core`); a row
  is a file you read. List duplicate helpers under "Open questions", never merge them.
