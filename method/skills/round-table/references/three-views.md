# Three views of a sensitive story

For a story whose merge waits and that touches something sensitive (`table` in `state.next`: `story`,
and the three `agents`: product, delivery, quality).

1. **Offer once**, one line, never imposed: « This story touches something sensitive; do you want a
   product, delivery and quality view before you decide its merge? » Record it whatever the answer:
   `chat.table` with `table: { story }` alone. Without a yes, stop there.
2. **Three views**, one per agent, in a fresh context each when you have sub-agents (the story, its
   criteria and the diff summary only), otherwise in turns:
   - product (`angle: product`): does it keep the promise to the user, is anything missing?
   - delivery (`angle: delivery`): can it ship and be undone safely (CI, migration, rollback)?
   - quality (`angle: quality`): is it tested, what could break unseen?
   Each gives at most five lines: a verdict (merge, change, hold) and its reasons.
3. **Reconcile**: list the disagreements, what each side needs to lift its reserve, then the advice.
   The merge stays the creator's decision on its open point; you merge nothing.
4. Close as `references/gestures.md`, with `table.story` and `synthesis.format: three_views`.
