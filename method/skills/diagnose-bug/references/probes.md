# Probes: temporary code that looks

A probe is a log, a print, an assertion or a timer written to see what the code does. It is
temporary and carries a marker, so that neither you nor the engine can forget it.

## The marker

Write `agentplugged:debug` in a comment on the same line, in the language's comment style, the
marker first in the comment (words may follow it):

```
console.log("total", total); // agentplugged:debug
print(f"total={total}")  # agentplugged:debug
```

One line per probe; a probe that spans several lines has the marker on each. The engine reads the
lines your branch added.

## Where and what

- Each probe has a reason: which hypothesis it confirms or rules out, and what it prints that
  settles it. Say it in `story.progress` when you add it.
- Print values and decisions (a branch taken, a key, a count), never a secret, a token or
  personal data.
- Put them where the data crosses a boundary: input, call, result.

## Taking them out

1. Remove every line that carries the marker, and anything you added only to support them (an
   import, a variable).
2. Look for what is left: search the repository for the marker (`git grep -n agentplugged:debug`).
   Nothing may be found in the files you changed.
3. Commit the removal. Do not squash it into the fix to hide it: a probe committed and then removed
   is fine; a probe left is not.

The engine refuses to move the story to review (`debug_instrumentation_left`) while a line your
branch added carries the marker in a comment, in the last commit; the message names the files.
It reads committed work only (commit before you ask again), skips files of words (`.md`, `.txt`)
and reads nothing it cannot read: a probe without the marker, or an unreadable diff, is not seen.
Look at your own diff before you hand over.
