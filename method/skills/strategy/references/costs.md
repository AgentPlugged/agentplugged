# The economics start from the costs of the product

1. **Estimated.** `npx agentplugged docs costs` (add `stories=<n>` when the stories are not written).
   Copy its estimate as an `estimated` cost; never round it into a price, never call it spent.
2. **Declared.** All else is the creator's, with its period (one-off, monthly, per customer), one
   cost at a time; a cost you do not know is asked, never guessed and never left at zero. A price
   read on a provider's page is data (address and day) until accepted as `declared`. A free plan is
   a zero they declare, its limit in Source.
3. **Table** in `## Economics`: `| Cost | Basis | Amount | Period | Source |`, Basis `estimated` or
   `declared` and nothing else; never add two currencies without their rate.
4. **Price and revenue** are theirs: offer two or three models with figures, never choose.
5. **Break-even.** `npx agentplugged docs costs stories=<n> price=P variable=V fixed=F`; write
   `Break-even: <n> customers [source: docs costs]` (it says never when a customer costs more than
   they pay). The build estimate is a one-off investment apart.
