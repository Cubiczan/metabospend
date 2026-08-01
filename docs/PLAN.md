# 48-hour build plan

Event window: **Friday 31 July – Sunday 2 August 2026.**

What exists now (built 30 July, disclosed in the README) is the part that is
hard to get right under time pressure and cheap to verify: the governor, the money
math, the ledger invariants, and a sandbox that makes the whole loop runnable
offline. What remains is wiring it to live services and giving it a face.

## Before the clock starts

Four things gate everything else, and three of them need you, not the code:

1. **Apply on Devfolio and get accepted.** Rolling review, 3-day RSVP. The
   OpenAI credits form closed 27 July, so treat the $100 credit as lost and plan
   to use your own key.
2. **Authorize the Devfolio MCP.** It is installed at user scope already. Run
   `/mcp` in an interactive terminal and complete the browser flow — submission at
   the end of the weekend depends on it.
3. **Install and link the Prava CLI.**
   ```bash
   npm install -g @prava-sdk/cli
   prava setup --name "MetaboSpend" --platform claude-code
   ```
   Then approve the link in the browser and confirm with `prava status`.
4. **Get a Senso API key** and load the policy corpus (below). Without it, gate 4
   refuses every grounded agent's spend — which is correct behaviour, and makes for
   a poor demo.

Items 1–3 are **done**. Sandbox keys are in `.env`, the agent is linked, and the
test card has arrived (`.metabospend/sandbox-test-card.txt`).

### The transaction budget

The sandbox test card allows **30 transactions per day**, and it is unique to this
team. `npm run demo:live` spends 4 of them. That is roughly seven live runs a day —
enough, but only if it is not wasted.

Rehearse on `npm run demo` (offline, free, identical code path). Spend live runs on
things that actually need the network, and **hold several back for the recording**.
Discovering the limit mid-video on Sunday evening would cost the one artifact the
submission depends on.

## Hour 0–6 — make it real

Replace the two doubles with live clients. Nothing else changes; that is the point
of the interface.

- Swap `SandboxPrava` → `PravaClient` behind an env flag (`PRAVA_LIVE=1`), so the
  offline demo keeps working for the video.
- Create the three mandates for real, with a passkey:
  ```bash
  prava mandate create --merchant-name "Acme Supply" --merchant-url "https://acmesupply.com" \
    --merchant-country US --amount 8000.00 --currency USD --frequency one_time --scope listed -y
  ```
  Sandbox merchants are fine — use whatever Prava's test merchants allow. Verify
  with `prava mandate poll`.
- Run one real end-to-end auto-lane charge and keep the transaction id. **This is
  the single most important artifact of the weekend** — it is the difference
  between "an agent that could pay" and "an agent that paid."

## Hour 6–14 — Senso

- Load the policy corpus: a procurement policy with an explicit dollar clause, a
  vendor register, an approved-supplier list. Include at least one supplier that is
  allowlisted but *not* policy-covered, so the refusal case is demonstrable.
- Verify `SensoClient.normalize()` against the real response shape — the field
  names (`citations` / `sources`, `excerpt` / `snippet`) are guesses from the docs
  and will need one correction pass.
- Confirm the negative case: a policy clause that *prohibits* a spend must not be
  read as authorizing it just because it returned a citation.

## Hour 14–26 — the dashboard

Deliberately last, and deliberately small. Judges are assessing a working flow,
not a design system.

- Next.js 16 App Router, reading the SQLite ledger server-side.
- Three views, no more: **live spend feed** (the three lanes, colour-coded),
  **approval queue** (approve/reject → real Prava calls), **evidence packet**
  (expand a row: reason codes, citation, mandate, txn id, settlement).
- The money shot is the approval queue: click approve, a passkey prompt appears,
  and the mandate balance visibly drops.

## Hour 26–34 — OpenAI

- Agent rationales: give the Responses API the operational signal and have it
  write the human-readable justification the approver reads. Keep the *numbers*
  computed in TypeScript — an LLM must never be the thing that decides an amount.
- A natural-language policy query that turns "why was this refused?" into a plain
  answer over the evidence packet.

## Hour 34–42 — Linq (stretch, cut without regret)

The approval lane already emits a decision with a rendered summary, so routing it
to iMessage is a channel adapter, not new logic: CFO gets the PO summary as a
message, replies to approve, the charge settles. Compelling, but the core loop
must be landed and recorded first. **If Hour 34 arrives and the demo video is not
shot, skip this entirely.**

## Hour 42–48 — ship

- Record the demo (script in `DEMO_SCRIPT.md`). Show a real transaction id.
- Paste `SUBMISSION.md` into Devfolio. Do not rewrite the disclosure section — it
  is deliberately specific and that specificity is what makes it credible.
- Submit with hours to spare. Devfolio deadlines are not generous.

## The one thing not to compromise

If the weekend goes badly and a choice has to be made: **ship the auto lane with a
real, reported Prava transaction and no dashboard**, rather than a beautiful
dashboard over the sandbox. The requirement is an agent completing a transaction.
Everything else is presentation.
