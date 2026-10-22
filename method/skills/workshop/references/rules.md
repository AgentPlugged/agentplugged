# What the engine accepts and refuses

Check, then request: `{ "kind": "agent_create", "id", "definition": "agent"|"skill", "title",
"description", "domain", "phase", "name"?, "icon"?, "role"?, "content" }` (a skill takes only `id`,
`definition: "skill"`, `description`, `content`), or `{ "kind": "agent_edit", "id", "content" }`.
`id`: lowercase letters, digits, hyphens.

**Agent `content`**: `overview`, `produces`, `works`, `never` (one line at least), `principles`,
`menu` (1 to 8 items: `code` of 12 characters at most, `description`, and `prompt` **or** `skill`),
optionally `identity`, `communication_style`, `persistent_facts`; 8 000 characters in all.
**Skill `content`**: `steps` (up to 12), `outputs`, `rules`, optionally `references` (up to 4 files
`{ name, lines }`), each named in a step as `references/<name>.md`.

## Refused, all listed at once

- the id is taken, or the display name is an agent's; a field is missing; the description is over 180
  characters or a bare label;
- an instruction that goes round a rule: ignore, skip or disable a rule, a review, an approval or a
  validation; act without asking; force a push, skip the hooks, push to the main branch; read or
  send a secret; publish, send or pay by itself; decide in the creator's place; hide something (a
  `never` line may name what it forbids);
- a menu item calls a missing or disabled skill; a step names a `references/` file not given, or a
  file given is named by no step;
- the rendered body is over the ceiling (16 700 characters): move detail to `references`.

A refusal writes nothing.
