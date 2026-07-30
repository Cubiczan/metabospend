# MetaboSpend

**The governed spend reflex for eCommerce operations agents.**

Your ops agents already know what to buy. MetaboSpend is the layer that lets them
actually buy it — and the layer that decides when they may not.

Three agents watch an eCommerce operation and propose real money movements:
a **Restock Agent** that issues supplier POs before a stockout, a **Renewal Agent**
that renews the SaaS and ad subscriptions that earn their keep and cancels the ones
that don't, and a **Budget Agent** that tops up ad accounts that are converting.
Every proposal is routed by a spend governor into one of three lanes, and the
money moves through [Prava](https://prava.space) — single-use Visa network tokens
against passkey-approved mandates, so no agent ever touches a card number.

---

## The idea

An agent's **auto-execute threshold** and a Prava **mandate cap** are the same
control expressed at two different layers. The threshold is what *we* let an agent
do without a human. The cap is what the *card network* will actually authorize.

A spend is a reflex only when both agree. Everything else escalates to a person,
or is refused outright.

```
                    ┌─────────────────────────────────────────┐
   Agent proposes   │            SPEND GOVERNOR               │
   a money movement │  (pure function — no I/O, no clock)     │
        │           │                                         │
        └──────────▶│  1. money well-formed & items sum?      │
                    │  2. policy and proposal same currency?  │
                    │  3. merchant on the allowlist?          │
                    │  4. Senso: grounded in verified policy? │
                    │  5. does a mandate cover this charge?   │
                    │  6. at or below the agent's cap?        │
                    └───────┬───────────┬───────────┬─────────┘
                            │           │           │
                        ┌───▼───┐  ┌────▼─────┐ ┌───▼─────┐
                        │ AUTO  │  │ APPROVAL │ │ BLOCKED │
                        └───┬───┘  └────┬─────┘ └───┬─────┘
                            │           │           │
              prava mandate │           │ prava     │ refused with a
              charge        │           │ sessions  │ machine-readable
              (no passkey — │           │ create    │ reason code
              setup was the │           │ (passkey) │
              consent)      │           │           │
                            ▼           ▼           ▼
                    ════════ every lane writes an evidence packet ════════
                     agent · proposal · lane · reason codes · Senso
                     citations · mandate id · txn id · settlement status
```

Gate order is deliberate and deny-first: cheap structural checks run before
expensive trust checks, and every gate that *can* refuse runs before any gate that
*can* approve. A proposal reaches `auto` only by surviving all six.

### What the gates actually stop

These are the cases the governor is built to catch, each pinned by a test:

| Situation | Lane | Why it matters |
|---|---|---|
| Agent proposes a $120 total against $60 of line items | `blocked` | An agent whose total is unrelated to its own itemization is the most dangerous failure mode here. Refused, not escalated. |
| Merchant is `evil-acmesupply.com` | `blocked` | Allowlist matches on hostname; subdomains pass, lookalike suffixes don't. |
| No citation from verified procurement policy | `blocked` | An evidence packet is only worth something if the authorization traces to a source document, not the agent's own say-so. |
| Mandate says `remaining: "unlimited"` | `approval` | An unparseable balance is read as zero, never as unlimited. |
| Mandate expiry is unparseable | `approval` | An unparseable window is read as expired, never as live. |
| $750 spend, $500 cap, mandate has $1,000 | `approval` | The network would authorize it. Our policy won't, without a person. |
| Both a merchant mandate and a generic budget could pay | `auto`, via the merchant one | Spending a broad budget when a narrow authorization exists needlessly burns the wider allowance. |

Money is integer minor units end to end. Non-two-decimal currencies (JPY, KWD)
are refused rather than silently mis-scaled — a governor that quietly multiplies a
cap by 100 is worse than one that declines the charge.

---

## Prize track alignment

| Track | How this project addresses it |
|---|---|
| **Main** — agent completes a transaction | Three agents, three real Prava payment paths: mandate charge, passkey session, recurring renewal. |
| **OpenAI** | Agent reasoning, proposal drafting, and the policy-grounding query. |
| **Visa** — Best Intelligent Commerce Implementation | Every charge settles as a single-use Visa network token against a scoped, capped, passkey-approved mandate, then reports its outcome back to the network. Cap enforcement lives at the network layer, not just in our UI. |
| **Senso** — Agent Commerce Discovery & Trust | Procurement policy, vendor terms, and approved-supplier lists are compiled into Senso as verified ground truth. Gate 4 refuses any spend it cannot cite. |
| **Localhost** — Most Startup-Ready | The B2B wedge: as ops agents get spend authority, someone has to own the control plane. |
| **Linq** — iMessage Agent | *Stretch.* The approval lane already emits an approve/reject decision with a rendered summary — routing that to iMessage means a CFO clears an $8,400 PO from their phone. Built only if the core loop lands first. |

---

## Prior work disclosure

Read this before judging. It is deliberately specific.

MetaboSpend is a **new repository** built for the Agentic Commerce Hackathon
(July 31 – August 2, 2026). It descends from
[**metabocommand**](https://github.com/icohangar-ops/metabocommand), a public
repo of mine that predates the event.

**What predates the hackathon** — from metabocommand, and reused here as ideas
rather than copied code:

- The "metabolic systems" framing for eCommerce ops agents, and the agent roster
  those three agents are drawn from.
- The concept of a role-scoped approval queue with per-agent dollar thresholds.
- The Governance Watchdog notion of an exportable evidence packet.
- Two test-harness files (`tests/register-ts.mjs`, `tests/ts-resolve-hooks.mjs`),
  copied verbatim — they are build plumbing for running TypeScript under
  `node --test`, and carry no product logic.

**What did not exist before the hackathon** — everything that makes this a
payments product:

- The spend governor (`src/lib/governor/`) — the six-gate routing engine, the
  minor-unit money layer, and the mandate-selection logic. In metabocommand an
  approved proposal terminated in a Postgres row; nothing ever moved money.
- The entire Prava integration (`src/lib/prava/`) — mandate charging, session
  minting, settlement reporting.
- The Senso grounding gate.
- The insight the product rests on: that an agent threshold and a mandate cap are
  the same control at two layers.

If any of that reads as too much prior context, the honest summary is: the idea of
agents proposing spend is old, and every line of code that makes the spend
*actually happen under enforced limits* is new.

---

## Status

Pre-event scaffold, built July 30 (disclosed above):

- [x] Spend governor — six gates, mandate selection, minor-unit money math
- [x] 23 characterization tests pinning the money math and gate order
- [x] Prava CLI client — mandate charge, session mint, settlement reporting
- [ ] Senso grounding client
- [ ] The three agents
- [ ] Ledger + evidence packet persistence (`node:sqlite`, zero deps)
- [ ] Dashboard
- [ ] End-to-end: proposal → governor → Prava sandbox charge → settled

---

## Running it

Requires Node 24+ (uses native TypeScript type stripping and `node:sqlite`).
Tested on Node 26.

```bash
npm test
```

The Prava CLI is a separate install, and you install it yourself — this project
never installs it for you and never asks for your card details or keys:

```bash
npm install -g @prava-sdk/cli
```

Then link this agent to your Prava account (`prava setup`, approve in the
browser). Set `PRAVA_BIN` to the binary's absolute path if it isn't on `PATH`.

## License

MIT.
