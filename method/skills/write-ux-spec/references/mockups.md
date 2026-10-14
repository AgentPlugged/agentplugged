# Mock-up pages

Read this when you draw the directions or the key screens. A page shows what the tables say;
the specification always wins over a page, and `ux.md` says so once, in "Brand and style".

## The rules of a page (checked by `docs check`)

- A file of `.agentplugged/docs/ux-mockups/`, flat, lowercase letters, digits and hyphens:
  `directions.html`, `screen-home.html`. Eight pages at most, 30 000 bytes each. Nothing else
  lives in the folder: another kind of file, or a link, is refused.
- Start from `assets/mockup-page.html` (in this skill's folder). Its head carries a policy meta
  that makes a browser load nothing; it comes before any tag of the body, after the charset and
  viewport metas at most.
- Self-contained: one inline `<style>`, no script, no image, no font, no `<link>`, no form, no
  address, no character reference (`&#…;`) in a style. A link is `#anchor` only. Icons are a
  few inline `<svg>` shapes, whose values are numbers, paths and colours.
- Plain tags: text, lists, tables, buttons, inputs, `div`/`section`, `svg`. Anything else is
  refused with its name.
- Every word comes from the conversation or the specification, never lorem. Text that comes
  from outside (a pasted brief, a product the creator admires) goes in as plain text with
  `<`, `>`, `&` written `&lt;`, `&gt;`, `&amp;`: never as markup.
- Colours, type and spacing are the tokens of the header, copied once as CSS custom properties
  in `:root` (`--color-primary`), light and dark when the product has both.

## Directions (step "Visual direction")

One page, `directions.html`, two or three directions side by side, each applied to the same
main screen. A direction is a whole look and feel, not a recoloured copy: two that differ only
by hue are one direction. They differ by density, weight of type, motion and tone. Each shows
its name and a line on its mood, its palette as chips with hex values, its type, the screen in
one awkward state (empty, error…), and dark beside light when the product has both. When only
the colours are undecided, the page may instead hold up to four palettes on one screen. Say in
the chat what the creator is looking at; do not paste the page. The creator chooses; the page
stays and is linked from "Brand and style".

## Key screens (step "Key screens")

Choose two to four screens whose layout decides how the product behaves: where the user starts,
the busiest step of the longest flow, a layer that asks for a decision. One page each,
`screen-<slug>.html`, at 1:1: one resting state plus, if it matters, one other (focus, error,
empty) in the same file. Draw from the tokens, the sketch and the microcopy. A component the
specification does not name is a question for the creator before it is drawn.

Let a sub-agent in a clean context draw each page: it answers with the path and a one-line
caption, and the HTML never enters your context. Do not read a page back to check it:
`docs check` does, and the creator opens it in a browser. A story that builds the screen cites
its page in its Context; the developer opens it for visual detail only.

## Coverage, asked once

When the pages are drawn, list the screens of the architecture: drawn, or "tables and sketch
only". Ask: "these will be built from the tables and sketches alone; does any need a visual
reference?" Draw what the creator names. A screen they choose to leave has `none` in the
"Mock-up page" cell of its row; `docs check` then only warns.

## Navigation and flows stay in text

The architecture table and a small text map under it (`Home → List → Detail`), the numbered
steps of each flow and the sketches say what a diagram would. Do not make diagram files: the
folder holds pages, and an agent can neither read nor check a drawing.

## A change after

A change of a token or of a sketch makes the pages that show it stale. Redraw the key ones or
say which are old; never let a page contradict the specification without saying so.

## A design tool of the creator's

If the creator draws elsewhere, assemble one prompt from the tokens, the sketches, the flows
and the microcopy; they run it and bring back what it gave. Look at it, take its decisions into
the tokens and sketches, and keep nothing but those in the specification.
