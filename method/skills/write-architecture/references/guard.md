# Decisions the engine can check

A decision binds the builders. Some of them can also be enforced before a file is written: the
engine refuses a write that contradicts them, and quotes the decision (`AD-n`). It does so only for
a decision that states a **checkable line**, in a block of its own, and only once the creator has
approved the architecture. Prose is never enforced: a decision without such a line stays a rule
for the reviewer.

## The two forms

Add a line, after the three fields, to the decision it belongs to:

```markdown
- **Guard:** no dependency left-pad
- **Guard:** never import pg from src/ui/**
```

- `no dependency <name>`: no manifest (`package.json`, `requirements.txt`, `pyproject.toml`,
  `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle`) is written with
  that dependency.
- `never import <module> from <folder or glob>`: no file there is written with an import of that
  module. The module is a package (`pg`) or a folder of the project (`src/db/`, also when the
  import is relative); the place is a folder (`src/ui/`) or a glob (`src/ui/**`, `*.tsx`).

`Garde :`, `pas de dépendance <nom>` and `jamais importer <module> depuis <dossier>` say the same.
One line per rule; a decision may carry several. Keep the names exact: the engine compares words,
it does not guess.

## When to write one

Only when the rule is a plain **no** about a dependency or an import, and a wrong write would be
expensive to find later. A rule that needs judgment ("keep modules small") stays prose. Every line
you add is a place where a builder can be stopped: if you doubt it, leave it as prose; the review
still checks it.

A refusal says the decision and what to do: follow it, or ask the creator to change the
architecture first (an update, approved again).

Only Claude Code has this check today (a hook before `Write`, `Edit`, `MultiEdit` and
`NotebookEdit`). In another tool the line is still a rule for the reviewer.
