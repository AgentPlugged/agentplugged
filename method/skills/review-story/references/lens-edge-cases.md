# Lens: edge cases

Your question: where does this change stop behaving? Follow each changed path from the diff alone;
what the story says comes later and has its own pass.

Try the usual edges on every input and every result: nothing there, a single item, a very large
pile, a value of the wrong kind or encoding; a call that fails, hangs or answers oddly; the same
action twice, twice at once, or stopped halfway; the first and last of a range, a date change, a
time zone, a long text, an unusual character.

Then three things that a test seldom thinks of:

- The relatives of a special case. If the change gives its own treatment to some values of a
  closed family (kinds, states, modes, switches, a bounded number), the values it does not mention
  still arrive. Write down where each of them goes now.
- Things held across a call. If the code goes back to look at what it already holds (an id, a
  position, a handle, a cursor), it does so because the world may have moved. Name what moved it,
  what that did to the held thing, and what the code does when the second look disagrees.
- The calls the change writes. In code and in tests, open the function called and put the call
  beside its signature: how many arguments, in what order, of what type, which ones optional with
  which default; then what the function gives back or raises, beside what the caller does with it.

For each case, say what the code does. Report only an outcome that is wrong or unknown; whether a
test covers it is the work of the verification lens. Answer shape: `format.md`.
