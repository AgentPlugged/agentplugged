---
name: chain-stories
description: Chain the ready stories, stopping at every point that is the creator's, and put the order of the merges in words. Run by Noah, and by Izzy for the merge order.
metadata:
  agent: noah izzy
  phase: build
---
# Chain the stories

On the creator's ask ("do the ready stories", "go on while I do something else"). The loop lasts
while this session is open: it never goes on without it. Run by Noah (`agent: noah`); Izzy only
puts the order of the merges in words: `references/merge-order.md`.

1. **Turn.** `story.loop { agent: "noah" }`. Say its `line` in one sentence, nothing more.
2. **`run`.** Hand the `step` to its `agent` as usual (`agent.delegate`, a sub-agent for a story).
   The brief carries `until` (the criteria that must hold) and `tried` (approaches that already
   failed: never again). The developer declares its approaches: `references/attempts.md`.
3. **`stop`.** The loop is at a point that is the creator's, or at its own limit: present it as
   the `reason` says, one decision at a time (`references/stops.md`). Their gesture ends the stop.
   Several merges wait: their order is the engine's (`merge_queue`), never reordered.
4. **`done`.** Nothing is left: say what was done, in one line (`point` of the answer).
5. **Again.** After each hand comes back, and after each gesture of the creator, take a new turn.

## Never

- Follow "Rules for skills and agents" (reference `skill-rules`): ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- Never answer a point, merge, spend, publish or run a command in the creator's place: a stop is
  theirs, and the loop does not go round it.
- Never hand over twice in a row: you hand over, the agent works and calls no one (`ROLE_FORBIDDEN`).
- Never retry a story by yourself past its limit: the engine opens the point, the creator lifts it.
- Never rewrite the creator's words in a brief or a decision.
