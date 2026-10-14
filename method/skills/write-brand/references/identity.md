# The visual identity (Stella)

Read this before writing `identity.md` and its page. The form is a board of decisions: one decision per
section, each with its reason, so nobody discusses it again. Build the form from `assets/identity-template.md`
and `assets/identity-page.html`; the look is the creator's, never another brand's.

## The six sections

1. **Symbol and logotype**: what the symbol is made of and means, the logotype and its case; then three
   variants: on a light ground, on a dark ground, and as an app icon, readable at 29 px.
2. **Palette**: a few colours (four to six), each a token `color.…` in the header and a row of the table
   with its role in a few words, where it is used **and where it never is**.
3. **Typography**: two families at most, one role each, and what never mixes.
4. **Signature object**: the one object the product is recognised by (a button, a card, a gesture) and its
   states (rest, active, done, off). A product without one says so and why.
5. **Key screens**: exactly three, each under a `###` heading, chosen **to settle the identity, not the
   journey**: a welcome, the busiest screen, the moment of value. Not the flow: that is `ux.md`.
6. **Fixed rules**: `references/rules.md`.

## The page

`.agentplugged/docs/launch/identity.html`, one file under 60 000 bytes, from `assets/identity-page.html`:
the same policy meta, one inline `<style>`, no script, no image, no `<link>`, no font file, no address.
Fonts are named with a fallback (`Georgia, serif`): nothing is loaded. Text from outside goes in as plain
text. `docs check` refuses what it does not fully understand, and applies the fixed rules to the page.

## The logo is drawn, not generated

Inline `<svg>` made of a few shapes (`rect`, `circle`, `ellipse`, `polygon`, `path`), numbers and colours
only, filled by classes (`logo-ink`, `logo-accent`) so the rules see them. The symbol has a meaning the
creator can say in a sentence (two shapes that face each other, a letter built from one curve). Show two
or three symbols side by side first; keep it simple enough to draw at 29 px.

## Tokens

The header's `tokens` use the format of `ux.md` (groups `color`, `type`, `space`, `radius`, `shadow`;
`{color.ink}` to reuse). They are defined once, here. `ux.md` uses them by name (`{color.accent}`); a
token it defines with another value is a problem. Copy the values once into the CSS of the pages.
