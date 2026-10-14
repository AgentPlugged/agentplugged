# Pillar: interface

For each screen or view of the PRD's journeys, check the four states a user meets: with data,
empty, loading and in error. Read the screen's code and the UX specification (`ux.md`).

Look for: an empty list that shows a blank page instead of what to do next; a wait with no sign
of progress, or a spinner with no end; an error with no way out, a message that blames the user or
shows a code; a form that loses what was typed on failure; text that overflows or is cut at small
sizes; an action with no confirmation where it cannot be undone, or with one where it can; wording
that differs from the glossary.

Requirements: the interface `ENF-n`. A state not built is a finding `story`; one that misleads is
`should_fix`.
