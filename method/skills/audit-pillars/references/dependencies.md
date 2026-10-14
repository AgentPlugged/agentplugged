# Pillar: dependencies and licences (Chloé's)

Read the project's manifests and lock files (whatever its ecosystem has: they sit at the top of the
repository and in each package), nothing else.

Look for: dependencies abandoned or without a recent release; known vulnerabilities, with the
project's own scanner when it declares one (its `ENF-n` line or its README says which command);
versions left far behind; two libraries for one job; a licence that does not fit how the product
is distributed (copyleft in a closed product, no licence at all, a licence that forbids
commercial use); a dependency added that no `AD-n` accounts for.

List the licences found, with the count of each. Requirements: the dependencies and licences
`ENF-n`. Never install anything to audit.
