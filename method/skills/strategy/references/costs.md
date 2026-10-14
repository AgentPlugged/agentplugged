# The economics start from the costs of the product

A business model built on hopes breaks at the first bill. Start from what the product costs, say where each
cost comes from, and only then price it.

1. **Estimated costs.** Run `npx agentplugged docs costs`, add `stories=<n>` when the stories are not
   written yet (count them from the PRD). It prints an estimate per story and for the product (the sum of
   its stories), in US dollars, and says where it comes from: the product's own finished stories, or the
   method's reference while there are fewer than three. Copy it as it is, as an `estimated` cost. It is an
   estimate: say so, never round it into a price, never call it a cost spent.
2. **Declared costs.** Everything else is the creator's to state, each with its period (one-off, monthly,
   per customer): hosting, domain, database, email, payment fees, tools, what the product itself consumes
   per customer (an AI service, an API, storage), their own time if they count it. Ask one cost at a time.
   A cost you do not know is asked, never guessed and never left at zero. A price read on a provider's
   page is data: show it with its address and day, and it becomes `declared` once the creator accepts it.
   A free plan is a zero the creator declares, with its limit in the Source cell.
3. **The table.** In `## Economics`: `| Cost | Basis | Amount | Period | Source |`, one row per cost, the
   Basis cell `estimated` or `declared` and nothing else, the currency in each Amount. Never add two
   currencies without the rate the creator gave.
4. **Price and revenue.** The creator's, from the options of the direction; offer two or three models
   and the figures each implies, never choose the price. Write the price as declared.
5. **Break-even.** With the creator's price (P), the variable cost per customer each month (V) and the
   fixed costs each month (F): `npx agentplugged docs costs stories=<n> price=P variable=V fixed=F`. It
   prints the number of customers at which the product pays for itself, or says never when a customer
   costs more than they pay. Write the line `Break-even: <n> customers [source: docs costs]`. Say that the
   estimate of the build is a one-off investment apart from it.
6. **Say it as it is.** The words are `estimated` and `declared`, nothing else. If asked for another
   figure, say this method gives estimates and the creator's declarations.
