# Pass: removals

The change takes code away, so this pass asks what went with it. For each piece that leaves (a
move or a reformat takes nothing), say what it kept true: a check, a default, an order, a clean-up,
an error someone depended on. Then look in the new code for whoever keeps it true now. If nobody
does, and nothing in the change says it was meant to go, that is a finding.

Pull on the loose threads too: who called the removed code, which test, document or setting named
it, what can no longer be reached because of it.

Do not write again what your lenses already wrote. Coming back empty-handed is common. Put what you
find in your `verification_gaps` report: the title says what was removed, the evidence what it kept
true, the recommendation where to put it back or whom to tell. Answer shape: `format.md`.
