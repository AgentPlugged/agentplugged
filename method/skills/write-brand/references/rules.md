# The fixed rules

Read this when you write `brand_rules` in the header of `identity.md`. A rule is a decision that is not
discussed again; the engine keeps it for you, wherever the identity is used.

## Where they apply

`docs check` applies them to the identity page, to every page of `ux-mockups/`, and to the `.css` files
listed in `style_files` (relative paths of the project). Each gap is one line with the rule named:
`« accent-reserved »: #b93a0b (color.accent) on « .card »: reserved to .cta, .logo-accent`.

## The forms

Each rule has an `id` (words joined by hyphens), a `kind`, a one-line `text` (the reason is written under
« Fixed rules », every `id` there) and the fields of its kind.

| kind | fields | the engine checks |
| --- | --- | --- |
| `reserved_color` | `color` (a token), `only` (selectors) | the colour appears only on those elements, in any spelling (hex, `rgb()`, `hsl()`, a name, a variable) |
| `palette_only` | `allow` (optional colours) | every colour is in the palette, alpha ignored |
| `font_role` | `family` (a token), `only` | that family is used only on those elements |
| `font_families` | `allowed` (tokens) | no family outside those (generic ones aside) |
| `radius_scale` | `allowed` (tokens or lengths) | every `border-radius` is 0 or on the scale |
| `no_gradient` | `except` (selectors) | no `*-gradient` outside the exceptions |
| `contrast` | `min` (default 4.5), `pairs` | the pairs of tokens hold the ratio; in CSS, every block that gives a text colour and a background does (large text: a third less) |
| `manual` | none | nothing: it is listed as a rule no program verifies |

Selectors are simple: `.class`, `#id` or `tag`. The engine reads the subject of a selector (its last
part); `:not(.cta)` does not make an element a `.cta`.

## What it cannot verify, and says

- **Meaning**: « questions are in italic serif », « icons are outlined », the tone of an image. Write them
  as `manual`: they are listed as unverified, kept by the people who read.
- **Inherited colour**: a block that gives a text colour but no background (or the reverse) has no pair;
  the contrast is not computed and the file gets a warning with the count. Give both in the block.
- **A colour it cannot read** (`oklch()`, `color-mix()`, a variable defined elsewhere): a gap on the rule
  that asked, never a pass. Use hex, `rgb()`, `hsl()` or a name, and define variables in the same file.
- **The cascade**: it does not run it. Code other than `.css` (a token file, styles in components) is not
  read: say so to the creator.

Never write a rule that restates what the engine would not check as if it did; if a rule matters and no
form fits, tell the creator, and keep it `manual`.
