# The fixed rules

Read this when you write `brand_rules` in the header of `identity.md`. A rule is a decision not
discussed again; the engine keeps it wherever the identity is used.

## Where they apply

`docs check` applies them to the identity page, to every page of `ux-mockups/` and to the `.css`
files in `style_files` (relative paths). Each gap is one line naming the rule.

## The forms

Each rule has an `id` (words joined by hyphens), a `kind`, a one-line `text` (the reason goes under
« Fixed rules », every `id` there) and the fields of its kind.

| kind | fields | the engine checks |
| --- | --- | --- |
| `reserved_color` | `color` (a token), `only` (selectors) | the colour appears only on those elements, in any spelling |
| `palette_only` | `allow` (optional colours) | every colour is in the palette, alpha ignored |
| `font_role` | `family` (a token), `only` | that family is used only on those elements |
| `font_families` | `allowed` (tokens) | no family outside those (generic ones aside) |
| `radius_scale` | `allowed` (tokens or lengths) | every `border-radius` is 0 or on the scale |
| `no_gradient` | `except` (selectors) | no `*-gradient` outside the exceptions |
| `contrast` | `min` (default 4.5), `pairs` | the pairs hold the ratio; in CSS every block giving a text colour and a background does (large text: a third less) |
| `manual` | none | nothing: listed as a rule no program verifies |

Selectors are simple: `.class`, `#id` or `tag`; the engine reads the last part of a selector.

## What it cannot verify, and says

- **Meaning** (« icons are outlined », the tone of an image): write it `manual`.
- **Inherited colour**: a block with a text colour but no background has no pair; give both.
- **A colour it cannot read** (`oklch()`, `color-mix()`, a variable defined elsewhere): a gap on the
  rule, never a pass. Use hex, `rgb()`, `hsl()` or a name.
- **The cascade** is not run, and code other than `.css` is not read: say so.

If no form fits a rule, keep it `manual`.
