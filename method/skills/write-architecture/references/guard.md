# Decisions the engine can check

Once the creator approved the architecture, the engine refuses a write that contradicts a
decision, quoting `AD-n`, but only when the decision states a **checkable line** after its three
fields. Prose is never enforced.

```markdown
- **Guard:** no dependency left-pad
- **Guard:** never import pg from src/ui/**
```

- `no dependency <name>`: no manifest (`package.json`, `requirements.txt`, `pyproject.toml`,
  `Cargo.toml`, `go.mod`, `Gemfile`, `composer.json`, `pom.xml`, `build.gradle`) is written with it.
- `never import <module> from <folder or glob>`: no file there imports that module (a package, or
  a project folder, also when relative); the place is a folder (`src/ui/`) or a glob (`*.tsx`).

`Garde :`, `pas de dépendance <nom>` and `jamais importer <module> depuis <dossier>` say the same.
One line per rule, names exact: the engine compares words.

Write one only for a plain "no" about a dependency or an import whose breach is costly to find
later; a rule needing judgment stays prose. A refusal means: follow the decision, or ask the
creator to update the architecture. Only Claude Code enforces it today (a hook before writes); in
another tool it is still a rule for the reviewer.
