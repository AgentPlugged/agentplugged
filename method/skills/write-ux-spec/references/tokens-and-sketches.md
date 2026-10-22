# Tokens, elements and sketches

- **Tokens**, in the header: `color`, `type`, `space`, `radius`, `shadow`; a colour is hexadecimal
  (or `light` and `dark`); elsewhere `{color.primary}`, undefined is refused. A brand identity
  (`launch/identity.md`, skill `write-brand`) is the source: use its tokens by name.
- **UI system kept:** `ui_system: <name>`; `tokens` only the difference; `{ui.button}` resolves.
- **Elements to build:** one `UX-n` row per component, state or fix a story must carry; never
  renumbered, a dropped one starts `(retired)`.
- **Sketches:** under "Screen sketches", `### <screen>`: a code-block drawing with regions `[1]`,
  `[2]`… and a list `1.`, `2.`… saying what each holds.
