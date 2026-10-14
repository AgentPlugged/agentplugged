# Pillar: security (Chloé's)

Walk the threat model (`.agentplugged/docs/threat-model.md`, when it exists) against the code: for
each entry point, who can reach it and what they can do. Read the authentication and access code,
the places where input enters, where secrets are read and where data leaves.

Look for: input used before it is checked; an access rule missing on one path of several;
credentials, keys or tokens in the code, a log, a document or the history (never copy one into
the report); data returned that the caller should not see; unsafe defaults; logs that hold
personal data.

Every finding names the asset at risk and the path to harm, in plain words; a worry without a
path is a `note`. Requirements: the security `ENF-n`.
