# Failure modes

Go through the parts one by one and ask how each one fails, what the user then sees, and what
catches it.

1. List the parts the document relies on (components, steps of a flow, outside services,
   data).
2. For each, write how it can fail: absent, slow, wrong, duplicated, out of order, refused.
3. Check what the document says happens then. Keep the failures with no detection, no recovery or
   a silent loss. Order by the damage to the user.

Each is an objection: the failure is the `claim`, the part is the `passage`, and the test that
provokes the failure and shows the outcome is the `proof`.
