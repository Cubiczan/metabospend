/**
 * End-to-end demo: three agents, six proposals, three lanes, real settlement.
 *
 * Two modes, same code path — which is the point of the `PravaGateway` interface:
 *
 *   npm run demo       offline. No keys, no network, no money. Rehearse freely.
 *   npm run demo:live  Prava's REST sandbox. Real mandates, real charges, real
 *                      transaction ids, still no real money.
 *
 * Live mode needs `PRAVA_SECRET_KEY=sk_test_…` and mandates already approved via
 * `npm run setup:mandates`. Grounding uses Senso when `SENSO_API_KEY` is set and
 * the local policy fixture otherwise.
 */
import { AGENTS, POLICIES, budgetAgent, renewalAgent, restockAgent } from "../lib/agents/index";
import { propose, settleApproved, type GovernorDeps } from "../lib/governor/execute";
import { format } from "../lib/governor/money";
import type { Mandate, SpendProposal } from "../lib/governor/types";
import type { PravaGateway } from "../lib/prava/client";
import { FileMerchantRegistry } from "../lib/prava/registry";
import { PravaRestClient } from "../lib/prava/rest";
import { SandboxPrava } from "../lib/prava/sandbox";
import { FixtureGroundingSource, SensoClient, type GroundingSource } from "../lib/senso/client";
import { Ledger } from "../lib/store/ledger";

const LIVE = process.env.PRAVA_MODE === "rest";

const NOW = new Date("2026-07-31T09:00:00Z");
const WEEK_OUT = "2026-08-07T09:00:00Z";

const ACME = { name: "Acme Supply", url: "https://acmesupply.com", country: "US" };
const NORTHPORT = { name: "Northport Packaging", url: "https://northportpackaging.com", country: "US" };
const SHIPSTATION = { name: "ShipStation", url: "https://shipstation.com", country: "US" };
const GOOGLE_ADS = { name: "Google Ads", url: "https://ads.google.com", country: "US" };
const GREY_MARKET = { name: "Discount Pallets Direct", url: "https://discount-pallets.example", country: "US" };

/** What the owner authorized with a passkey, ahead of time. */
const MANDATES: Mandate[] = [
  { id: "mdt_acme", scope: "listed", merchantUrl: "https://acmesupply.com", remaining: "8000.00", currency: "USD", validUntil: WEEK_OUT, frequency: "one_time" },
  { id: "mdt_shipstation", scope: "listed", merchantUrl: "https://shipstation.com", remaining: "400.00", currency: "USD", validUntil: WEEK_OUT, frequency: "monthly" },
  { id: "mdt_ops_budget", scope: "any", remaining: "3000.00", currency: "USD", validUntil: WEEK_OUT, frequency: "one_time", merchantUrl: null },
];

/** Published procurement policy, as Senso would return it. */
const POLICY_CORPUS = new FixtureGroundingSource([
  {
    agent: AGENTS.restock,
    merchantHost: "acmesupply.com",
    maxMinor: 1_000_000,
    source: "Procurement Policy v4 §3.2",
    excerpt: "Replenishment orders with approved suppliers may be issued by automated systems up to $10,000 per order.",
  },
  {
    agent: AGENTS.renewal,
    merchantHost: "shipstation.com",
    maxMinor: 100_000,
    source: "Vendor Register 2026 §ShipStation",
    excerpt: "ShipStation is an approved recurring vendor; monthly renewals under $1,000 require no further authorization.",
  },
  // Northport is deliberately absent: an approved *merchant* with no *policy*
  // citation, which is exactly the case gate 4 exists to catch.
]);

/**
 * Pick the payment surface. In live mode the mandates come from Prava rather than
 * from the fixtures above, so what the demo can actually charge is determined by
 * what you approved with a passkey — not by anything in this file.
 */
function buildGateway(): { prava: PravaGateway; grounding: GroundingSource; modeLabel: string } {
  if (!LIVE) {
    return {
      prava: new SandboxPrava({ mandates: MANDATES }),
      grounding: POLICY_CORPUS,
      modeLabel: "offline double · no network, no money",
    };
  }

  const client = new PravaRestClient({ registry: new FileMerchantRegistry() });
  return {
    prava: client,
    grounding: process.env.SENSO_API_KEY ? new SensoClient() : POLICY_CORPUS,
    modeLabel: client.isSandbox
      ? `Prava REST sandbox · real charges, no real money${process.env.SENSO_API_KEY ? " · Senso live" : " · policy fixture"}`
      : "Prava LIVE · REAL MONEY",
  };
}

