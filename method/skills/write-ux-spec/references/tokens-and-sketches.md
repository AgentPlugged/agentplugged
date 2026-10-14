# Tokens, elements and sketches

Read this when you write the visual identity, the screen sketches or the table of elements.
`npx agentplugged docs check` reads all three; run it after each.

## Tokens: in the header, once

When the product has a brand identity (`launch/identity.md`, skill `write-brand`), its tokens are the
source: use them by name (`{color.accent}`) and do not define them again; a token given another value
here is a problem. Its fixed rules also apply to the mock-ups.

The header of `ux.md` carries a `tokens` block. Groups: `color`, `type`, `space`, `radius`,
`shadow`. Each is a map of named values; a name is letters, digits, `-` or `_`.

```yaml
tokens:
  color:
    background: { light: "#FFFFFF", dark: "#101114" }
    primary: "#0F62FE"
    on-primary: "{color.background.light}"   # an alias to another token
  type:
    body: { family: "system-ui", size: 16px, weight: 400, line: 1.5 }
  space: { "1": 4px, "2": 8px, "4": 16px }
  radius: { md: 8px }
```

- A colour is a hexadecimal value, or `light` and `dark` hexadecimal values. Nothing else
  (`blue`, `rgb(…)`) passes.
- Anywhere else in the specification a token is written `{color.primary}`; the path follows the
  block (`{type.body.size}`). `docs check` refuses a `{token}` the block does not define, and
  an alias to nothing. Sizes, colours and durations written inline where a token exists are
  an excess (see the checklist).
- Native platforms: a type role may be a phrase (`body: "platform body style"`) when the
  platform owns the real value. Say it once in Foundation.
- A specification written before this block may keep its tables of `` `color.primary` ``
  names; moving them to the header is a good update, never a condition.

## On top of a UI system the product keeps

When the creator keeps a component library or a UI system (their own, or one the product
adopts), do not specify again what it gives:

1. Foundation names it; the header says `ui_system: <name>`.
2. `tokens` holds only the difference: the brand colours, the type swaps, the radii that
   override the system's.
3. A thing the system already gives is written `{ui.button}` or `{ui.focus-ring}`: with
   `ui_system` declared these always resolve, without a token. Components then hold only
   what differs (a state, a variant, a rule of behaviour).
4. The choice of the library is Alex's. Note the preference in Foundation and stay with
   whatever the architecture decides; when it changes, update the delta.

## Elements to build: `UX-n`

The table "Elements to build" numbers what the stories must carry: each component, each state
worth a story's attention, each accessibility fix the check found. One row each (`UX-1`,
`UX-2`…), kind, description, where. Never renumber; a thing no longer wanted stays, its
description beginning `(retired)`.

Once stories exist, `docs check` and the readiness gate refuse an element no story names in
its Context or acceptance criteria. That is the way a state or a fix is not forgotten between
the specification and the build. Number what a developer would otherwise reinvent, not every
label.

## Sketches: one per screen

Under "Screen sketches" (keep that title, and "Key screens": the checks find the sections by
them, in English or as « Croquis des écrans », « Écrans clés »), one `### <screen name>` per screen of the architecture (the key
screens first). Each holds a drawing in a code block, every region marked `[1]`, `[2]`…, and
the list `1.`, `2.`… saying what each region holds and its states. The numbers match in both
places, start at 1, have no gap; two regions at least.

```
+------------------------+
| [1] date, count        |
| [2] task rows          |
|            [3] add     |
+------------------------+
```

A story of the interface takes the sketch of its screen as an acceptance criterion: "given
the screen, when it opens, then its regions 1 to 3 are those of the sketch in `ux.md`". The
sketch is not pixels: the layout order, the grouping and what each region does. Pixels and
colours are tokens or the page.
