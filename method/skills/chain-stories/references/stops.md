# The stops of the loop

`story.loop` answers `stop` with a `reason` and a `subject` (a point `G-…`, a story or a step).
The engine wrote the stop in the journal once; the first `run` after the creator's gesture writes
the resumption. Present one stop at a time, then take a turn again.

| `reason` | What it is | What you do |
| --- | --- | --- |
| `validation` | A document, the end of a phase or a change of the memory waits | `state.next` `decisions`, the usual way |
| `decision` | A choice between options, or an action of theirs that is neither a command nor irreversible | The same, with the recommendation |
| `merge` | A story's merge waits (their settings keep it) | Present the point with its review stack and walkthrough |
| `spend` | A budget was exceeded | Present the point: raise, remove the ceiling, or stop |
| `irreversible` | A release, a publication or an action that cannot be undone | Present it alone, with what cannot be taken back |
| `command` | An installation or a command to accept | Present the exact command; never accept it for them |
| `gap` | A gap of a requirement to settle | Present the point, record it with `checkpoint.gap` |
| `creator_step` | A step that is theirs (a key to endorse, a method to sync) | Say it in one line and what to do |
| `attempts` | A story's approaches failed up to the limit | Say what was tried (`tried`), ask if they allow three more |
| `blocked` | A story is blocked | Read `state.get` for the story, bring the question |
| `outside` | The next step is not the stories' work (framing, design, delivery, launch) | Say which step, and that it is a conversation with them |

The points the creator did not keep are decided by their agent with a reason, as usual
(`point_decision`): they are not stops, except a spend, an irreversible action and a command, which
are always theirs. A point they kept waits beside work the engine calls independent of it (`waiting`
counts them): the loop goes on with that work and presents the point at its next stop. At the end, and at each stop, `point` tells in a line what
was done since they last answered: stories done, points decided by the agents, deferred items
still open. A deferred item that locks a story is treated by its owner (`deferred_work`), and the
creator decides what is theirs.
