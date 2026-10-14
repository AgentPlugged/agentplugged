# What the engine accepts and refuses

The action to check, then to request: `{ "kind": "agent_create", "id", "definition": "agent"|"skill",
"title", "description", "domain", "phase", "name"?, "icon"?, "role"?, "content" }` (a skill takes only `id`,
`definition: "skill"`, `description` and `content`), or `{ "kind": "agent_edit", "id", "content" }`.
`id`: lowercase letters, digits and hyphens.

## `content` of an agent

`overview` (a sentence), `produces`, `works`, `never`, `principles` (1 to 10 lines each, `works` up to 12),
`menu` (1 to 8 items: `code` of 12 characters at most, `description`, and `prompt` **or** `skill`), and
optionally `identity`, `communication_style`, `persistent_facts` (sentences, never `file:`). One line is
plain text: no HTML, no hidden or odd characters; at most 8 000 characters in all.

## `content` of a skill

`steps` (up to 12), `outputs` and `rules` (up to 10), and optionally `references`: up to 4 files, each
`{ name, lines }` (a lowercase name, up to 20 lines); each must be named in a step as
`references/<name>.md`.

## Refused, all listed at once

- the id is taken by an agent or a skill (shipped, catalog or the creator's), or the display name is an
  agent's name;
- a field is missing; the description is over 180 characters, or is a label, not a sentence (four words
  at least, with the situation, the phase or who runs it);
- an instruction that goes round a rule: ignore, skip or disable a rule, a review, an approval or a
  validation; act without asking; force a push, skip the hooks, push to the main branch; read or send a
  secret; publish, send or pay by itself; decide in the creator's place; hide something from them. A line of
  `never` may name what it forbids;
- a menu item calls a skill that does not exist or is disabled; a step names a `references/` file that is not
  given, or a file is given and no step names it;
- the rendered body is over the ceiling (16 700 characters): move detail to `references`.

A refusal writes nothing. Fix the whole list, `check` again, then ask.
