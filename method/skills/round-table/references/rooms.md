# Saved rooms and three views
A cast and a setting recalled by name: `.agentplugged/rooms/<id>.yaml` and `<id>.memory.md`
(`name`, `setting`, `members`, up to 6 `guests` with `id`, `name`, `role`, `persona`, `memory:
true|false`). Save on their ask or offer once. Recall: `chat.table` with
`table: { room: "<id>" }` alone; `absent` members are not seated; the setting binds, the memory
tints without being recited. Memory: 2 to 4 short lines in `table.memory` with the closing, only
for a room that remembers. A guest joins a room only on their yes.

## Three views of a sensitive story
`state.next` carries `table` (`story` and three `agents`). Offer once in one line, never imposed,
and record it whatever the answer: `chat.table` with `table: { story }` alone. Without a yes, stop.
Then one view per agent, in a fresh context if you have sub-agents (story, criteria, diff summary
only): `angle: product` (keeps the promise?), `delivery` (ships and is undone safely?), `quality`
(tested, what breaks unseen?). Each gives at most five lines: a verdict (merge, change, hold) and
reasons. List the disagreements, then your advice; the merge stays the creator's decision, you merge nothing. Close as `references/closing.md` with `table.story` and `synthesis.format:
three_views`.
