# Saved rooms

A room is a cast and a setting the creator can call again by name. Files of the product, readable
and editable by them: `.agentplugged/rooms/<id>.yaml` and `<id>.memory.md`. List the folder to show
what exists.

```yaml
name: Launch board
setting: Blunt board meeting; Quentin doubts everything, Maya defends the user.
members: [maya, quentin]            # agents of the team
guests:                             # optional, at most 6
  - id: guest-investor
    name: Ines
    role: seed investor
    persona: Dry, numbers first, hates vague promises.
memory: true                        # remembers its sessions (default false)
```

- **Save** on the creator's ask, or offer once at the end of a table they liked: write the file
  yourself (id: lowercase and dashes) and say its name. Ask whether it should remember.
- **Recall**: `chat.table` with `table: { room: "<id>" }` alone. The answer is the cast checked
  against the team (`absent`: gone, do not seat), the guests with their persona, the setting, and
  the latest lines of memory. Start from them as if the room had never left: the setting binds how
  the room behaves, the memory tints it (two agents who fell out start wary) without ever being
  recited.
- **Memory**: at the end, 2 to 4 short lines (how the agents stood, a turning point, what came out,
  who joined), not the exchange itself. Send them as `table.memory` with the closing; the engine writes them to the file.
  Only for a room that remembers; to forget, the creator edits or deletes the file.
- **Keep a guest**: add it to `guests` of the file (persona included), if the creator said yes.
