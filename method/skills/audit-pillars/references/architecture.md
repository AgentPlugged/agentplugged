# Pillar: architecture

Does the code follow the decisions the architecture records (`AD-n`)? Read
`.agentplugged/docs/architecture.md`, then, for each decision, the one or two places that should
obey it (a boundary, a single writer of a piece of data, a dependency direction).

Look for: a boundary crossed (a layer reaching past the one below it); two writers of the same
data; a dependency pointing the wrong way; a decision nobody follows any more (propose to retire
or restate it, never to ignore it); something built that no decision covers and that decides a
lot (a new store, a new service, a new external dependency).

Requirements: the `AD-n` with a numbered budget (a size, a time, a count): compare it with the
project's own measure.
