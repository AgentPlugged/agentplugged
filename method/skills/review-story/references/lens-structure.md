# Lens: structure

Is the change organised so the next person can follow and change it?

- Names say what things are; one thing, one place; no duplicate of what already exists. The
  engine proves copied code and gives it to you as `reuse`: do not report those again. It cannot see
  two functions that do the same thing written differently: for each `twin?` line, and for any
  helper you find in the diff, search the repository for an existing one; report a real twin
  with both places (`should_fix`), say nothing of a false one. Abstractions nobody asked for
  (a layer, an option, a wrapper with one use) are findings too.
- Responsibilities in the right file or layer, as the architecture decisions (`AD-n`) say.
- Size: a function, file or pull request doing several things, a tangle of conditions.
- Anything left half-done: commented code, unused parameters, dead branches.

For a document: the plan of the document, order of sections, what a reader looks for and cannot
find. Findings are rarely blocking. Answer shape: `format.md`.