async function main() {
  const { prava, grounding, modeLabel } = buildGateway();
  const ledger = new Ledger();
  // In live mode the clock must be real, or mandate expiry is evaluated against a
  // date that has nothing to do with when the mandate actually lapses.
  const deps: GovernorDeps = { prava, grounding, ledger, clock: LIVE ? () => new Date() : () => NOW };

  const proposals = buildProposals();
  const available = await prava.listMandates();

  console.log(`\n${"═".repeat(78)}`);
  console.log("  MetaboSpend — governed spend reflex");
  console.log(`  ${modeLabel}`);
  console.log(`  ${proposals.length} proposals from 3 agents · ${available.length} approved mandate(s)`);
  console.log("═".repeat(78));

  if (LIVE && available.length === 0) {
    console.log("\n  No active mandates. Every spend will escalate to a human, which is");
    console.log("  correct but makes for a dull demo. Run `npm run setup:mandates` and");
    console.log("  approve them with your passkey first.\n");
  }

  for (const proposal of proposals) {
    const policy = POLICIES[proposal.agent];
    const result = await propose(proposal, policy, deps);
    print(proposal, result.packet, result.credential !== null);
  }

  // The approval lane, cleared by a person.
  const queued = ledger.list({ lane: "approval" }).filter((p) => p.settlement === "awaiting_approval");
  if (queued.length > 0) {
    console.log(`\n${"─".repeat(78)}`);
    console.log(`  CFO clears the approval queue (${queued.length} item${queued.length === 1 ? "" : "s"})`);
    console.log("─".repeat(78));
    for (const packet of queued) {
      const proposal = proposals.find((p) => p.id === packet.proposalId)!;
      console.log(`\n  ▸ ${packet.agent} — ${format(packet.totalMinor, packet.currency)} to ${packet.merchantName}`);
      console.log(`    ${packet.reasonDetail}`);
      const settled = await settleApproved(proposal, deps, "sarah.chen@ops.io");
      console.log(`    approved by sarah.chen@ops.io → ${label(settled.packet.settlement)}`);
      if (settled.paymentUrl) console.log(`    passkey session: ${settled.paymentUrl}`);
      if (settled.packet.txnId) console.log(`    txn ${settled.packet.txnId}`);
    }
  }

  await summarize(ledger, prava, available);
  ledger.close();
}

function buildProposals(): SpendProposal[] {
  const proposals: SpendProposal[] = [];
  const push = (p: SpendProposal | null) => { if (p) proposals.push(p); };

  // 1. Reflex: below cap, mandate covers it, policy cites it.
  push(restockAgent({
    sku: "WGT-114", description: "Widget case", distributionCenter: "DC-3",
    unitsOnHand: 40, dailyVelocity: 12, reorderPoint: 150,
    unitCost: "6.00", moq: 100, supplier: ACME,
  }, NOW));

  // 2. Over the agent's $2,500 cap — the network would allow it, our policy won't.
  push(restockAgent({
    sku: "PLT-900", description: "Pallet, heavy duty", distributionCenter: "DC-1",
    unitsOnHand: 5, dailyVelocity: 9, reorderPoint: 60,
    unitCost: "14.00", moq: 250, supplier: ACME,
  }, NOW));

  // 3. Approved merchant, no policy citation — refused by the Senso gate.
  push(restockAgent({
    sku: "BOX-220", description: "Corrugated box, 12in", distributionCenter: "DC-2",
    unitsOnHand: 90, dailyVelocity: 20, reorderPoint: 400,
    unitCost: "0.85", moq: 500, supplier: NORTHPORT,
  }, NOW));

  // 4. Off-allowlist supplier — refused before grounding is even consulted.
  push(restockAgent({
    sku: "PLT-901", description: "Pallet, discount", distributionCenter: "DC-1",
    unitsOnHand: 2, dailyVelocity: 4, reorderPoint: 50,
    unitCost: "9.00", moq: 100, supplier: GREY_MARKET,
  }, NOW));

  // 5. Renewal that earns its keep, with two idle seats trimmed.
  push(renewalAgent({
    vendor: SHIPSTATION, plan: "Scale plan", monthlyCost: "299.00",
    renewsOn: "2026-08-03", attributedValue: "1840.00", seatsUsed: 5, seatsPaid: 7,
  }, NOW));

  // 6. Ad top-up: converting channel about to run dry, no merchant-specific
  //    mandate — draws on the generic ops budget.
  push(budgetAgent({
    channel: GOOGLE_ADS, campaign: "Brand — Search", balance: "180.00",
    dailySpend: "95.00", roas: 3.4, targetRoas: 2.0,
  }, NOW));

  return proposals;
}

