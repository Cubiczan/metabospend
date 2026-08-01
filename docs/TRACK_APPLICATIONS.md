# Track applications — paste-ready

The Devfolio API's track endpoint
(`POST /hackathons/agentic-commerce/projects/{uuid}/tracks/{trackUUID}`) returns
**500 Internal Server Error** for every track, including with a one-paragraph
payload. It is server-side, not a payload problem. Everything else on the
submission went through the API fine.

So these have to be applied by hand, at
<https://devfolio.co/projects/metabospend-d232/update> → **Tracks**.

Order below is by expected value. Visa is free — the organizers state that any
project integrating Prava is eligible by default.

---

## 1. Best Visa Intelligent Commerce Implementation

Every charge settles as a **single-use Visa network token** issued against a
scoped, capped, passkey-approved Prava mandate, and every charge reports its
outcome back to the network via `POST /v1/mandates/{id}/charges/{txnId}/report`.

What we think earns this track is *where the enforcement lives*. Our per-agent
thresholds sit deliberately **below** the mandate caps, so the card network is the
outer limit and our own policy the inner one. A bug in our config cannot exceed
what Visa authorized. That is the difference between a spending limit and a
spending suggestion.

The settlement report runs in a `finally` block, so a merchant-side failure still
closes the network-side authorization. Our sandbox double asserts that no charge
is ever left unreported, and a test fails if one is.

---

## 2. Agent Commerce Discovery & Trust (Senso)

Senso is **gate 4** of six — the trust gate, and the only one that can refuse a
spend on grounds other than arithmetic.

Procurement policy, the vendor register, and approved-supplier lists are compiled
as verified ground truth. Before any charge, we ask Senso whether published policy
authorizes *this* class of spend, at *this* amount, with *this* merchant. No
citation, no spend. The citation is then stored in the evidence packet, so the
authorization traces to a source document rather than to the agent's own say-so.

The distinction we care about: in our demo, Northport Packaging is an approved
**merchant** with no **policy clause** covering the order — and the spend is
refused. Merchant trust and spend authorization are different questions, and
conflating them is how agents buy things nobody approved.

Failure mode is deliberate: a Senso timeout or error resolves to *not grounded*,
so an outage makes the system stop spending rather than start spending blind.

---

## 3. Most Startup-Ready Product (Localhost)

**The wedge:** as ops agents get spend authority, someone has to own the control
plane. That someone is the finance team, and today they have nothing to own it
with.

**Why now:** Prava and Visa Intelligent Commerce just made agent spend technically
possible. The blocker is no longer capability, it is accountability — no CFO signs
off on an agent with a card until they can answer "who authorized this, and what
stopped it going further?" MetaboSpend is that answer.

**Why it is buildable as a product:** the governor is a pure function over
(proposal, policy, mandates, grounding, clock) with zero runtime dependencies, and
the payment surface is an interface with three implementations. It drops into an
existing agent stack without owning the agents.

**Network effect:** policy corpora and merchant allowlists compound. The longer a
team runs it, the more of their spend is safely automatable — and the harder it is
to remove.

---

## 4. Best Prava Adapter for the NANDA Town

The reusable adapter this track asks for already exists here as `PravaGateway` —
one interface with three implementations: a CLI client, a REST client against the
Prava sandbox, and an in-process double for offline testing. Swapping between them
changes nothing in the governor, ledger, or agents.

**On reliability and failure handling**, which the brief weights heavily:

- An unparseable mandate balance reads as **zero**, never unlimited. An
  unparseable expiry reads as **expired**, never live.
- A `THRESHOLD_EXCEEDED` decline is relayed as a normal outcome, not thrown; a 500
  *is* thrown, so an outage cannot masquerade as a legitimate refusal.
- Retries are idempotent at the ledger row, which is what stopped a real
  double-charge we found.
- The client refuses a live key paired with a sandbox URL and vice versa.

**On authorization:** merchant-scoped mandates are matched on hostname, never on
display name — `GET /v1/mandates` returns only `merchantName`, and a name is too
weak to authorize a payment against, so an unresolvable merchant matches nothing.

We also documented four discrepancies between Prava's docs, its starter template,
and the live API in `docs/PRAVA_API_NOTES.md` — including one where credentials are
nested a level deeper than documented, which fails silently. Any NANDA Town builder
starting from our adapter skips all four.

---

## 5. Winners & Finalists

MetaboSpend gives eCommerce ops agents the ability to actually spend — and the
governance layer that decides when they may not.

The organizing idea: **an agent's auto-execute threshold and a Prava mandate cap
are the same control at two layers** — ours and the card network's. A spend happens
automatically only when both agree; everything else escalates to a person or is
refused.

Three agents (Restock, Renewal, Budget) propose real money movements. Six deny-first
gates route each proposal into auto, approval, or blocked. Auto charges a Prava
mandate and reports settlement back to the network. Every lane writes an evidence
packet answering "who authorized this."

78 tests pin the money math, the gate order, and the settlement invariants. One of
them caught a live double-charge in our own code.

---

## Not applied to, and why

- **Best UX (Mac Mini)** — there is no UI yet. Apply only if the dashboard lands.
- **iMessage Agent (Linq)** — not built. The approval lane already emits a decision
  with a rendered summary, so it is a channel adapter rather than new logic, but it
  is a stretch goal behind the core loop and the video.

## Before publishing

Two claims above are ahead of the code, and should be true before you publish:

- **Senso** is running on the local policy fixture, not the live API. Credits are
  self-serve at docs.senso.ai; wire the real key first.
- **No live transaction id yet.** The screenshots are the offline double. Get one
  real sandbox charge and swap in a screenshot that shows a genuine `txn_` id.
