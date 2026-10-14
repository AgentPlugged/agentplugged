# Lens: verification gaps

Find what the change claims without proof. Claims are in the story's criteria, the code's
comments, the commit and the tests' names.

- Each acceptance criterion: which test proves it, at which level? None is a finding.
- Each test as code: one that cannot fail, that checks wiring and not behaviour, that depends on
  time or order, or that passes only most of the time is a finding.
- A rule affirmed in a comment or the story but enforced nowhere.
- A claim about other code ("this is already validated upstream") you can check in the diff.

Your `passes`, when the engine lists any (`removals`, `assertions`), are read last from their own
files and report here. Say what would settle it (the test to write, the line to read). Answer shape: `format.md`.
