---
name: improve-session
description: Show where a costly session or story spent its tokens and propose three changes at most, none applied alone. Run by Lou.
metadata:
  agent: lou
  phase: framing
---
# Improve a costly session

A session that cost more than it should is read in the engine's measures, never in the
conversation: the engine already read the AI tool's traces, so reading them again would cost the
very tokens you are asked to save. You show where they went, propose at most **three** changes,
and the creator decides each one.

Run it as Lou (`agent: lou`), in the creator's language. Tokens only: no amount of money.

- Follow "Rules for skills and agents" (reference `skill-rules`): ask once; a point the creator did not keep goes to `checkpoint.decide`; in French say « tu »; start with `memory.read`.
- **Input:** a session or a story the creator names; else the heaviest of the scope.
- **Output:** where the tokens went, with the origin of each figure, and up to three proposals.
  Nothing is written, nothing is changed.

## Steps

1. **Find it.** `npx agentplugged usage --by session` (add `--story <e-s>` or `--since <day>` for
   a scope): the ten heaviest sessions with their tokens, in short text. Take the one named, else
   the heaviest. "Nothing measured" means nothing was read: say it is unknown, never zero, and stop.
2. **Read the facts.** `npx agentplugged usage --by session --session <tool>:<id>` for the habits
   of that session, and `usage --by skill` (same scope) for where its skills stand. Read only
   that text, never `--json` (it gives every row). "Habits cannot be read" means the tool's trace
   does not say it (only Claude Code's does): say so.
3. **Show where it went.** The three heaviest rows, each with its share and its origin as the
   engine says it (named by the tool, deduced from the journal, or unknown), the share nothing
   could attribute, and any tool the report says cannot be measured, by name. Never round an
   unknown into a zero, never turn tokens into money.
4. **Propose, from the facts only.** One proposal per fact of the habits, three at most, the
   heaviest first; none when the habits are empty, and say so:
   - "skill X loaded N times": a skill loaded again and again. Ask whether to keep its text in the
     story's context, or to shorten it in the creator's own layer (the `workshop` skill, mode 3b).
   - "file X read N times": a file read over and over. Propose to state its useful part once in the story
     or in the product's memory, so it is not read again.
   - "tool X failed N times": a tool that keeps failing. Propose to fix its setting or to stop the agents
     from calling it.
   Each proposal: the fact with its count, the one file or setting to change, the change in a
   line. Never an invented saving: the count is the figure.
5. **Ask, one change at a time.** Never apply anything yourself: each change is one gesture of
   the creator, taken in the chat, then made by the route that owns it (the `workshop` skill for a skill, the
   story's developer for a story). If the creator says no, drop it.
