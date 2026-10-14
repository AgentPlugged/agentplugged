# Pillar: quality

Is the code something the next person can change safely? Read the entry points, the largest or
most often changed modules (`git log` shows which) and the project's lint and format settings.

Look for: duplicated logic that should be one function; modules that do several jobs; names that
lie; dead or commented-out code; errors swallowed or turned into silence; configuration scattered
in the code; a rule of the architecture (`AD-n`) broken in practice.

Requirements: the maintainability `ENF-n` (readability, complexity, size limits). A limit with a
number is measured with the project's own command, never assumed.
