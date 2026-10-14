---
id: architecture-security-review
kind: note
owner: chloe
links:
  - architecture
  - prd
---

# Security review of the architecture

<!-- Guidance: act on each comment of this template, then delete it. Replace every <placeholder>.
In `links`, keep the ids the architecture and the PRD give themselves, and add the threat
model's id (`threat-model`) when it exists. Never copy a secret, a token or a personal record
into this review. -->

## What an attacker sees

<!-- The assets, the entry points, the trust boundaries and the actors, from the architecture's
units and diagram. -->

- **Assets:** <accounts, personal data, payments, secrets, availability…>
- **Entry points:** <interfaces, forms, files, webhooks, admin tools, CI…>
- **Trust boundaries:** <where data crosses into a more trusted part>
- **Actors:** <anonymous user, signed-in user, another tenant, compromised dependency…>

## Findings

<!-- One row per weakness with a concrete path to harm, most severe first. Severity: critical,
high, medium or low. Decision: the AD-n it concerns, or "missing decision". -->

| # | Severity | Decision | Path to harm | Fix recommended to Alex |
| --- | --- | --- | --- | --- |
| 1 | <severity> | <decision> | <how an attacker gets there> | <the change> |

## Notes

<!-- Worries without a path to harm, and versions still `to verify` that matter for security. -->

- <note>

## Verdict

<!-- "No blocking finding", or "Blocking findings": the ones to fix before the creator approves
the architecture. End with one sentence the creator reads on the checkpoint. -->

<verdict>