const LANE_STYLE = {
  auto: { icon: "⚡", label: "AUTO" },
  approval: { icon: "⏸", label: "APPROVAL" },
  blocked: { icon: "⛔", label: "BLOCKED" },
} as const;

function print(proposal: SpendProposal, packet: ReturnType<Ledger["list"]>[number], charged: boolean) {
  const style = LANE_STYLE[packet.lane];
  console.log(`\n${style.icon}  ${style.label.padEnd(9)} ${packet.agent} — ${format(packet.totalMinor, packet.currency)} → ${packet.merchantName}`);
  console.log(`   why:      ${proposal.rationale}`);
  console.log(`   gates:    ${packet.reasonCodes.join(" → ")}`);
  console.log(`   detail:   ${packet.reasonDetail}`);
  if (packet.citations.length > 0) {
    for (const c of packet.citations) console.log(`   cited:    ${c.source} — "${c.excerpt}"`);
  } else if (packet.lane === "blocked" && packet.reasonCodes.includes("policy_not_grounded")) {
    console.log(`   cited:    (none — no published policy authorizes this)`);
  }
  console.log(`   outcome:  ${label(packet.settlement)}${charged ? ` · txn ${packet.txnId}` : ""}`);
}

function label(settlement: string): string {
  return {
    settled: "settled — money moved",
    pending: "charge in flight",
    declined: "declined by the network",
    failed: "failed",
    refused: "refused, no money moved",
    awaiting_approval: "queued for a human",
  }[settlement] ?? settlement;
}

async function summarize(ledger: Ledger, prava: PravaGateway, before: Mandate[]) {
  const all = ledger.list({ limit: 1000 });
  const counts = all.reduce<Record<string, number>>((acc, p) => {
    acc[p.settlement] = (acc[p.settlement] ?? 0) + 1;
    return acc;
  }, {});

  console.log(`\n${"═".repeat(78)}`);
  console.log("  Ledger");
  console.log("═".repeat(78));
  for (const [settlement, count] of Object.entries(counts).sort()) {
    console.log(`  ${String(count).padStart(2)} × ${label(settlement)}`);
  }
  for (const total of ledger.settledTotals()) {
    console.log(`\n  Settled: ${format(total.totalMinor, total.currency)} across ${total.charges} charge(s)`);
  }

  // Re-read balances from the gateway rather than trusting our own arithmetic —
  // the network is the authority on what is left.
  const after = await prava.listMandates();
  if (before.length > 0) {
    console.log("\n  Mandate balances, re-read from Prava after settlement:");
    for (const mandate of before) {
      const now = after.find((m) => m.id === mandate.id);
      const remaining = now?.remaining ?? "consumed";
      const moved = remaining !== mandate.remaining;
      console.log(`    ${mandate.id.padEnd(20)} ${mandate.remaining.padStart(9)} → ${remaining.padStart(9)}${moved ? "  ✓ drawn down" : ""}`);
    }
  }

  // The offline double can prove no authorization was left open. Against a real
  // API we cannot assert that locally, so we say so rather than imply a check.
  if (prava instanceof SandboxPrava) {
    const unreported = prava.unreportedCharges();
    console.log(`\n  Unsettled network authorizations: ${unreported.length === 0 ? "none ✓" : unreported.join(", ")}`);
  } else {
    const txns = all.filter((p) => p.txnId).map((p) => p.txnId);
    console.log(`\n  Transaction ids: ${txns.length > 0 ? txns.join(", ") : "none"}`);
    console.log("  (Settlement reported for each; verify at dashboard.prava.space.)");
  }
  console.log(`${"═".repeat(78)}\n`);
}

await main();
