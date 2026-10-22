# The visual identity (Stella)

Read this before writing `identity.md` and its page, from `assets/identity-template.md` and
`assets/identity-page.html`. The form is a board of decisions: one per section, each with its reason.
The look is the creator's, never another brand's.

## The six sections

1. **Symbol and logotype**: what the symbol is made of and means, the logotype and its case; three
   variants: light ground, dark ground, app icon readable at 29 px.
2. **Palette**: four to six colours, each a token `color.…` in the header and a table row with its
   role, where it is used **and where it never is**.
3. **Typography**: two families at most, one role each, and what never mixes.
4. **Signature object**: the one object the product is recognised by and its states (rest, active,
   done, off); a product without one says so and why.
5. **Key screens**: exactly three, each under a `###` heading, chosen **to settle the identity, not
   the journey**: a welcome, the busiest screen, the moment of value.
6. **Fixed rules**: `references/rules.md`.

## The page

`.agentplugged/docs/launch/identity.html`, one file under 60 000 bytes: the same policy meta, one
inline `<style>`, no script, no image, no `<link>`, no font file, no address. Fonts are named with a
fallback (`Georgia, serif`); text from outside goes in as plain text. `docs check` refuses what it
does not fully understand and applies the fixed rules to the page.

## The logo is drawn, not generated

Inline `<svg>` of a few shapes (`rect`, `circle`, `ellipse`, `polygon`, `path`), numbers and colours
only, filled by classes (`logo-ink`, `logo-accent`) so the rules see them. The symbol has a meaning
the creator can say in a sentence.

## Tokens

The header's `tokens` use the format of `ux.md` (groups `color`, `type`, `space`, `radius`,
`shadow`; `{color.ink}` to reuse), defined once, here. `ux.md` uses them by name; a token it defines
with another value is a problem.
