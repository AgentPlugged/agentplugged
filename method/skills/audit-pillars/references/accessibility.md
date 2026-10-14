# Pillar: accessibility

Read the interface code of the main journeys and the project's own accessibility checker when it
declares one (its `ENF-n` line says which command).

Look for: an action reachable by pointer only, a focus order that jumps or is lost, no visible
focus; an image or icon with no text alternative; a control without a name a screen reader can
read; a colour as the only signal; low contrast; text that does not resize; a form field with no
label; motion that cannot be turned off; an error shown by colour alone.

Requirements: the accessibility `ENF-n` (the level the PRD promises, such as WCAG AA). Verify with
the declared checker, or by reading the code against each point above and saying so: a proof of
kind `review`, never a claim of conformance you did not test.
