# The acceptance document

`.agentplugged/docs/acceptance.md`, 60 lines at most. Header: `id: acceptance`, `kind: note`,
`owner: quentin`, `links` to the PRD sections replayed (`docs check` runs on it).

```markdown
# Acceptance of <product> <commit or version>

Place: local | staging <address>. Played by Quentin on <date>. Environment: <runtime, data used>.
Previous run: <none | its findings fixed / still open>.

## Journeys
| Journey (PRD) | Proof | Result |
| --- | --- | --- |
| First order, main path | `.agentplugged/.cache/qa/J1-order.png` | pass |
| Payment refused | `.agentplugged/.cache/qa/J2-refused.png` | fail: no message |
| Offline start | none: no way to cut the network here | unknown |

## Screens against the mockups
- Cart: matches. Checkout: the total is below the button on the mockup, above it here (both images named).

## Accessibility and speed
- Keyboard path of the main journey: complete, focus visible. Contrast of the main screen: not measured (no tool).
- Main journey: 1.8 s to the first result; the PRD target is 2 s.

## Findings, heaviest first
1. <what was seen> / <where> / <why it matters to a user> / <what would settle it> / <ticket id or "none">

## Verdict
passed | passed with reservations (<each one>) | not passed (<what blocks>)
```

Rules:

- A result is `pass` only with its proof file; no tool for a check is `unknown` and the reason, never a
  guess. The count of each result comes first in your message to the creator.
- A journey is replayed on the version tested, not remembered from the story's own run.
- Figures are what was measured, with the way it was measured; a target missing from the PRD is said.
- Nothing personal, no secret, no real customer data in a proof.
