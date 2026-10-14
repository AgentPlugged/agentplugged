# Lens: security (the security reviewer's)

Walk your reference checklist on the diff, and say which items you checked: injection, broken
access control, authentication, unsafe handling of secrets, unchecked input, unsafe defaults,
risky dependencies and migrations, data exposure.

Each finding names the asset at risk and the path to harm, in plain words: what could happen, to
whom. A worry without a path is a note in your review note, not a finding. Never copy a secret
into a report. Read the threat model when it exists. Answer shape: `format.md` (`criterion`
may be `null`).
