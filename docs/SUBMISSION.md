# Devfolio submission copy — MetaboSpend

Paste-ready text for the Agentic Commerce Hackathon submission form.

---

## Project name

MetaboSpend

## Tagline

> **Agents propose. Mandates authorize. Money moves.**

48 characters, inside Devfolio's **2–50** limit (not the 132 first assumed — a
longer tagline is rejected by the API, draft or publish).

It earns its place by naming the three lanes in order, so the architecture is
legible before a judge has read a word of the description. "Authorize" is doing
deliberate work: it is the mandate, not the agent, that holds the authority — which
is the one idea the whole project rests on.

Held in reserve, both within the limit, if a more literal framing is wanted:

- *Governed spend reflex for eCommerce ops agents* (46) — says the domain, loses the mechanism
- *The spend control plane for ops agents* (38) — says the category, loses the story

## The problem

Every "AI for operations" product stops at the same wall. The agent works out
that DC-3 will stock out in three days, drafts the purchase order, and then
hands a human a notification. Someone opens a supplier portal and types in a
card number. The agent did the thinking; the person did the paying.

Giving the agent a card removes the bottleneck and replaces it with a worse
problem. Now a model with a plausible hallucination has your card. The reason
finance teams have not handed spend authority to agents is not that the agents
are bad at deciding what to buy — it is that nobody could answer the question
*who authorized this, and what stopped it going further?*

## The insight

An agent's **auto-execute threshold** and a Prava **mandate cap** are the same
control expressed at two different layers.

The threshold is what *we* let an agent do without a human. The cap is what the
*card network* will actually authorize. Neither is sufficient alone: a threshold
is a line in our own config that a bug can step over, and a cap knows nothing
about whether this particular spend is sensible. A spend is safe to make
automatically only when both agree. Everything else escalates to a person, or is
refused.

That is the whole product. Once you see the two controls as one pair, the
governance layer writes itself.

## What we built

Three agents watch an eCommerce operation and propose real money movements: a
**Restock Agent** that issues supplier POs before a stockout, a **Renewal Agent**
that renews the tools earning their keep and drops idle seats, and a
**Budget Agent** that tops up converting ad channels before they run dry.

Every proposal passes through a spend governor — a single pure function with six
gates, in deliberate deny-first order:

1. Is the money well-formed, and does the total equal the sum of the agent's own
   line items?
2. Are the policy cap and the proposal denominated the same way?
3. Is the merchant on this agent's allowlist?
4. Does verified policy actually authorize this class of spend? *(Senso)*
5. Does an active mandate have room to carry the charge? *(Prava)*
6. Is it at or below this agent's auto-execute cap?

Surviving all six lands in the **auto** lane: `prava mandate charge` runs, a
single-use Visa network token is issued, the merchant is paid, and the outcome is
reported back to the network. Failing gate 5 or 6 lands in the **approval** lane,
where a person clears it and a passkey session is minted. Failing 1–4 is
**blocked** with a machine-readable reason code and no money moves.

Every lane writes an evidence packet: agent, amount, lane, reason codes, the
policy citation that authorized it, mandate id, transaction id, settlement state.
That packet is the answer to "who authorized this."

## How Prava is used

Prava is not a checkout button bolted to the end. It is the enforcement layer the
governance model depends on.

- **Mandates are the budgets.** The owner approves a scoped, capped mandate once
  with a passkey. Agents then charge within it with no further prompt, because
  the setup passkey *was* the consent. Our per-agent thresholds sit deliberately
  below the mandate caps, so the network is the outer limit and our policy the
  inner one.
- **`prava mandate charge`** is the auto lane. No passkey, and correctly so.
- **`prava sessions create` / `poll`** is the approval lane, where a human's
  passkey is the consent for that single charge.
- **`prava mandate report`** closes every authorization. It runs in a `finally`,
  so a merchant-side failure still settles the network side. The sandbox asserts
  no charge is ever left unreported, and a test fails if one is.
- **`prava mandate list`** is the source of truth for what is authorized. We
  never trust our own bookkeeping over the network's answer; if the list cannot be
  read, the account is treated as having no mandates, which escalates to a person.

## How the failure modes were designed

The interesting decisions here are all about what happens when something is
unclear, because that is where a spend governor either holds or quietly leaks:

- A mandate whose `remaining` we cannot parse is read as **zero**, never as
  unlimited.
- A mandate whose expiry we cannot parse is read as **expired**, never as live.
- A Senso outage resolves to **not grounded**, so an outage makes the system stop
  spending rather than start spending blind.
- An agent proposing a total unrelated to its own line items is **refused**, not
  escalated — it is the most dangerous failure mode available to an LLM agent, and
  it is the very first gate.
- A retried proposal is a **no-op**: the ledger row is the idempotency key, so a
  replay cannot become a second charge. (This one was a live bug, caught by the
  idempotency test, and the fix is why `recordDecision` reports whether it
  inserted.)
- A hostname allowlist matches subdomains but not lookalike suffixes, so
  `evil-acmesupply.com` is refused while `shop.acmesupply.com` passes.

## Tracks

Track UUIDs for `tracksToApplyTo`, pulled from the Devfolio API — these are track
ids, not prize ids:

