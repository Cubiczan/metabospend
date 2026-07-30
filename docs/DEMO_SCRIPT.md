# Demo video script — 3 minutes

Structure: show the wall, show the insight, show money move, show what stops it.
Lead with the refusal, not the purchase — anyone can demo a purchase.

---

## 0:00–0:20 — the wall

> "This agent worked out that DC-3 stocks out in three days. It drafted the
> purchase order. And then it did what every ops agent does — it sent someone a
> notification, and a human opened a supplier portal and typed in a card number.
>
> The agent did the thinking. The person did the paying."

## 0:20–0:45 — why nobody fixed it

> "The obvious fix is to give the agent a card. Which replaces a bottleneck with a
> worse problem: now a model with a plausible hallucination has your card.
>
> Finance teams haven't handed spend authority to agents because nobody could
> answer one question — who authorized this, and what stopped it going further?"

## 0:45–1:10 — the insight

*On screen: the two-column diagram, threshold on the left, mandate cap on the right.*

> "Here's the thing we noticed. An agent's auto-execute threshold and a Prava
> mandate cap are the same control at two different layers.
>
> The threshold is what *we* let the agent do without a human. The cap is what the
> *card network* will actually authorize. A threshold alone is a line in our own
> config that a bug can step over. A cap alone knows nothing about whether this
> spend makes sense.
>
> A spend is safe to make automatically only when both agree."

## 1:10–1:50 — money moves

*Run `npm run demo`, or the dashboard if it's built.*

> "Restock Agent proposes $2,160 to Acme Supply. Six gates: the total matches its
> own line items, the currency lines up, Acme is on the allowlist, procurement
> policy section 3.2 authorizes it — cited, from Senso — a mandate has room, and
> $2,160 is under this agent's $2,500 cap.
>
> All six clear, so it's a reflex. `prava mandate charge`. Single-use Visa network
> token. Merchant paid, outcome reported back to the network, mandate drawn down
> from $8,000 to $5,840."

*Point at the transaction id. Hold on it for a beat.*

> "That's a real transaction id. No human touched it."

## 1:50–2:30 — what stops it

*This is the part that wins. Do not rush it.*

> "Now the same agent, three more proposals.
>
> **$3,780 to Acme.** Same supplier, same mandate, still has room — the network
> would authorize this. Our policy won't, because it's over the agent's cap. Queued
> for a human. *(Approve it — passkey prompt, balance drops.)*
>
> **$510 to Northport.** Northport is on the allowlist. But no clause in published
> procurement policy authorizes it, so Senso returns no citation, and it's refused.
> Approved merchant, unapproved spend. That distinction is the whole product.
>
> **$1,080 to Discount Pallets Direct.** Not on the allowlist. Refused before we
> even ask about policy."

## 2:30–2:50 — the failure modes

> "The design decisions that matter are all about ambiguity.
>
> A mandate balance we can't parse reads as zero, never unlimited. An expiry we
> can't parse reads as expired, never live. If Senso is down, we resolve to *not
> grounded* — an outage makes this thing stop spending, not start spending blind.
>
> And a retried proposal is a no-op. The ledger row is the idempotency key. That
> one was a live bug — our own test caught a double charge, and the fix is in the
> commit history."

## 2:50–3:00 — close

> "Every lane writes an evidence packet. Agent, amount, reason codes, the policy
> clause that authorized it, mandate, transaction, settlement state.
>
> Your agents can now spend. This is who approved it."

---

## Shot list

- [ ] `npm run demo` full output, readable at 1080p (bump terminal font size)
- [ ] A **real** Prava transaction id, on screen, not sandbox — non-negotiable
- [ ] Passkey prompt appearing on the approval lane
- [ ] Mandate balance before → after, side by side
- [ ] `npm test` — 52 passing, briefly; it's evidence the invariants are real
- [ ] The Senso citation text, legible

## Notes

- Do not show a card number, even a test one.
- Say "refused", not "blocked" — refused implies judgment, blocked implies a bug.
- If the dashboard isn't finished, shoot the terminal. A working terminal loop
  beats a half-built UI, and the narration carries it.
