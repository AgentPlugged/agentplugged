# The four axes

One axis per story. Take the findings of the story as the list; scan only when the story says so,
and then only the scope it names.

## cleanup

Look for: names that mislead or abbreviate; a function or a file doing several jobs; the same
logic written twice (reuse what exists, `reference/reusable.md`); dead code and unused exports
(prove they are unused by a search, not by a hunch); magic values; deep nesting that early
returns and guard clauses flatten; comments that repeat the code (keep the ones that say why).
Must not: change what a function returns, what it throws or in which order it acts.

## performance

Look for: work done twice, work done on every call that could be done once, queries in a loop,
blocking calls on a hot path, files read again, memory held for nothing. Start from where it is
slow (a measure, a profile), not from where it looks slow.
Needs: a measure before and after, from a command of the project that proves a requirement with a
budget (`measured_after`); the numbers are quoted from the runs' logs. A gain no run measured is
not reported.
Must not: trade correctness, readability beyond what the gain pays for, or an interface.

## security

Look for: inputs not checked where the outside meets the code (HTTP, command line, files, queues);
access checked in one place and not in another; text that reaches a query, a command, a path or a
page unescaped; secrets in code or logs; a library call with the unsafe default.
Needs: a test that fails on the old code, then passes (`story.criterion`); each behaviour change
named. This is the only axis where behaviour may change, because the old behaviour was the flaw.
Must not: add a dependency to fix it without a decision; hide a finding by deleting the feature.

## architecture

Look for: a dependency pointing the wrong way, a layer reached over another, a module that knows
too much, code in the wrong place against the decisions `AD-n` of
`.agentplugged/docs/architecture.md`. Their `Guard:` lines are enforced by the engine on write.
Needs: the import graph and the tests the same after each move; one move per commit.
Must not: undertake a move that cannot be done in small safe steps: list it for the creator as a
story of its own (`plan.defer`), with what it would take.

## Severity

Say each finding as `critical`, `major` or `minor`, as the finding did. Do the critical first; a
minor one that needs more than a few lines goes to deferred work.