| Track | UUID |
|---|---|
| Winners & Finalists | `696bdaf5087f4f259c882340388b1c0d` |
| Best Visa Intelligent Commerce Implementation | `96c037259ac94bfc959eb6df35b988b9` |
| Agent Commerce Discovery & Trust (Senso) | `cd19de69b7e04f2a9a3a642c76c45182` |
| Most Startup-Ready Product (Localhost) | `9977811fedff40368cc67554a7570973` |
| Best Prava Adapter for NANDA Town | `890bedb727654a0a9aae0dbca1098884` |
| Best UX | `f1c2761253184dcbbba5e9bc7daf582a` |
| iMessage Agent (Linq) | `bc4bd7f4263344e6a503a199ee757b9e` |

**Visa — Best Intelligent Commerce Implementation.** Per the organizers, *"if
you're integrating Prava in your project, you'll be by default eligible for the
VIC track"* — so this is free. Our claim to it is still substantive: every charge
settles as a single-use Visa network token against a scoped, capped,
passkey-approved mandate, and reports its outcome back to the network. Cap
enforcement lives at the network layer, not only in our UI — the difference
between a spending limit and a spending suggestion.

**Senso — Agent Commerce Discovery & Trust.** The brief is to use Senso "as a
trust/discovery signal in an agentic commerce flow — helping the agent choose
which brand or merchant to engage with, based on verified sources." That is gate
4 exactly. Procurement policy, the vendor register, and approved-supplier lists
are the trust substrate; any spend we cannot cite is refused, and the citation is
stored in the evidence packet. In the demo, Northport Packaging is deliberately an
approved *merchant* with no *policy* clause — and the spend is refused, which is
the whole point of the distinction.

**Localhost — Most Startup-Ready.** $5,000 in Anthropic credits, judged on
"product readiness, customers, pitch, revenue and virality/network effects." As
ops agents get spend authority, someone has to own the control plane.

**NANDA — Best Prava Adapter.** Worth applying to, on reflection. The brief asks
for "a reliable and reusable Prava payments adapter… enabling agents to quote,
pay, verify transactions, and handle failures," judged on reliability, "security,
authorization, and failure handling," ease of reuse, and successful sandbox
transactions. That is a fair description of `PravaGateway` and its three
implementations — and the failure handling is the part we spent the most care on.
Low marginal effort given what already exists.

**Best UX — Mac Mini.** Only if the dashboard lands.

**Linq — iMessage Agent.** Still a stretch. The approval lane already emits a
decision with a rendered summary, so routing it to iMessage is a channel adapter
rather than new logic — but only if the core loop is recorded first.

## Built with

TypeScript · Node 24+ (native type stripping, `node:sqlite`) · Prava CLI + MCP ·
Senso · OpenAI · zero runtime npm dependencies

## Try it

```bash
git clone <repo> && cd metabospend
npm test    # 52 tests — money math, gate order, settlement invariants
npm run demo # full loop: 6 proposals, 3 lanes, real settlement, offline
```

The demo runs with no keys and no network against a sandbox gateway. Swap
`SandboxPrava` for `PravaClient` and `FixtureGroundingSource` for `SensoClient`
and the identical code path moves real money.

## Prior work disclosure

MetaboSpend is a new repository. It descends from
[metabocommand](https://github.com/icohangar-ops/metabocommand), a public repo of
mine that predates the event.

**Pre-existing (ideas, not code):** the "metabolic systems" framing and agent
roster; the concept of a role-scoped approval queue with per-agent dollar
thresholds; the notion of an exportable evidence packet. **Copied verbatim:** two
test-harness files (`tests/register-ts.mjs`, `tests/ts-resolve-hooks.mjs`) — build
plumbing for running TypeScript under `node --test`, no product logic.

**Built for this hackathon:** the entire spend governor, the entire Prava
integration, the Senso grounding gate, the ledger and evidence store, the three
agents' spend logic, and the insight the product rests on.

In metabocommand, an approved proposal terminated in a Postgres row and nothing
ever moved money. The honest summary: the idea of agents proposing spend is old;
every line that makes the spend actually happen under enforced limits is new.

---

## Devfolio form requirements (from the API, not guesswork)

`getProjectSubmissionGuide` returns hard validation rules. These bite at submit
time, so they are worth knowing now:

| Field | Rule | Status |
|---|---|---|
| `name` | 2–50 chars, **required** | "MetaboSpend" ✓ |
| `tagline` | 2–50 chars, **required** | see above — the 132-char version is rejected |
| `hashtags` | 1–10 technologies, **required** | typescript, nodejs, prava, visa, senso, openai, sqlite |
| `pictures` | **1–6, required — real screenshots of the running project** | **outstanding** |
| `projectFieldAnswers` | both organizer fields, **required** | drafted below |
| `links` | 0–5, include the public repo | repo URL |
| `video_url` | optional but expected | see DEMO_SCRIPT.md |

Two organizer questions are mandatory:

- **"The problem it solves"** — `073606c3992240fbbc2f02cd6a30fcf4`
  → use *The problem* + *The insight* + *What we built* above.
- **"Challenges we ran into"** — `780b2b98f0c34065bd71a90f0c8ed49d`
  → use *How the failure modes were designed*, led by the double-charge bug and
  the Prava field-name discrepancies in `PRAVA_API_NOTES.md`. Both are real
  specific bugs with real fixes, which is exactly what the question asks for.

**Screenshots are the one blocking gap.** The guide is explicit that they must be
real screenshots of the running project, not stand-ins. Minimum one. If the
dashboard does not land, screenshot the terminal — `npm run demo` output showing
the three lanes is legible and honest.

The repo must also be **public at submission time**.
