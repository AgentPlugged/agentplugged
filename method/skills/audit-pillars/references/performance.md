# Pillar: performance

Start from the numbers the product promises: the performance `ENF-n` and the budgets of the
decisions (`AD-n`). For each, find the path that carries it (the request, the screen, the job) and
read only that path.

Look for: work done in a loop that could be done once; a query or a call per item; data loaded
whole to use a part; nothing bounding a size, a page, a retry or a queue; a cache with no way out;
heavy work on the path the user waits on.

The architecture's budgets (`AD-n`, `ENF-n`) are the yardstick: name the budget each finding
exceeds or puts at risk, and the repeated-access and unbounded-load findings of `lens-adversarial.md`
are checked against them here, on the whole path.

Measure with the command the project declares for it, in the unit of its budget (`measure.run`,
else `measure.proof`: the engine compares and decides). With no declared command, say so as a finding
`story` (declare how it is measured): never invent a number.
