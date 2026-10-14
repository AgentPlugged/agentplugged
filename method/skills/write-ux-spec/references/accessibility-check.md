# Accessibility check

The floor every screen of the specification meets, based on the level AA of the Web Content
Accessibility Guidelines 2.2. A product may commit to more (in the PRD's non-functional
requirements); never to less. Check each item against every screen and component, and record the
result in the specification's "Accessibility check" section: passed, a finding (severity and
fix), or not applicable.

Severity: **blocking** — some users cannot complete a journey; **major** — they complete it with
real difficulty; **minor** — an annoyance or an inconsistency.

## Perceive

- **Text contrast.** At least 4.5:1 between text and its background; 3:1 for large text (24px
  regular, or 18.66px — 14pt — bold). Check every pair of colour tokens used together, in light
  and dark modes.
- **Non-text contrast.** At least 3:1 for icons that carry meaning, field borders, focus
  indicators and the parts of a control needed to see it.
- **Colour never alone.** An error, a status or a selection is also shown by text, an icon or a
  shape.
- **Text size and zoom.** Body text of 16px or more; the layout still works with text enlarged
  to 200% and at a width of 320px without horizontal scrolling.
- **Text spacing.** Nothing is cut off or overlaps when the user sets line height to 1.5, space
  after paragraphs to 2 times the font size, letter spacing to 0.12 and word spacing to 0.16
  times the font size.
- **Content on hover or focus.** A tooltip or popover that appears on hover or focus can be
  dismissed without moving the pointer or focus, stays while the pointer is over it, and stays
  until dismissed or no longer relevant.
- **Orientation.** Every screen works in portrait and landscape, unless one orientation is
  essential.
- **Structure.** Each page has a title that says what it is; headings name the sections in
  order; lists and tables are marked as such.
- **Images and icons.** Each one that carries meaning has a text alternative; decorative ones are
  hidden from screen readers.
- **Media.** Video has captions; audio has a transcript.

## Operate

- **Keyboard.** Every action can be done with a keyboard alone, with no trap.
- **Bypass blocks.** A way to skip repeated content (a "skip to content" link, landmarks or
  headings) on every page that repeats navigation.
- **Focus order and visibility.** The focus moves in reading order and is always visible, never
  hidden behind a sticky element.
- **Target size.** Touch and click targets of at least 24 by 24px, 44 by 44px for the main
  actions on touch screens.
- **Gestures.** Every path or multi-finger gesture and every drag has a single-tap alternative.
- **Motion.** Animations respect the "reduce motion" setting; nothing flashes more than three
  times per second.
- **Timing.** No time limit, or a way to extend or turn it off; moving content can be paused.

## Understand

- **Labels and instructions.** Every field has a visible label; required fields and formats are
  stated before input.
- **Errors.** An error says what went wrong and how to fix it, next to the field, and the input
  is kept.
- **Redundant entry.** Information the user already gave in the same process is filled in for
  them or offered to pick, not asked again (unless re-entering it is essential, as for a
  password confirmation or security).
- **Accessible authentication.** Signing in never requires a cognitive test (remembering,
  transcribing or solving something) without an alternative: password managers and pasting are
  allowed, and a passkey, a link by e-mail or another method is offered.
- **Consistency.** The same component looks and behaves the same everywhere; navigation stays in
  the same place.
- **Language.** The language of each page is declared; plain words, no unexplained jargon.
- **Undo and confirmation.** An action that deletes, pays or sends can be undone or asks for a
  confirmation first.

## Robust

- **Names, roles and states.** Each control exposes its name, role and state (selected,
  expanded, disabled) to assistive technology.
- **Status messages.** A change announced on screen (saved, error, new item) is also announced to
  screen readers without moving the focus.
